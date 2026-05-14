import { network } from "hardhat";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const PLINKO   = "0xe06bf80bba6df203eae104968ade29b50077ee02" as Addr;
const TOKEN    = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as Addr;
const HANDLER  = "0xabe66fc056dd0e116b90201e487ea102fd7df1ba" as Addr;

const ERC20_ABI = [{
  type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

const PLINKO_ABI = [
  { type: "function", name: "lockedExposure", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalPendingBets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "maxTotalPendingBets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "minBet", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "maxBet", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "maxDropsPerBet", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "maxPendingBetsPerPlayer", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "betExpiryBlocks", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function", name: "availableLiquidity", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "getMultipliers", stateMutability: "view",
    inputs: [{ name: "rows", type: "uint8" }, { name: "risk", type: "uint8" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function", name: "maxMultipliers", stateMutability: "view",
    inputs: [{ name: "rows", type: "uint8" }, { name: "risk", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const HANDLER_ABI = [{
  type: "function", name: "getGameConfig", stateMutability: "view",
  inputs: [{ name: "game", type: "address" }],
  outputs: [
    { name: "enabled", type: "bool" },
    { name: "payoutTarget", type: "address" },
    { name: "feeRecipient", type: "address" },
    { name: "houseEdgeBps", type: "uint16" },
    { name: "referralBps", type: "uint16" },
  ],
}] as const;

const PLINKO_READ_ABI = [{
  type: "function", name: "getAllowedRows", stateMutability: "view",
  inputs: [], outputs: [{ name: "", type: "uint8[]" }],
}] as const;

const RISK_NAMES = ["Low", "Medium", "High"];

function binomialRow(n: number): number[] {
  const row = [1];
  for (let k = 1; k <= n; k++) {
    row.push(row[k - 1] * (n - k + 1) / k);
  }
  return row;
}

function computeRTP(rows: number, mults: bigint[]): number {
  const probs = binomialRow(rows);
  const total = probs.reduce((a, b) => a + b, 0);
  let rtp = 0;
  for (let i = 0; i < mults.length; i++) {
    rtp += (probs[i] / total) * (Number(mults[i]) / 100);
  }
  return rtp;
}

async function main() {
  const conn = await network.connect();
  const pub = await conn.viem.getPublicClient();

  const read = (args: any) => pub.readContract(args);

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  PLINKO STATE INSPECTOR");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Contract:", PLINKO);
  console.log("");

  // ─── Balances & core state ─────────────────────────────────────────
  const [balance, locked, avail, pending, maxPending, isPaused] = await Promise.all([
    read({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PLINKO] }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "lockedExposure" }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "availableLiquidity" }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "totalPendingBets" }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "maxTotalPendingBets" }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "paused" }),
  ]) as [bigint, bigint, bigint, bigint, bigint, boolean];

  console.log("─── Balances ───────────────────────────────────────────────");
  console.log("  EVA balance:        ", formatEther(balance), "EVA");
  console.log("  Locked exposure:    ", formatEther(locked), "EVA");
  console.log("  Available liquidity:", formatEther(avail), "EVA");
  console.log("  Pending bets:       ", pending.toString(), "/", maxPending.toString());
  console.log("  Paused:             ", isPaused);
  console.log("");

  // ─── Config ────────────────────────────────────────────────────────
  const [minB, maxB, maxDrops, maxPendingPerPlayer, betExpiry] = await Promise.all([
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "minBet" }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "maxBet" }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "maxDropsPerBet" }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "maxPendingBetsPerPlayer" }),
    read({ address: PLINKO, abi: PLINKO_ABI, functionName: "betExpiryBlocks" }),
  ]) as [bigint, bigint, number, number, bigint];

  const handlerCfg = await read({
    address: HANDLER, abi: HANDLER_ABI, functionName: "getGameConfig", args: [PLINKO],
  }) as any;

  console.log("─── Config ─────────────────────────────────────────────────");
  console.log("  minBet:              ", formatEther(minB), "EVA");
  console.log("  maxBet:              ", formatEther(maxB), "EVA");
  console.log("  maxDropsPerBet:      ", maxDrops);
  console.log("  maxPendingPerPlayer: ", maxPendingPerPlayer);
  console.log("  maxTotalPending:     ", maxPending.toString());
  console.log("  betExpiryBlocks:     ", betExpiry.toString());
  console.log("  handler enabled:     ", handlerCfg[0]);
  console.log("  houseEdge:           ", Number(handlerCfg[3]) / 100 + "%");
  console.log("  referralBps:         ", Number(handlerCfg[4]) / 100 + "%");
  console.log("");

  // ─── Read allowed rows from chain ──────────────────────────────────
  const allowedRows = await read({
    address: PLINKO, abi: PLINKO_READ_ABI, functionName: "getAllowedRows",
  }) as number[];

  console.log("  Allowed rows:        [", allowedRows.join(", "), "]");
  console.log("");

  // ─── Multiplier tables ─────────────────────────────────────────────
  console.log("─── Multiplier Tables (MULTIPLIER_SCALE = 100) ─────────────");
  console.log("");

  for (const rows of allowedRows) {
    console.log(`  ── ${rows} Rows ──`);
    for (let risk = 0; risk < 3; risk++) {
      const mults = await read({
        address: PLINKO, abi: PLINKO_ABI, functionName: "getMultipliers",
        args: [rows, risk],
      }) as bigint[];

      const maxMult = await read({
        address: PLINKO, abi: PLINKO_ABI, functionName: "maxMultipliers",
        args: [rows, risk],
      }) as bigint;

      if (mults.length === 0) {
        console.log(`    ${RISK_NAMES[risk]}: (not set)`);
        continue;
      }

      const rtp = computeRTP(rows, mults);
      const floats = mults.map(m => (Number(m) / 100).toFixed(2) + "x");
      const center = mults[Math.floor(mults.length / 2)];
      const edge = mults[0];

      console.log(`    ${RISK_NAMES[risk]}:`);
      console.log(`      Stored:  [${mults.join(", ")}]`);
      console.log(`      Float:   [${floats.join(", ")}]`);
      console.log(`      Edge:    ${(Number(edge) / 100).toFixed(2)}x  |  Center: ${(Number(center) / 100).toFixed(2)}x  |  Max: ${(Number(maxMult) / 100).toFixed(2)}x`);
      console.log(`      RTP:     ${(rtp * 100).toFixed(2)}%`);

      // Check monotonicity
      const half = Math.floor(mults.length / 2);
      let monotonic = true;
      for (let i = 0; i < half; i++) {
        if (mults[i] < mults[i + 1]) { monotonic = false; break; }
      }
      if (!monotonic) console.log(`      ⚠ NOT strictly monotonic (edge→center)`);
    }
    console.log("");
  }

  // ─── Exposure analysis ─────────────────────────────────────────────
  console.log("─── Max Bet Capacity (1 drop, by config) ────────────────────");
  console.log("  Available liquidity:", formatEther(avail), "EVA");
  console.log("");

  for (const rows of allowedRows) {
    for (let risk = 0; risk < 3; risk++) {
      const maxMult = await read({
        address: PLINKO, abi: PLINKO_ABI, functionName: "maxMultipliers",
        args: [rows, risk],
      }) as bigint;

      if (maxMult === 0n) continue;

      const maxBetForConfig = (avail * 100n) / maxMult;
      const effectiveMax = maxBetForConfig < maxB ? maxBetForConfig : maxB;

      console.log(
        `  ${String(rows).padStart(2)}R ${RISK_NAMES[risk].padEnd(6)} | maxMult: ${(Number(maxMult) / 100).toFixed(2).padStart(7)}x | max single bet: ${formatEther(effectiveMax).padStart(10)} EVA`
      );
    }
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
