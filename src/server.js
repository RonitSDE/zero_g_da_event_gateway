import express from "express";
import { config } from "./config.js";
import { enqueueEvents, queueStats, requeueEvent, startQueueWorker } from "./queue.js";
import { getEventById, getFailedEvents, initStore } from "./store.js";
import { retrieveBlobFromDa } from "./writer.js";

if (config.requireAuth && !config.ingestApiKey) {
  console.error("[da-event-gateway] REQUIRE_AUTH=true but INGEST_API_KEY is not set — refusing to start.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// ─── Logger ──────────────────────────────────────────────────────────────────
const ts = () => new Date().toISOString();

function logReq(req, extra = "") {
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?";
  const query = Object.keys(req.query || {}).length ? ` query=${JSON.stringify(req.query)}` : "";
  console.log(`[${ts()}] → ${req.method} ${req.path}${query} | ip=${ip}${extra ? " | " + extra : ""}`);
}

function logRes(req, statusCode, extra = "") {
  console.log(`[${ts()}] ← ${req.method} ${req.path} ${statusCode}${extra ? " | " + extra : ""}`);
}

function logEvents(events) {
  for (const e of events) {
    const preview = e.data ? JSON.stringify(e.data).slice(0, 120) : "{}";
    console.log(`[${ts()}]   event  game=${e.game} type=${e.event} data=${preview}`);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorized(req) {
  if (!config.ingestApiKey) return true;
  const auth = String(req.headers?.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === config.ingestApiKey;
}

// Generic health — queue stats only, no auth required
app.get("/health", async (req, res) => {
  logReq(req);
  const stats = await queueStats();
  const body = { success: true, service: "da-event-gateway", ...stats };
  logRes(req, 200, `queued=${stats.queued} active=${stats.active} failed=${stats.failed}`);
  res.json(body);
});

// DA-specific health — reveals writer mode and gRPC target
app.get("/v1/da/health", async (req, res) => {
  logReq(req);
  const stats = await queueStats();
  logRes(req, 200, `writer=${config.writerMode} target=${config.targetMode}`);
  res.json({
    success: true,
    service: "da-event-gateway",
    writerMode: config.writerMode,
    targetMode: config.targetMode,
    grpcEndpoint: config.writerMode === "grpc" ? config.writerGrpcEndpoint : null,
    grpcService: config.writerMode === "grpc" ? config.writerGrpcService : null,
    grpcMethod: config.writerMode === "grpc" ? config.writerGrpcMethod : null,
    authRequired: !!config.ingestApiKey,
    ...stats
  });
});

app.post("/v1/events", async (req, res) => {
  const payload = req.body || {};
  const events = Array.isArray(payload?.events) ? payload.events : [payload];
  logReq(req, `count=${events.length}`);
  if (!isAuthorized(req)) {
    logRes(req, 401, "unauthorized");
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  logEvents(events);
  const result = await enqueueEvents(events);
  logRes(req, 202, `accepted=${result.accepted} queued=${result.queued}`);
  return res.status(202).json({ success: true, ...result });
});

app.post("/v1/events/batch", async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  logReq(req, `count=${events.length}`);
  if (!isAuthorized(req)) {
    logRes(req, 401, "unauthorized");
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  logEvents(events);
  const result = await enqueueEvents(events);
  logRes(req, 202, `accepted=${result.accepted} queued=${result.queued}`);
  return res.status(202).json({ success: true, ...result });
});

app.get("/v1/da/status/:eventId", async (req, res) => {
  const eventId = String(req.params?.eventId || "").trim();
  logReq(req, `eventId=${eventId}`);
  if (!isAuthorized(req)) {
    logRes(req, 401, "unauthorized");
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (!eventId) {
    logRes(req, 400, "missing eventId");
    return res.status(400).json({ success: false, message: "eventId is required" });
  }
  const doc = await getEventById(eventId);
  if (!doc) {
    logRes(req, 404, `eventId=${eventId} not found`);
    return res.status(404).json({ success: false, message: "event not found" });
  }
  logRes(req, 200, `game=${doc.game} type=${doc.event} daStatus=${doc.daStatus || "pending"}`);
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

// DA proof endpoint — structured view of on-chain confirmation fields
app.get("/v1/da/proof/:eventId", async (req, res) => {
  const eventId = String(req.params?.eventId || "").trim();
  logReq(req, `eventId=${eventId}`);
  if (!isAuthorized(req)) {
    logRes(req, 401, "unauthorized");
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (!eventId) {
    logRes(req, 400, "missing eventId");
    return res.status(400).json({ success: false, message: "eventId is required" });
  }
  const doc = await getEventById(eventId);
  if (!doc) {
    logRes(req, 404, `eventId=${eventId} not found`);
    return res.status(404).json({ success: false, message: "event not found" });
  }
  const blobInfo = doc.daBlobInfo || {};
  logRes(req, 200, `game=${doc.game} type=${doc.event} daStatus=${doc.daStatus || "pending"} epoch=${blobInfo.epoch ?? "-"}`);
  return res.json({
    success: true,
    eventId: doc.eventId,
    game: doc.game,
    event: doc.event,
    daStatus: doc.daStatus || null,
    storageRoot: blobInfo.storageRoot || null,
    epoch: blobInfo.epoch ?? null,
    quorumId: blobInfo.quorumId ?? null,
    daReference: doc.daReference || null,
    daRequestId: doc.daRequestId || null,
    confirmedAt: doc.daFinalizedAt || null
  });
});

app.post("/v1/da/retrieve/:eventId", async (req, res) => {
  const eventId = String(req.params?.eventId || "").trim();
  logReq(req, `eventId=${eventId}`);
  if (!isAuthorized(req)) {
    logRes(req, 401, "unauthorized");
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (!eventId) {
    logRes(req, 400, "missing eventId");
    return res.status(400).json({ success: false, message: "eventId is required" });
  }
  const doc = await getEventById(eventId);
  if (!doc) {
    logRes(req, 404, `eventId=${eventId} not found`);
    return res.status(404).json({ success: false, message: "event not found" });
  }
  const blobInfo = doc.daBlobInfo || {};
  if (!blobInfo.storageRoot || blobInfo.epoch == null || blobInfo.quorumId == null) {
    logRes(req, 409, `daStatus=${doc.daStatus || "pending"} — blob not ready`);
    return res.status(409).json({
      success: false,
      message: "retrieval fields not available yet",
      daStatus: doc.daStatus || null
    });
  }
  try {
    console.log(`[${ts()}]   retrieve game=${doc.game} type=${doc.event} epoch=${blobInfo.epoch} quorumId=${blobInfo.quorumId}`);
    const result = await retrieveBlobFromDa({
      storageRoot: blobInfo.storageRoot,
      epoch: blobInfo.epoch,
      quorumId: blobInfo.quorumId
    });
    logRes(req, 200, `game=${doc.game} type=${doc.event} size=${result.size ?? "?"} bytes`);
    return res.json({
      success: true,
      eventId: doc.eventId,
      game: doc.game,
      event: doc.event,
      daBlobInfo: blobInfo,
      retrieved: result
    });
  } catch (error) {
    logRes(req, 502, `retrieve failed: ${error?.message || error}`);
    return res.status(502).json({
      success: false,
      message: "failed to retrieve blob",
      error: String(error?.message || error)
    });
  }
});

// Dead-letter queue — list permanently failed events
app.get("/v1/failed-events", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  const skip = Number(req.query?.skip) || 0;
  const game = req.query?.game ? String(req.query.game) : null;
  const events = await getFailedEvents({ limit, skip, game });
  return res.json({ success: true, count: events.length, events });
});

// Replay a single failed event
app.post("/v1/failed-events/:eventId/replay", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const eventId = String(req.params?.eventId || "").trim();
  if (!eventId) {
    return res.status(400).json({ success: false, message: "eventId is required" });
  }
  try {
    const result = await requeueEvent(eventId);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(400).json({ success: false, message: String(error?.message || error) });
  }
});

await initStore();
startQueueWorker();

app.listen(config.port, () => {
  console.log(`[da-event-gateway] listening on http://localhost:${config.port}`);
  console.log(`[da-event-gateway] writer=${config.writerMode} target=${config.targetMode} auth=${!!config.ingestApiKey}`);
});
