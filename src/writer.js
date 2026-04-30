import { createHash, randomUUID } from "node:crypto";
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

async function writeViaGrpc() {
  throw new Error(
    "DA_WRITER_MODE=grpc requires project-specific proto wiring. Configure DA_WRITER_MODE=mock or http for now."
  );
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

