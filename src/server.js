import express from "express";
import { config } from "./config.js";
import { enqueueEvents, queueStats, startQueueWorker } from "./queue.js";
import { getEventById, initStore } from "./store.js";
import { retrieveBlobFromDa } from "./writer.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

function isAuthorized(req) {
  if (!config.ingestApiKey) return true;
  const auth = String(req.headers?.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === config.ingestApiKey;
}

app.get("/health", async (_req, res) => {
  const stats = await queueStats();
  res.json({ success: true, service: "da-event-gateway", ...stats });
});

app.post("/v1/events", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const payload = req.body || {};
  const events = Array.isArray(payload?.events) ? payload.events : [payload];
  const result = await enqueueEvents(events);
  return res.status(202).json({ success: true, ...result });
});

app.post("/v1/events/batch", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  const result = await enqueueEvents(events);
  return res.status(202).json({ success: true, ...result });
});

app.get("/v1/da/status/:eventId", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const eventId = String(req.params?.eventId || "").trim();
  if (!eventId) {
    return res.status(400).json({ success: false, message: "eventId is required" });
  }

  const doc = await getEventById(eventId);
  if (!doc) {
    return res.status(404).json({ success: false, message: "event not found" });
  }

  return res.json({
    success: true,
    eventId: doc.eventId,
    game: doc.game,
    event: doc.event,
    status: doc.status || null,
    daReference: doc.daReference || null,
    daRequestId: doc.daRequestId || null,
    daStatus: doc.daStatus || null,
    daBlobInfo: doc.daBlobInfo || null,
    error: doc.error || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null
  });
});

app.post("/v1/da/retrieve/:eventId", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const eventId = String(req.params?.eventId || "").trim();
  if (!eventId) {
    return res.status(400).json({ success: false, message: "eventId is required" });
  }

  const doc = await getEventById(eventId);
  if (!doc) {
    return res.status(404).json({ success: false, message: "event not found" });
  }

  const blobInfo = doc.daBlobInfo || {};
  if (!blobInfo.storageRoot || blobInfo.epoch == null || blobInfo.quorumId == null) {
    return res.status(409).json({
      success: false,
      message: "retrieval fields not available yet",
      daStatus: doc.daStatus || null
    });
  }

  try {
    const result = await retrieveBlobFromDa({
      storageRoot: blobInfo.storageRoot,
      epoch: blobInfo.epoch,
      quorumId: blobInfo.quorumId
    });
    return res.json({
      success: true,
      eventId: doc.eventId,
      game: doc.game,
      event: doc.event,
      daBlobInfo: blobInfo,
      retrieved: result
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: "failed to retrieve blob",
      error: String(error?.message || error)
    });
  }
});

await initStore();
startQueueWorker();

app.listen(config.port, () => {
  console.log(`[da-event-gateway] listening on http://localhost:${config.port}`);
});

