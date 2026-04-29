import "dotenv/config";

const asInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: asInt(process.env.PORT, 3300),
  ingestApiKey: (process.env.INGEST_API_KEY || "").trim(),
  mongoUrl: (process.env.MONGO_URL || "").trim(),
  mongoDb: (process.env.MONGO_DB || "guesstheai").trim(),
  mongoEventsCollection: (process.env.MONGO_EVENTS_COLLECTION || "da_gateway_events").trim(),
  mongoBatchesCollection: (process.env.MONGO_BATCHES_COLLECTION || "da_gateway_batches").trim(),
  batchSize: Math.max(asInt(process.env.DA_BATCH_SIZE, 50), 1),
  flushIntervalMs: Math.max(asInt(process.env.DA_FLUSH_INTERVAL_MS, 5000), 500),
  maxEventAgeMs: Math.max(asInt(process.env.DA_EVENT_MAX_AGE_MS, 120000), 5000),
  timeoutMs: Math.max(asInt(process.env.DA_TIMEOUT_MS, 12000), 1000),
  targetMode: (process.env.DA_TARGET_MODE || "mock").trim().toLowerCase(),
  upstreamUrl: (process.env.DA_UPSTREAM_URL || "").trim(),
  upstreamApiKey: (process.env.DA_UPSTREAM_API_KEY || "").trim(),
  grpcEndpoint: (process.env.DA_GRPC_ENDPOINT || "127.0.0.1:51001").trim(),
  grpcProtoPath: (process.env.DA_GRPC_PROTO_PATH || "").trim(),
  grpcService: (process.env.DA_GRPC_SERVICE || "").trim(),
  grpcMethod: (process.env.DA_GRPC_METHOD || "").trim()
};