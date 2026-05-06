import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { submitBatchToDa } from "./writer.js";

const nowIso = () => new Date().toISOString();

function headers() {
  const out = { "Content-Type": "application/json" };
  if (config.upstreamApiKey) out.Authorization = `Bearer ${config.upstreamApiKey}`;
  return out;
}

function mockReference(events) {
  const hash = createHash("sha256").update(JSON.stringify(events)).digest("hex").slice(0, 16);
  return `mock-da-${hash}-${randomUUID().slice(0, 8)}`;
}

function parseReference(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.reference || payload.batchId || payload.id || payload.root || payload?.data?.reference || null;
}

async function sendHttp(batch) {
  if (!config.upstreamUrl) {
    throw new Error("DA_UPSTREAM_URL is required for http mode");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ source: "da-event-gateway", createdAt: nowIso(), events: batch }),
      signal: controller.signal
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(`HTTP upstream failed (${response.status})`);
    }
    return parseReference(payload) || mockReference(batch);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendGrpc() {
  throw new Error(
    "gRPC mode requires project-specific proto wiring. Set DA_TARGET_MODE=http or mock until proto details are provided."
  );
}

export async function deliverBatch(batch) {
  const mode = config.targetMode;
  if (mode === "local") {
    const result = await submitBatchToDa(batch);
    return {
      ok: true,
      mode: `local:${result.mode}`,
      reference: result.reference,
      requestId: result.requestId ?? null,
      status: result.status ?? null,
      blobInfo: result.blobInfo ?? null,
      statusAttempts: Number(result.statusAttempts || 0),
      batchId: randomUUID()
    };
  }
  if (mode === "mock") {
    return { ok: true, mode, reference: mockReference(batch), batchId: randomUUID() };
  }
  if (mode === "grpc") {
    const reference = await sendGrpc(batch);
    return { ok: true, mode, reference, batchId: randomUUID() };
  }
  const reference = await sendHttp(batch);
  return { ok: true, mode: "http", reference, batchId: randomUUID() };
}
