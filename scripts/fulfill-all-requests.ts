// scripts/fulfill-force-tier-first-roll.ts
import { network } from "hardhat";
import { getAddress, keccak256, encodeAbiParameters } from "viem";
import { promises as fs } from "node:fs";

const BPS = 10_000n;
const FIRST_TIER_OFFSET = 3n;

// REQUIRED: set REQUEST_ID (env or inline)
const REQUEST_ID = 1018n;

// Tune for very small tier slices if needed
const MAX_STEPS = 200_000;      // scan attempts per remainder
const MAX_REMAINDERS = 200;     // remainders (within base jackpot window) to try

type Deployment = {
  token: string;
  coordinator: string;
  randomProvider: string;
  handler: string;
  referral: string;
  jackpot: string;
  roulette: string;
};

async function loadDeployment(): Promise<Deployment> {
  const p = new URL("./deployments/local.json", import.meta.url);
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as Deployment;
}

// RandomDeriveLib: seed progression
function nextSeed(seed: bigint, i: number): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [seed, BigInt(i)]
  );
  return BigInt(keccak256(encoded));
}

// Derive 6 base rolls (BPS) + jackpot roll (cap) from a VRF word
function deriveRolls(rawWord: bigint, jackpotCap: bigint): bigint[] {
  const rolls: bigint[] = [];
  let s = rawWord;
  for (let i = 0; i < 6; i++) {
    rolls.push(s % BPS);
    s = nextSeed(s, i);
  }
  rolls.push(s % jackpotCap);
  return rolls;
}

// Constrained search: ensure first roll ∈ [baseStart, baseEnd), then scan k for tier slice [jpStart, jpEnd)
function findSeedConstrained(
  baseStart: bigint, baseEnd: bigint, jackpotCap: bigint,
  jpStart: bigint, jpEnd: bigint
): bigint {
  // Clamp windows
  let b0 = baseStart < 0n ? 0n : baseStart;
  let b1 = baseEnd > BPS ? BPS : baseEnd;
  if (b0 > b1) [b0, b1] = [b1, b0];
  if (b0 === b1) throw new Error("Invalid base window");

  let j0 = jpStart < 0n ? 0n : jpStart;
  let j1 = jpEnd > jackpotCap ? jackpotCap : jpEnd;
  if (j0 > j1) [j0, j1] = [j1, j0];
  if (j0 === j1) throw new Error("Invalid jackpot window");

  const baseWidth = b1 - b0;
  const remainders = baseWidth > BigInt(MAX_REMAINDERS) ? BigInt(MAX_REMAINDERS) : baseWidth;
  const startRemainder = b0 + (BigInt(Date.now() % Math.max(1, Number(baseWidth))));

  for (let rIdx = 0n; rIdx < remainders; rIdx++) {
    const r = b0 + ((startRemainder - b0 + rIdx) % baseWidth); // roll[0] = r
    console.log({r});
    for (let k = 0; k < MAX_STEPS; k++) {
        //console.log({k});
      const seed = r + BigInt(k) * BPS;
      const jr = deriveRolls(seed, jackpotCap)[6]; 
      //console.log({jr,j0,j1})            // jackpot roll
      if (jr >= j0 && jr < j1) return seed;
    }
  }
  throw new Error("Seed not found (constrained)");
}

