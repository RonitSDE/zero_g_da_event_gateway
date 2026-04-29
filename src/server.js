import express from "express";
import { config } from "./config.js";
import { enqueueEvents, queueStats, startQueueWorker } from "./queue.js";
import { initStore } from "./store.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

function isAuthorized(req) {
  if (!config.ingestApiKey) return true;
  const auth = String(req.headers?.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === config.ingestApiKey;
}

app.get("/health", (_req, res) => {
  res.json({ success: true, service: "da-event-gateway", ...queueStats() });
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

await initStore();
startQueueWorker();

app.listen(config.port, () => {
  console.log(`[da-event-gateway] listening on http://localhost:${config.port}`);
});

