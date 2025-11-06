import { promises as fs } from "node:fs";
import { parseEther, encodeFunctionData, decodeErrorResult, encodeErrorResult } from "viem";

// Config: point to roulette and set the call params you want to debug
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const FROM = (process.env.FROM ?? "0x70997970c51812dc3a010c7d01b50e0d17dc79c8") as `0x${string}`;

// Load deployment + ABI
async function loadDeployment() {
  const p = new URL("./deployments/local.json", import.meta.url);
  return JSON.parse(await fs.readFile(p, "utf8"));
}
async function loadRouletteAbi() {
  const p = new URL("../artifacts/contracts/SingleRandomRoulette.sol/SingleRandomRoulette.json", import.meta.url);
  const j = JSON.parse(await fs.readFile(p, "utf8"));
  return j.abi as any[];
}

async function post(body: any) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

// Build a zero/empty value for any ABI param type so we can compute error selectors
function zeroOf(type: string): any {
  if (type === "address") return "0x0000000000000000000000000000000000000000";
  if (type.startsWith("uint") || type.startsWith("int")) return 0n;
  if (type === "bool") return false;
  if (type === "string") return "";
  if (type.startsWith("bytes")) return "0x";
  const arrayIdx = type.indexOf("[]");
  if (arrayIdx !== -1) {
    const base = type.slice(0, arrayIdx);
    return [];
  }
  if (type.startsWith("tuple")) {
    // minimal empty tuple: assume components will be provided by viem ABI path; here we just return []
    return [];
  }
  return 0n;
}

function guessErrorBySelector(abi: any[], selectorHex: `0x${string}`): string | undefined {
  const selector = selectorHex.slice(0, 10); // 4 bytes
  for (const item of abi) {
    if (item?.type !== "error" || !item?.name) continue;
    const inputs = Array.isArray(item.inputs) ? item.inputs : [];
    try {
      const args = inputs.map((inp: any) => zeroOf(inp.type));
      const data = encodeErrorResult({ abi: [item], errorName: item.name, args });
      if (data.slice(0, 10) === selector) {
        const sig = `${item.name}(${inputs.map((i: any) => i.type).join(",")})`;
        return sig;
      }
    } catch {
      // skip if encode fails for this guess
    }
  }
  return undefined;
}

async function main() {
  const d = await loadDeployment();
  const abi = await loadRouletteAbi();
  const to = d.roulette as `0x${string}`;

  // Adjust these to reproduce the failing call
  const data = encodeFunctionData({
    abi,
    functionName: "startSpin",
    args: [parseEther("101"), 150n, "0x0000000000000000000000000000000000000000"],
  });

  // 1) debug_traceCall
  const trace = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "debug_traceCall",
    params: [{ from: FROM, to, data }, "latest", { disableStorage: true, disableMemory: true, disableStack: false }],
  });

  let payload: `0x${string}` | undefined =
    (trace?.result?.returnValue && String(trace.result.returnValue).startsWith("0x")
      ? (trace.result.returnValue as `0x${string}`)
      : undefined) ??
    (trace?.error?.data && String(trace.error.data).startsWith("0x")
      ? (trace.error.data as `0x${string}`)
      : undefined);

  // 2) Fallback: eth_estimateGas
  if (!payload) {
    const est = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_estimateGas",
      params: [{ from: FROM, to, data }],
    });
    const hex = est?.error?.data ?? est?.error?.data?.data;
    if (typeof hex === "string" && hex.startsWith("0x")) payload = hex as `0x${string}`;
  }

  // 3) Fallback: eth_call
  if (!payload) {
    const call = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "eth_call",
      params: [{ from: FROM, to, data }, "latest"],
    });
    const hex = call?.error?.data ?? call?.error?.data?.data;
    if (typeof hex === "string" && hex.startsWith("0x")) payload = hex as `0x${string}`;
  }

  if (!payload) {
    console.error("No revert payload found in trace/estimateGas/eth_call.");
    return;
  }

  // Try full decode first
  try {
    const dec = decodeErrorResult({ abi, data: payload });
    const args = (dec.args ?? []).map((a: any) => a?.toString?.() ?? String(a)).join(", ");
    console.error(`Decoded -> ${dec.errorName}${args ? `(${args})` : ""}`);
    return;
  } catch {}

  // If only selector (e.g., 0x3ea9f910), brute-force match by building selectors from ABI errors
  if (payload.length === 10) {
    const sig = guessErrorBySelector(abi, payload as `0x${string}`);
    if (sig) {
      console.error(`Matched selector ${payload} -> ${sig} (no args payload)`);
      return;
    }
  }

  console.error("Revert payload present but could not decode:", payload);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});