import { network } from "hardhat";
import { getAddress, keccak256, encodeAbiParameters } from "viem";
import { promises as fs } from "node:fs";

// Hardcoded control (edit these before running)
const REQUEST_ID = 0n;            // <-- put a pending direct-bet request id here
const MODE: "tier" | "lose" | "cons12" | "cons15" = "tier";

type Deployment = {
  token: string;
  coordinator: string;
  randomProvider: string;
  handler: string;
  referral: string;
  jackpot: string;
  roulette: string;
};

const BPS = 10_000n;
const FIRST_TIER_OFFSET = 3;
const ONE = 10n ** 18n;

async function loadDeployment(): Promise<Deployment> {
  const p = new URL("./deployments/local.json", import.meta.url);
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as Deployment;
}

// JackpotScalingLib mirror (computeProbability)
function intSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n, z = (n + 1n) / 2n;
  while (z < x) { x = z; z = (n / z + z) / 2n; }
  return x;
}
function applyCurve(functionId: number, normalized: bigint): bigint {
  if (normalized <= 0n) return 0n;
  if (normalized >= ONE) return ONE;
  if (functionId === 0) return normalized;                                // Linear
  if (functionId === 1) return (normalized * normalized) / ONE;           // Quadratic
  if (functionId === 2) return intSqrt(normalized * ONE);                 // "Logarithmic" (sqrt)
  if (functionId === 3) return (normalized * normalized / ONE) * normalized / ONE; // Exponential (cubic)
  return normalized;
}
function computeProbBps(scaling: any, metric: bigint): number {
  const enabled = Boolean(scaling.enabled ?? scaling[0]);
  if (!enabled) return 0;
  const minBps = Number(scaling.minJackpotBps ?? scaling[1] ?? 0);
  const maxBps = Number(scaling.maxJackpotBps ?? scaling[2] ?? 0);
  if (maxBps === 0) return 0;
  const minW = BigInt(scaling.minJackpotWager ?? scaling[3] ?? 0);
  const maxW = BigInt(scaling.maxJackpotWager ?? scaling[4] ?? 0);
  const fn = Number(scaling.functionId ?? scaling[5] ?? 0);
  if (metric < minW) return 0;
  if (maxW <= minW) return 0;
  if (metric >= maxW) return maxBps;

  const span = maxW - minW;
  const pos = (metric - minW) * ONE / span;
  const scaled = applyCurve(fn, pos);
  const base = BigInt(minBps);
  const delta = BigInt(maxBps - minBps);
  return Number(base + (delta * scaled) / ONE);
}

// Build cumulative probability table (bps) for direct outcomes
async function buildDirectOutcomeTable(jackpot: any): Promise<{
  cap: bigint;
  balance: bigint;
  nextTierIndex: number;
  slices: Array<{ start: number; end: number; kind: "LOSE" | "CONSOLATION" | "TIER"; consMult: number; idx: number }>;
}> {
  const [cap, balance, state, rawOutcomes] = await Promise.all([
    jackpot.read.PROBABILITY_PRECISION() as Promise<bigint>,
    jackpot.read.getJackpotBalance() as Promise<bigint>,
    jackpot.read.getJackpotState() as Promise<any>,
    jackpot.read.getDirectBetOutcomes() as Promise<any[]>,
  ]);
  const nextTierIndex = Number(state.nextTierIndex ?? state[0] ?? 0);
  const currentTierAwardIdx = FIRST_TIER_OFFSET + nextTierIndex;
  let cumulative = 0;
  const slices: Array<{ start: number; end: number; kind: "LOSE" | "CONSOLATION" | "TIER"; consMult: number; idx: number }> = [];

  for (let i = 0; i < rawOutcomes.length; i++) {
    const entry = rawOutcomes[i];
    const sc = entry.scaling ?? entry[0];
    const awardsTier = Boolean(entry.awardsTier ?? entry[4] ?? false);
    const consMult = Number(entry.consolationMultiplier ?? entry[3] ?? 0);
    let p = computeProbBps(sc, balance);
    if (awardsTier && i !== currentTierAwardIdx) {
      p = 0; // ignore non-current tier awards (contract does the same)
    }
    if (p > 0) {
      const start = cumulative;
      const end = start + p;
      const kind: "LOSE" | "CONSOLATION" | "TIER" =
        awardsTier ? "TIER" : consMult > 0 ? "CONSOLATION" : "LOSE";
      slices.push({ start, end, kind, consMult, idx: i });
      cumulative = end;
    }
  }
  return { cap, balance, nextTierIndex, slices };
}

// Choose a roll within a slice
function pickRollIn(start: number, end: number, cap: number): bigint {
  const s = Math.max(0, Math.min(start, cap));
  const e = Math.max(0, Math.min(end, cap));
  if (e <= s) throw new Error("Zero-width slice");
  // pick midpoint for stability
  const mid = s + Math.floor((e - s) / 2);
  return BigInt(mid);
}

