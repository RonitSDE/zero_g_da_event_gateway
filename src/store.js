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
  await eventsCollection.createIndex({ createdAt: -1 });
  await batchesCollection.createIndex({ batchId: 1 }, { unique: true });
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
  if (eventsCollection) {
    await eventsCollection.updateMany(
      { eventId: { $in: batch.map((event) => event.eventId) } },
      {
        $set: {
          status: result.ok ? "submitted" : "failed",
          daReference: result.reference || null,
          updatedAt: new Date(),
          error: result.error || null
        }
      }
    );
  }

  if (batchesCollection) {
    await batchesCollection.insertOne({
      batchId: result.batchId,
      size: batch.length,
      status: result.ok ? "submitted" : "failed",
      reference: result.reference || null,
      error: result.error || null,
      mode: result.mode,
      createdAt: new Date(),
      events: batch
    });
  }
}
