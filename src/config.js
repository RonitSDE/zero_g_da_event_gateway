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
  targetMode: (process.env.DA_TARGET_MODE || "local").trim().toLowerCase(),
  upstreamUrl: (process.env.DA_UPSTREAM_URL || "").trim(),
  upstreamApiKey: (process.env.DA_UPSTREAM_API_KEY || "").trim(),
  grpcEndpoint: (process.env.DA_GRPC_ENDPOINT || "127.0.0.1:51001").trim(),
  grpcProtoPath: (process.env.DA_GRPC_PROTO_PATH || "").trim(),
  grpcService: (process.env.DA_GRPC_SERVICE || "").trim(),
  grpcMethod: (process.env.DA_GRPC_METHOD || "").trim(),
  writerMode: (process.env.DA_WRITER_MODE || "mock").trim().toLowerCase(),
  writerUpstreamUrl: (process.env.DA_WRITER_UPSTREAM_URL || "").trim(),
  writerApiKey: (process.env.DA_WRITER_UPSTREAM_API_KEY || "").trim(),
  writerGrpcEndpoint: (process.env.DA_WRITER_GRPC_ENDPOINT || process.env.DA_GRPC_ENDPOINT || "127.0.0.1:51001").trim(),
  writerGrpcProtoPath: (process.env.DA_WRITER_GRPC_PROTO_PATH || process.env.DA_GRPC_PROTO_PATH || "").trim(),
  writerGrpcService: (process.env.DA_WRITER_GRPC_SERVICE || process.env.DA_GRPC_SERVICE || "").trim(),
  writerGrpcMethod: (process.env.DA_WRITER_GRPC_METHOD || process.env.DA_GRPC_METHOD || "").trim(),
  writerGrpcPayloadField: (process.env.DA_WRITER_GRPC_PAYLOAD_FIELD || "data").trim(),
  writerGrpcExtraJson: (process.env.DA_WRITER_GRPC_EXTRA_JSON || "").trim(),
  writerGrpcUseTls: (process.env.DA_WRITER_GRPC_USE_TLS || "false").trim().toLowerCase() === "true",
  writerGrpcStatusMethod: (process.env.DA_WRITER_GRPC_STATUS_METHOD || "GetBlobStatus").trim(),
  writerGrpcStatusPollIntervalMs: Math.max(asInt(process.env.DA_WRITER_GRPC_STATUS_POLL_INTERVAL_MS, 2500), 200),
  writerGrpcStatusPollMaxAttempts: Math.max(asInt(process.env.DA_WRITER_GRPC_STATUS_POLL_MAX_ATTEMPTS, 12), 1),
  redisUrl: (process.env.REDIS_URL || "").trim(),
  redisKeyPrefix: (process.env.REDIS_KEY_PREFIX || "ZERO-G-DA-EVENT:").trim(),
  maxRetries: Math.max(asInt(process.env.MAX_RETRIES, 3), 1),
  retryBackoffMs: Math.max(asInt(process.env.RETRY_BACKOFF_MS, 2000), 100),
  bullConcurrency: Math.max(asInt(process.env.BULLMQ_CONCURRENCY, 10), 1),
  bullRemoveOnComplete: Math.max(asInt(process.env.BULLMQ_REMOVE_ON_COMPLETE, 1000), 1),
  bullRemoveOnFail: Math.max(asInt(process.env.BULLMQ_REMOVE_ON_FAIL, 5000), 1),
  requireAuth: (process.env.REQUIRE_AUTH || "false").trim().toLowerCase() === "true"
};