// Ensure the request belongs to jackpot (consumer) and is pending
async function assertDirectBetRequest(randomProvider: any, jackpotAddress: string, requestId: bigint) {
  const data = await randomProvider.read.getRequestData([requestId]) as any;
  const consumer = String(data.consumer ?? data[0]);
  if (getAddress(consumer) !== getAddress(jackpotAddress)) {
    throw new Error(`Request ${requestId.toString()} is not a jackpot direct-bet request (consumer ${consumer})`);
  }
  const status = Number(data.status ?? data[1] ?? 0); // 2 = Fulfilled, 3 = Failed
  if (status === 2 || status === 3) {
    throw new Error(`Request ${requestId.toString()} is not pending (status ${status})`);
  }
}

export async function forceDirectLose(requestId: bigint) {
  const connection = await network.connect();
  const viem = connection.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const dep = await loadDeployment();

  const coordinator = await viem.getContractAt("MockVRFCoordinatorV2Plus", getAddress(dep.coordinator));
  const jackpot = await viem.getContractAt("ProgressiveJackpot", getAddress(dep.jackpot));
  const randomProvider = await viem.getContractAt("RandomProvider", getAddress(dep.randomProvider));

  await assertDirectBetRequest(randomProvider, dep.jackpot, requestId);
  const { cap, slices } = await buildDirectOutcomeTable(jackpot);
  const lose = slices.find((s) => s.kind === "LOSE");
  if (!lose) throw new Error("No LOSE slice at current balance");

  const roll = pickRollIn(lose.start, lose.end, Number(cap));
  console.log("🎯 Forcing DirectBet → LOSE", { requestId: requestId.toString(), roll: roll.toString() });
  const hash = await coordinator.write.fulfill([getAddress(dep.randomProvider), requestId, [roll]], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash });
}

export async function forceDirectConsolation(requestId: bigint, multiplierBps: 12000 | 15000) {
  const connection = await network.connect();
  const viem = connection.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const dep = await loadDeployment();

  const coordinator = await viem.getContractAt("MockVRFCoordinatorV2Plus", getAddress(dep.coordinator));
  const jackpot = await viem.getContractAt("ProgressiveJackpot", getAddress(dep.jackpot));
  const randomProvider = await viem.getContractAt("RandomProvider", getAddress(dep.randomProvider));

  await assertDirectBetRequest(randomProvider, dep.jackpot, requestId);
  const { cap, slices } = await buildDirectOutcomeTable(jackpot);
  const s = slices.find((x) => x.kind === "CONSOLATION" && x.consMult === multiplierBps);
  if (!s) throw new Error(`No consolation slice ${multiplierBps} bps at current balance`);

  const roll = pickRollIn(s.start, s.end, Number(cap));
  console.log("🎯 Forcing DirectBet → Consolation", { requestId: requestId.toString(), multiplierBps, roll: roll.toString() });
  const hash = await coordinator.write.fulfill([getAddress(dep.randomProvider), requestId, [roll]], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash });
}

export async function forceDirectTier(requestId: bigint) {
  const connection = await network.connect();
  const viem = connection.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const dep = await loadDeployment();

  const coordinator = await viem.getContractAt("MockVRFCoordinatorV2Plus", getAddress(dep.coordinator));
  const jackpot = await viem.getContractAt("ProgressiveJackpot", getAddress(dep.jackpot));
  const randomProvider = await viem.getContractAt("RandomProvider", getAddress(dep.randomProvider));

  await assertDirectBetRequest(randomProvider, dep.jackpot, requestId);
  const { cap, nextTierIndex, slices } = await buildDirectOutcomeTable(jackpot);
  const currentIdx = FIRST_TIER_OFFSET + nextTierIndex;
  const s = slices.find((x) => x.kind === "TIER" && x.idx === currentIdx);
  if (!s) throw new Error(`Current tier slice (idx ${currentIdx}) has zero probability at current balance`);

  const roll = pickRollIn(s.start, s.end, Number(cap));
  console.log("🎯 Forcing DirectBet → Tier Award", { requestId: requestId.toString(), tierIndex: nextTierIndex, roll: roll.toString() });
  const hash = await coordinator.write.fulfill([getAddress(dep.randomProvider), requestId, [roll]], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function main() {
  if (REQUEST_ID <= 0n) throw new Error("Set REQUEST_ID to a pending direct-bet request id");
  if (MODE === "lose") {
    await forceDirectLose(REQUEST_ID);
  } else if (MODE === "cons12") {
    await forceDirectConsolation(REQUEST_ID, 12000);
  } else if (MODE === "cons15") {
    await forceDirectConsolation(REQUEST_ID, 15000);
  } else {
    await forceDirectTier(REQUEST_ID);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});