// JackpotScalingLib mirror
const ONE = 10n ** 18n;
function intSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n, z = (n + 1n) / 2n;
  while (z < x) { x = z; z = (n / z + z) / 2n; }
  return x;
}
function applyCurve(functionId: number, normalized: bigint): bigint {
  if (normalized <= 0n) return 0n;
  if (normalized >= ONE) return ONE;
  if (functionId === 0) return normalized;                             // Linear
  if (functionId === 1) return (normalized * normalized) / ONE;        // Quadratic
  if (functionId === 2) return intSqrt(normalized * ONE);              // "Logarithmic"
  if (functionId === 3) return (normalized * normalized / ONE) * normalized / ONE; // Exponential
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

async function main() {
  if (REQUEST_ID <= 0n) throw new Error("Set REQUEST_ID env var to a pending request id.");

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const dep = await loadDeployment();
  const roulette = await viem.getContractAt("SingleRandomRoulette", getAddress(dep.roulette));
  const jackpot = await viem.getContractAt("ProgressiveJackpot", getAddress(dep.jackpot));
  const coordinator = await viem.getContractAt("MockVRFCoordinatorV2Plus", getAddress(dep.coordinator));

  // Pending spin
  const p: any = await roulette.read.pendingSpins([REQUEST_ID]);
  if (!Boolean(p.exists ?? p[10])) throw new Error(`Pending spin ${REQUEST_ID} not found`);

  const multiplierBps = BigInt(p.multiplierBps ?? p[6] ?? 0n);
  const replayBps = BigInt(p.replayBps ?? p[8] ?? 0n);
  const jackpotBps = BigInt(p.jackpotBps ?? p[7] ?? 0n);
  if (jackpotBps === 0n) throw new Error("This spin has 0 jackpot chance; start a new spin first.");

  // Ensure first roll is jackpot: base window = [mult + replay, mult + replay + jackpot)
  const baseStart = multiplierBps + replayBps;
  const baseEnd = baseStart + jackpotBps;

  // Current tier slice bounds at current balance
  const [cap, balance, state, rawOutcomes] = await Promise.all([
    jackpot.read.PROBABILITY_PRECISION() as Promise<bigint>,
    jackpot.read.getJackpotBalance() as Promise<bigint>,
    jackpot.read.getJackpotState() as Promise<any>,
    jackpot.read.getGameOutcomes([getAddress(dep.roulette)]) as Promise<any[]>,
  ]);

  const nextTierIndex = Number(state.nextTierIndex ?? state[0] ?? 0);
  const currentIdx = Number(FIRST_TIER_OFFSET + BigInt(nextTierIndex));

  // Compute per-slice probs and cumulative for current tier index
  let cumulative = 0;
  for (let i = 0; i < rawOutcomes.length; i++) {
    const entry = rawOutcomes[i];
    const sc = entry.scaling ?? entry[0];
    const isAward = Boolean(entry.awardsTier ?? entry[4] ?? false);
    // Mirror contract resolver: ignore non-current tier award slices
    let prob = computeProbBps(sc, balance);
    if (isAward && i !== currentIdx) {
      prob = 0;
    }
    if (i === currentIdx) {
        console.log({i, currentIdx});
      const start = cumulative;
      const end = cumulative + prob;
      if (end <= start) throw new Error("Current tier slice has zero probability at current balance");
      // Log exact jackpot roll window we will target (clamped to [0, cap))
      const capNum = Number(cap);
      const startClamped = Math.max(0, Math.min(start, capNum));
      const endClamped = Math.max(0, Math.min(end, capNum));
      console.log("🎯 Jackpot roll target window", {
        cap: cap.toString(),
        startRaw: start,
        endRaw: end,
        j0: startClamped,
        j1: endClamped,
      });
      // Also log the base roll jackpot window for roll[0]
      const baseStartClamped = baseStart < 0n ? 0n : baseStart;
      const baseEndClamped = baseEnd > BPS ? BPS : baseEnd;
      console.log("🎯 Base roll jackpot window", {
        baseStart: baseStart.toString(),
        baseEnd: baseEnd.toString(),
        baseStartClamped: baseStartClamped.toString(),
        baseEndClamped: baseEndClamped.toString(),
      });
      // Detect unreachable tier slice (occluded by prior slices / zero-width after clamp)
      if (startClamped >= endClamped) {
        console.error("⚠️ Current tier slice is not reachable at this balance.", {
          reason: start >= capNum ? "Occluded by prior slices ≥ cap" : "Zero-width after clamping",
          cumulativeBefore: start,
          cap: capNum,
        });
        throw new Error("Invalid jackpot window");
      }
      // Find a seed quickly with first-roll jackpot, then tier sub-slice
      const seed = findSeedConstrained(baseStart, baseEnd, cap, BigInt(startClamped), BigInt(endClamped));
      console.log("🎯 Seed:", seed.toString());
      const { blockNumber } = await publicClient.waitForTransactionReceipt({
        hash: await coordinator.write.fulfill([getAddress(dep.randomProvider), REQUEST_ID, [seed]], { account: deployer.account })
      });
      console.log(`✅ Fulfilled request ${REQUEST_ID} in block ${blockNumber}`);
      return;
    }
    cumulative += prob;
  }

  throw new Error("Current tier slice index out of range or zero width");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});