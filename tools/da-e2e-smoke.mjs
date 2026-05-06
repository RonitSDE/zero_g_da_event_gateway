#!/usr/bin/env node
/**
 * E2E smoke test for DA gateway.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:8080 INGEST_API_KEY=... node tools/da-e2e-smoke.mjs
 * Optional:
 *   EXPECT_RESULT=success|failure   (default: success)
 *   POLL_ATTEMPTS=12                (default: 12)
 *   POLL_INTERVAL_MS=3000           (default: 3000)
 */

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const INGEST_API_KEY = (process.env.INGEST_API_KEY || "").trim();
const EXPECT_RESULT = (process.env.EXPECT_RESULT || "success").trim().toLowerCase();
const POLL_ATTEMPTS = Math.max(Number(process.env.POLL_ATTEMPTS || 12), 1);
const POLL_INTERVAL_MS = Math.max(Number(process.env.POLL_INTERVAL_MS || 3000), 200);

if (!INGEST_API_KEY) {
  console.error("INGEST_API_KEY is required");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${INGEST_API_KEY}`
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ingest(eventId) {
  const payload = {
    eventId,
    game: "guess_the_ai",
    event: "da.e2e.smoke",
    ts: new Date().toISOString(),
    data: { check: true }
  };
  const res = await fetch(`${BASE_URL}/v1/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    throw new Error(`ingest failed: status=${res.status} body=${JSON.stringify(json)}`);
  }
}

async function pollStatus(eventId) {
  for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
    const res = await fetch(`${BASE_URL}/v1/da/status/${eventId}`, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`status failed: status=${res.status} body=${JSON.stringify(body)}`);
    }
    if (body?.status === "failed") return body;
    if (body?.daStatus === "CONFIRMED" || body?.daStatus === "FINALIZED") return body;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`status did not resolve after ${POLL_ATTEMPTS} polls`);
}

async function getProof(eventId) {
  const res = await fetch(`${BASE_URL}/v1/da/proof/${eventId}`, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`proof failed: status=${res.status} body=${JSON.stringify(body)}`);
  return body;
}

function assertExpected(statusBody, proofBody) {
  if (EXPECT_RESULT === "failure") {
    if (statusBody?.status !== "failed") {
      throw new Error(`expected failed status, got ${JSON.stringify(statusBody)}`);
    }
    if (!statusBody?.error) {
      throw new Error("expected error message for failure result");
    }
    return;
  }

  if (!(statusBody?.daStatus === "CONFIRMED" || statusBody?.daStatus === "FINALIZED")) {
    throw new Error(`expected CONFIRMED/FINALIZED daStatus, got ${JSON.stringify(statusBody)}`);
  }
  if (!proofBody?.storageRoot || proofBody?.epoch == null || proofBody?.quorumId == null) {
    throw new Error(`proof not materialized: ${JSON.stringify(proofBody)}`);
  }
}

async function main() {
  const eventId = `da-e2e-${Date.now()}`;
  await ingest(eventId);
  const statusBody = await pollStatus(eventId);
  const proofBody = await getProof(eventId);
  assertExpected(statusBody, proofBody);
  console.log(JSON.stringify({ success: true, eventId, status: statusBody, proof: proofBody }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
