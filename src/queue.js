import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Queue, QueueEvents, Worker } from "bullmq";
import { config } from "./config.js";
import { deliverBatch } from "./delivery.js";
import { markBatchResult, persistIncomingEvents, getEventById, resetEventForReplay } from "./store.js";

const QUEUE_NAME = "da_events";
const nowIso = () => new Date().toISOString();

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

let redis = null;
let queue = null;
let worker = null;
let queueEvents = null;
let workerReady = false;

function normalizeEvent(input) {
  const game = String(input?.game || "").trim();
  const event = String(input?.event || "").trim();
  const data = input?.data ?? {};
  const ts = input?.ts || nowIso();
  if (!game || !event || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  return {
    eventId: input?.eventId || randomUUID(),
    game,
    event,
    ts,
    data,
    meta: typeof input?.meta === "object" && input.meta ? input.meta : {}
  };
}

function computeNextRetryAt(attemptsMade) {
  const delay = config.retryBackoffMs * Math.pow(2, Math.max(attemptsMade, 0));
  return new Date(Date.now() + delay);
}

function ensureQueueReady() {
  if (!config.redisUrl) {
    throw new Error("REDIS_URL is required for BullMQ queue mode");
  }
  if (queue && worker && queueEvents && redis) return;

  redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const queueOptions = {
    connection: redis,
    prefix: config.redisKeyPrefix
  };

  queue = new Queue(QUEUE_NAME, queueOptions);
  queueEvents = new QueueEvents(QUEUE_NAME, queueOptions);
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const batch = Array.isArray(job?.data?.events) ? job.data.events : [];
      const batchId = String(job?.data?.batchId || job.id || randomUUID());
      try {
        const result = await deliverBatch(batch);
        await markBatchResult(batch, {
          ...result,
          batchId,
          retryCount: Number(job.attemptsMade || 0),
          lastRetryAt: job.attemptsMade > 0 ? new Date() : null,
          nextRetryAt: null,
          finalStatus: "submitted",
          lastError: null
        });
        return result;
      } catch (error) {
        const retryCount = Number(job.attemptsMade || 0) + 1;
        const hasMoreRetries = retryCount < config.maxRetries;
        await markBatchResult(batch, {
          ok: false,
          mode: config.targetMode,
          reference: null,
          batchId,
          error: String(error?.message || error),
          retryCount,
          lastRetryAt: new Date(),
          nextRetryAt: hasMoreRetries ? computeNextRetryAt(job.attemptsMade || 0) : null,
          finalStatus: hasMoreRetries ? "pending" : "failed_permanent",
          lastError: String(error?.message || error)
        });
        throw error;
      }
    },
    {
      ...queueOptions,
      concurrency: config.bullConcurrency
    }
  );

  worker.on("ready", () => {
    workerReady = true;
  });
  worker.on("error", (error) => {
    console.error("[da-gateway] bull worker error:", error?.message || error);
    workerReady = false;
  });
}

export async function enqueueEvents(rawEvents) {
  ensureQueueReady();
  const normalized = rawEvents.map(normalizeEvent).filter(Boolean);
  if (!normalized.length) {
    return { accepted: 0, queued: 0 };
  }
  await persistIncomingEvents(normalized);

  const batches = chunk(normalized, config.batchSize);
  const jobs = batches.map((events) => {
    const batchId = randomUUID();
    return {
      name: "da_event_batch",
      data: { batchId, events, createdAt: nowIso() },
      opts: {
        jobId: batchId,
        attempts: config.maxRetries,
        backoff: { type: "exponential", delay: config.retryBackoffMs },
        removeOnComplete: config.bullRemoveOnComplete,
        removeOnFail: config.bullRemoveOnFail
      }
    };
  });

  await queue.addBulk(jobs);
  const counts = await queue.getJobCounts("waiting", "active", "delayed");
  return {
    accepted: normalized.length,
    queued: (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0)
  };
}

export async function queueStats() {
  if (!queue) {
    return {
      queued: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
      ready: false,
      batchSize: config.batchSize,
      targetMode: config.targetMode
    };
  }
  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
  return {
    queued: counts.waiting || 0,
    active: counts.active || 0,
    delayed: counts.delayed || 0,
    failed: counts.failed || 0,
    completed: counts.completed || 0,
    ready: workerReady,
    batchSize: config.batchSize,
    targetMode: config.targetMode
  };
}

export function startQueueWorker() {
  ensureQueueReady();
}

export async function requeueEvent(eventId) {
  const doc = await getEventById(eventId);
  if (!doc) throw new Error(`event not found: ${eventId}`);
  if (doc.finalStatus !== "failed_permanent") {
    throw new Error(`event cannot be replayed (current status: ${doc.finalStatus})`);
  }
  const reset = await resetEventForReplay(eventId);
  if (!reset) throw new Error("could not reset event for replay");
  ensureQueueReady();
  const batchId = randomUUID();
  await queue.add(
    "da_event_batch",
    {
      batchId,
      events: [{ eventId: doc.eventId, game: doc.game, event: doc.event, ts: doc.ts, data: doc.data, meta: doc.meta || {} }],
      createdAt: nowIso()
    },
    {
      jobId: `replay-${randomUUID()}`,
      attempts: config.maxRetries,
      backoff: { type: "exponential", delay: config.retryBackoffMs },
      removeOnComplete: config.bullRemoveOnComplete,
      removeOnFail: config.bullRemoveOnFail
    }
  );
  return { replayed: true, eventId };
}

