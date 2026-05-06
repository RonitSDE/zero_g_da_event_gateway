import { config } from "./config.js";
import { checkGrpcReady } from "./writer.js";

async function rpcCall(rpcUrl, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.startupCheckTimeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok || payload?.error) {
      throw new Error(`rpc ${method} failed: ${payload?.error?.message || response.status}`);
    }
    return payload?.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkChainId() {
  if (!config.startupChainRpc || !config.startupExpectedChainId) return;
  const expected = String(config.startupExpectedChainId).toLowerCase().replace(/^0x/, "");
  const chainIdHex = await rpcCall(config.startupChainRpc, "eth_chainId", []);
  const actual = String(chainIdHex || "").toLowerCase().replace(/^0x/, "");
  if (!actual || actual !== expected) {
    throw new Error(`chainId mismatch expected=0x${expected} actual=${chainIdHex}`);
  }
}

async function checkEntranceCode() {
  if (!config.startupChainRpc || !config.startupEntranceContractAddr) return;
  const code = await rpcCall(config.startupChainRpc, "eth_getCode", [config.startupEntranceContractAddr, "latest"]);
  if (!code || code === "0x") {
    throw new Error(`no bytecode at DA entrance ${config.startupEntranceContractAddr}`);
  }
}

async function checkGrpcEndpoint() {
  if (config.writerMode !== "grpc") return;
  await checkGrpcReady(config.startupCheckTimeoutMs);
}

export async function runStartupChecks() {
  if (!config.startupStrict) return;
  await checkGrpcEndpoint();
  await checkChainId();
  await checkEntranceCode();
}
