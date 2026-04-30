import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { config } from "./config.js";

const nowIso = () => new Date().toISOString();

function mockReference(events) {
  const hash = createHash("sha256").update(JSON.stringify(events)).digest("hex").slice(0, 16);
  return `mock-da-${hash}-${randomUUID().slice(0, 8)}`;
}

function parseReference(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.reference || payload.batchId || payload.id || payload.root || payload?.data?.reference || null;
}

function writerHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.writerApiKey) headers.Authorization = `Bearer ${config.writerApiKey}`;
  return headers;
}

async function writeViaHttp(events) {
  if (!config.writerUpstreamUrl) {
    throw new Error("DA_WRITER_UPSTREAM_URL is required when DA_WRITER_MODE=http");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.writerUpstreamUrl, {
      method: "POST",
      headers: writerHeaders(),
      body: JSON.stringify({ source: "da-event-gateway", createdAt: nowIso(), events }),
      signal: controller.signal
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(`DA writer upstream failed (${response.status})`);
    }
    return parseReference(payload) || mockReference(events);
  } finally {
    clearTimeout(timeout);
  }
}

async function writeViaGrpc(events) {
  if (!config.writerGrpcProtoPath || !config.writerGrpcService || !config.writerGrpcMethod) {
    throw new Error(
      "DA_WRITER_GRPC_PROTO_PATH, DA_WRITER_GRPC_SERVICE, and DA_WRITER_GRPC_METHOD are required for DA_WRITER_MODE=grpc"
    );
  }

  const protoPath = path.isAbsolute(config.writerGrpcProtoPath)
    ? config.writerGrpcProtoPath
    : path.resolve(process.cwd(), config.writerGrpcProtoPath);

  const packageDefinition = await protoLoader.load(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition);
  const ServiceCtor = config.writerGrpcService
    .split(".")
    .reduce((acc, key) => acc?.[key], loaded);

  if (!ServiceCtor) {
    throw new Error(`gRPC service not found: ${config.writerGrpcService}`);
  }

  const credentials = config.writerGrpcUseTls
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();
  const client = new ServiceCtor(config.writerGrpcEndpoint, credentials);

  const payloadRaw = Buffer.from(JSON.stringify(events));
  const payloadBase64 = payloadRaw.toString("base64");

  let extra = {};
  if (config.writerGrpcExtraJson) {
    try {
      extra = JSON.parse(config.writerGrpcExtraJson);
    } catch {
      throw new Error("Invalid DA_WRITER_GRPC_EXTRA_JSON; must be valid JSON");
    }
  }

  const request = {
    ...extra,
    [config.writerGrpcPayloadField]: payloadRaw
  };

  const response = await new Promise((resolve, reject) => {
    client[config.writerGrpcMethod](request, (error, res) => {
      if (error) return reject(error);
      return resolve(res || {});
    });
  }).finally(() => {
    client.close();
  });

  const candidate = parseReference(response);
  return candidate || `grpc-da-${createHash("sha256").update(payloadBase64).digest("hex").slice(0, 20)}`;
}

export async function submitBatchToDa(events) {
  const mode = config.writerMode;
  if (mode === "mock") {
    return { reference: mockReference(events), mode };
  }
  if (mode === "grpc") {
    const reference = await writeViaGrpc(events);
    return { reference, mode };
  }
  const reference = await writeViaHttp(events);
  return { reference, mode: "http" };
}

