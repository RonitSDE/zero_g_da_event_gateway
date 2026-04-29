import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { deliverBatch } from "./delivery.js";
import { markBatchResult, persistIncomingEvents } from "./store.js";

const queue = [];
let flushInFlight = false;
let timer = null;

function nowIso() {
  return new Date().toISOString();
}

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

export async function enqueueEvents(rawEvents) {
  const normalized = rawEvents.map(normalizeEvent).filter(Boolean);
  if (!normalized.length) {
    return { accepted: 0, queued: queue.length };
  }
  queue.push(...normalized);
  await persistIncomingEvents(normalized);

  if (queue.length >= config.batchSize) {
    void flushQueue();
  }
  return { accepted: normalized.length, queued: queue.length };
}

async function flushQueue() {
  if (flushInFlight || queue.length === 0) return;
  flushInFlight = true;
  const batch = queue.splice(0, config.batchSize);
  try {
    const result = await deliverBatch(batch);
    await markBatchResult(batch, result);
  } catch (error) {
    const failed = {
      ok: false,
      mode: config.targetMode,
      reference: null,
      batchId: randomUUID(),
      error: String(error?.message || error)
    };
    await markBatchResult(batch, failed);
    // Requeue only if events are still fresh.
    const maxAge = config.maxEventAgeMs;
    const fresh = batch.filter((event) => Date.now() - new Date(event.ts).getTime() < maxAge);
    queue.unshift(...fresh);
  } finally {
    flushInFlight = false;
  }
}

export function queueStats() {
  return {
    queued: queue.length,
    flushInFlight,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    targetMode: config.targetMode
  };
}

export function startQueueWorker() {
  if (timer) return;
  timer = setInterval(() => {
    void flushQueue();
  }, config.flushIntervalMs);
}

