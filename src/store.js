import { MongoClient } from "mongodb";
import { config } from "./config.js";

let client = null;
let eventsCollection = null;
let batchesCollection = null;

async function connectMongo() {
  if (!config.mongoUrl) return;
  client = new MongoClient(config.mongoUrl);
  await client.connect();
  const db = client.db(config.mongoDb);
  eventsCollection = db.collection(config.mongoEventsCollection);
  batchesCollection = db.collection(config.mongoBatchesCollection);

  await eventsCollection.createIndex({ eventId: 1 }, { unique: true });
  await eventsCollection.createIndex({ game: 1, event: 1, createdAt: -1 });
  await eventsCollection.createIndex({ finalStatus: 1, updatedAt: -1 });
  await eventsCollection.createIndex({ retryCount: 1, updatedAt: -1 });
  await eventsCollection.createIndex({ daRequestId: 1 });
  await eventsCollection.createIndex({ "daBlobInfo.storageRoot": 1, "daBlobInfo.epoch": 1, "daBlobInfo.quorumId": 1 });
  await eventsCollection.createIndex({ createdAt: -1 });
  await batchesCollection.createIndex({ batchId: 1 }, { unique: true });
  await batchesCollection.createIndex({ requestId: 1 });
  await batchesCollection.createIndex({ finalStatus: 1, updatedAt: -1 });
  await batchesCollection.createIndex({ nextRetryAt: 1 });
  await batchesCollection.createIndex({ createdAt: -1 });
}

export async function initStore() {
  try {
    await connectMongo();
    if (eventsCollection) {
      console.log("[da-gateway] mongo store enabled");
    } else {
      console.log("[da-gateway] mongo store disabled (MONGO_URL not set)");
    }
  } catch (error) {
    console.error("[da-gateway] mongo init failed; running without persistence:", error.message);
    client = null;
    eventsCollection = null;
    batchesCollection = null;
  }
}

export async function persistIncomingEvents(events) {
  if (!eventsCollection || !events.length) return;
  const docs = events.map((event) => ({
    ...event,
    status: "queued",
    createdAt: new Date()
  }));
  try {
    await eventsCollection.insertMany(docs, { ordered: false });
  } catch {
    // Ignore duplicates in replays/retries.
  }
}

export async function markBatchResult(batch, result) {
  if (!batch.length) return;
  const now = new Date();
  const retryCount = Number(result.retryCount || 0);
  const status = result.ok ? "submitted" : "failed";
  const finalStatus = result.finalStatus || (result.ok ? "submitted" : "pending");
  const nextRetryAt = result.nextRetryAt ? new Date(result.nextRetryAt) : null;
  const lastRetryAt = result.lastRetryAt ? new Date(result.lastRetryAt) : null;
  const lastError = result.lastError || result.error || null;

  if (eventsCollection) {
    await eventsCollection.updateMany(
      { eventId: { $in: batch.map((event) => event.eventId) } },
      {
        $set: {
          status,
          finalStatus,
          daReference: result.reference || null,
          daRequestId: result.requestId || null,
          daStatus: result.status || null,
          daBlobInfo: result.blobInfo || null,
          daStatusPollAttempts: Number(result.statusAttempts || 0),
          updatedAt: now,
          error: result.error || null,
          daFinalizedAt: result.status === "CONFIRMED" || result.status === "FINALIZED" ? now : null,
          retryCount,
          lastRetryAt,
          nextRetryAt,
          lastError
        },
        $setOnInsert: {
          createdAt: now
        }
      }
    );
  }

  if (batchesCollection) {
    await batchesCollection.updateOne(
      { batchId: result.batchId },
      {
        $set: {
          size: batch.length,
          status,
          finalStatus,
          reference: result.reference || null,
          requestId: result.requestId || null,
          daStatus: result.status || null,
          daBlobInfo: result.blobInfo || null,
          daStatusPollAttempts: Number(result.statusAttempts || 0),
          error: result.error || null,
          lastError,
          mode: result.mode,
          retryCount,
          lastRetryAt,
          nextRetryAt,
          updatedAt: now,
          events: batch
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
  }
}

export async function getEventById(eventId) {
  if (!eventsCollection || !eventId) return null;
  return eventsCollection.findOne({ eventId: String(eventId) });
}

export async function getFailedEvents({ limit = 50, skip = 0, game } = {}) {
  if (!eventsCollection) return [];
  const filter = { finalStatus: "failed_permanent" };
  if (game) filter.game = String(game);
  return eventsCollection
    .find(filter)
    .sort({ updatedAt: -1 })
    .skip(Number(skip))
    .limit(Number(limit))
    .toArray();
}

export async function resetEventForReplay(eventId) {
  if (!eventsCollection || !eventId) return false;
  const result = await eventsCollection.updateOne(
    { eventId: String(eventId), finalStatus: "failed_permanent" },
    {
      $set: {
        status: "queued",
        finalStatus: "pending",
        retryCount: 0,
        error: null,
        lastError: null,
        nextRetryAt: null,
        updatedAt: new Date()
      }
    }
  );
  return result.modifiedCount > 0;
}
