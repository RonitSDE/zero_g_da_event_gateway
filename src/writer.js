import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { config } from "./config.js";

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toBase64(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (typeof value === "string") return Buffer.from(value).toString("base64");
  // protobuf JSON-like bytes object: { type: 'Buffer', data: [...] }
  if (typeof value === "object" && Array.isArray(value.data)) {
    return Buffer.from(value.data).toString("base64");
  }
  return null;
}

function mockReference(events) {
  const hash = createHash("sha256").update(JSON.stringify(events)).digest("hex").slice(0, 16);
  return `mock-da-${hash}-${randomUUID().slice(0, 8)}`;
}

function parseReference(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.reference || payload.batchId || payload.id || payload.root || payload?.data?.reference || null;
}

function loadGrpcClient() {
  if (!config.writerGrpcProtoPath || !config.writerGrpcService) {
    throw new Error("DA_WRITER_GRPC_PROTO_PATH and DA_WRITER_GRPC_SERVICE are required");
  }

  const protoPath = path.isAbsolute(config.writerGrpcProtoPath)
    ? config.writerGrpcProtoPath
    : path.resolve(process.cwd(), config.writerGrpcProtoPath);

  const packageDefinition = protoLoader.loadSync(protoPath, {
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
  return new ServiceCtor(config.writerGrpcEndpoint, credentials);
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

  const client = loadGrpcClient();
  try {
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
    });

    const requestIdBase64 = toBase64(response?.request_id || response?.requestId);
    const initialStatus = response?.result || response?.status || "UNKNOWN";
    const fallbackReference = `grpc-da-${createHash("sha256").update(payloadBase64).digest("hex").slice(0, 20)}`;
    const statusMethod = config.writerGrpcStatusMethod || "GetBlobStatus";

    let finalStatus = initialStatus;
    let blobInfo = null;
    let statusAttempts = 0;
    if (requestIdBase64 && typeof client[statusMethod] === "function") {
      for (let attempt = 1; attempt <= config.writerGrpcStatusPollMaxAttempts; attempt += 1) {
        statusAttempts = attempt;
        await sleep(config.writerGrpcStatusPollIntervalMs);
        const statusResponse = await new Promise((resolve, reject) => {
          client[statusMethod]({ request_id: Buffer.from(requestIdBase64, "base64") }, (error, res) => {
            if (error) return reject(error);
            return resolve(res || {});
          });
        });
        finalStatus = statusResponse?.status || finalStatus || "UNKNOWN";
        blobInfo = statusResponse?.info || blobInfo;
        if (finalStatus === "CONFIRMED" || finalStatus === "FINALIZED" || finalStatus === "FAILED") {
          break;
        }
      }
    }

    const candidate = parseReference(response);
    const header = blobInfo?.blob_header || blobInfo?.blobHeader || null;
    return {
      reference: candidate || fallbackReference,
      requestId: requestIdBase64,
      status: finalStatus || "UNKNOWN",
      statusAttempts,
      blobInfo: header
        ? {
            storageRoot: toBase64(header.storage_root || header.storageRoot),
            epoch: Number(header.epoch ?? 0),
            quorumId: Number(header.quorum_id ?? header.quorumId ?? 0)
          }
        : null
    };
  } finally {
    client.close();
  }
}

export async function retrieveBlobFromDa({ storageRoot, epoch, quorumId }) {
  if (!storageRoot) {
    throw new Error("storageRoot is required");
  }
  const method = "RetrieveBlob";
  const client = loadGrpcClient();
  try {
    if (typeof client[method] !== "function") {
      throw new Error(`gRPC method not found: ${method}`);
    }
    const response = await new Promise((resolve, reject) => {
      client[method](
        {
          storage_root: Buffer.from(storageRoot, "base64"),
          epoch: Number(epoch ?? 0),
          quorum_id: Number(quorumId ?? 0)
        },
        (error, res) => {
          if (error) return reject(error);
          return resolve(res || {});
        }
      );
    });

    return {
      dataBase64: toBase64(response?.data) || null,
      size: Buffer.isBuffer(response?.data)
        ? response.data.length
        : response?.data instanceof Uint8Array
          ? response.data.byteLength
          : null
    };
  } finally {
    client.close();
  }
}

export async function submitBatchToDa(events) {
  const mode = config.writerMode;
  if (mode === "mock") {
    return {
      reference: mockReference(events),
      mode,
      requestId: null,
      status: "MOCKED",
      statusAttempts: 0,
      blobInfo: null
    };
  }
  if (mode === "grpc") {
    const result = await writeViaGrpc(events);
    return { ...result, mode };
  }
  const reference = await writeViaHttp(events);
  return {
    reference,
    mode: "http",
    requestId: null,
    status: "SUBMITTED",
    statusAttempts: 0,
    blobInfo: null
  };
}