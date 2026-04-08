import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther, decodeEventLog, parseAbiItem, type Log } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const DEPLOYMENT_PATH = new URL("./deployments/arb-sepolia-v5.json", import.meta.url);

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const ROULETTE_SPINS = 50;
const JACKPOT_DIRECT_BETS = 50;
const ROULETTE_WAGER = parseEther("0.5");
const ROULETTE_MULTIPLIER = 200; // 2x
const REFERRER = "0x0000000000000000000000000000000000000000" as Addr;
const VRF_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

const FIRST_TIER_OFFSET = 3;

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

const ROULETTE_ABI = [
  {
    type: "function", name: "startSpin", stateMutability: "nonpayable",
    inputs: [
      { name: "wager", type: "uint256" },
      { name: "multiplierHundredths", type: "uint256" },
      { name: "potentialReferrer", type: "address" },
      { name: "participateInJackpot", type: "bool" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    type: "function", name: "pendingSpins", stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [
      { name: "player", type: "address" },
      { name: "wager", type: "uint256" },
      { name: "netStake", type: "uint256" },
      { name: "maxPayout", type: "uint256" },
      { name: "jackpotContribution", type: "uint256" },
      { name: "multiplierHundredths", type: "uint24" },
      { name: "multiplierBps", type: "uint16" },
      { name: "jackpotBps", type: "uint16" },
      { name: "replayBps", type: "uint16" },
      { name: "configIndex", type: "uint32" },
      { name: "participatingInJackpot", type: "bool" },
      { name: "exists", type: "bool" },
    ],
  },
  {
    type: "event", name: "SpinStarted",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "wager", type: "uint256", indexed: false },
      { name: "netStake", type: "uint256", indexed: false },
      { name: "multiplierHundredths", type: "uint256", indexed: false },
      { name: "maxPayout", type: "uint256", indexed: false },
      { name: "jackpotContribution", type: "uint256", indexed: false },
      { name: "configIndex", type: "uint32", indexed: false },
      { name: "participatingInJackpot", type: "bool", indexed: false },
    ],
  },
  {
    type: "event", name: "SpinResolved",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "outcome", type: "uint8", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
      { name: "spinsConsumed", type: "uint8", indexed: false },
      { name: "jackpotPayout", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "SpinFailed",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "reason", type: "bytes32", indexed: false },
    ],
  },
] as const;

const JACKPOT_ABI = [
  {
    type: "function", name: "placeDirectBet", stateMutability: "nonpayable",
    inputs: [{ name: "potentialReferrer", type: "address" }],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    type: "function", name: "getCurrentDirectBetCost", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "directBetRequests", stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [
      { name: "bettor", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "tierIndex", type: "uint8" },
      { name: "settled", type: "bool" },
    ],
  },
  {
    type: "function", name: "getTierProbability", stateMutability: "view",
    inputs: [{ name: "tierIndex", type: "uint8" }],
    outputs: [
      { name: "currentProbPpm", type: "uint256" },
      { name: "entriesSinceWin", type: "uint256" },
      { name: "minProbPpm", type: "uint32" },
      { name: "maxProbPpm", type: "uint32" },
      { name: "incrementPpm", type: "uint32" },
    ],
  },
  {
    type: "function", name: "getCurrentTierInfo", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "tierIndex", type: "uint8" },
      { name: "tier", type: "tuple", components: [
        { name: "prizeMetric", type: "uint256" },
        { name: "isTerminal", type: "bool" },
        { name: "isPercent", type: "bool" },
        { name: "fixedBetCost", type: "uint256" },
        { name: "useDynamicCost", type: "bool" },
        { name: "costBps", type: "uint16" },
      ]},
      { name: "prizeAmount", type: "uint256" },
    ],
  },
  {
    type: "function", name: "PROBABILITY_PRECISION", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event", name: "DirectBetRequested",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "tierIndex", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event", name: "DirectBetSettled",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "outcomeIndex", type: "uint8", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "EntryProcessed",
    inputs: [
      { name: "entryId", type: "uint256", indexed: true },
      { name: "game", type: "address", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "tierIndex", type: "uint8", indexed: false },
      { name: "outcomeIndex", type: "uint8", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "TierWon",
    inputs: [
      { name: "tierIndex", type: "uint8", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "payout", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "ConsolationPaid",
    inputs: [
      { name: "player", type: "address", indexed: true },
      { name: "payout", type: "uint256", indexed: false },
      { name: "consolationMultiplier", type: "uint16", indexed: false },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface RouletteRecord {
  index: number;
  requestId: string;
  outcome: number; // 0=Lose, 1=Win, 2=Jackpot
  payout: bigint;
  jackpotPayout: bigint;
  spinsConsumed: number;
  failed: boolean;
  failReason?: string;
  wager: bigint;
  netStake: bigint;
  jackpotContribution: bigint;
}

interface DirectBetRecord {
  index: number;
  requestId: string;
  tierIndex: number;
  outcomeIndex: number;
  cost: bigint;
  payout: bigint;
  outcomeType: "miss" | "consolation_1.2x" | "consolation_1.5x" | "tier_win";
  failed: boolean;
  failReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function classifyOutcome(outcomeIndex: number): DirectBetRecord["outcomeType"] {
  if (outcomeIndex === 0) return "miss";
  if (outcomeIndex === 1) return "consolation_1.2x";
  if (outcomeIndex === 2) return "consolation_1.5x";
  return "tier_win";
}

const ROULETTE_LABEL = ["LOSE", "WIN", "JACKPOT"] as const;

function ppmToPercent(ppm: bigint | number): string {
  return (Number(ppm) / 10_000).toFixed(4);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const raw = await fs.readFile(DEPLOYMENT_PATH, "utf-8");
  const deploy = JSON.parse(raw);

  const conn = await network.connect();
  const viem = conn.viem;
  const [wallet] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();
  const player = wallet.account.address;

  const tokenAddr = deploy.token as Addr;
  const rouletteAddr = deploy.roulette as Addr;
  const jackpotAddr = deploy.jackpot as Addr;

  console.log("==================================================================");
  console.log("  COMBINED STRESS TEST: 50 Roulette + 50 Direct Jackpot Bets");
  console.log("==================================================================");
  console.log("Player:      ", player);
  console.log("Roulette:    ", rouletteAddr);
  console.log("Jackpot:     ", jackpotAddr);
  console.log("Token:       ", tokenAddr);
  console.log("");

  // ─── Precision check ──────────────────────────────────────────────────

  const precision = await pub.readContract({
    address: jackpotAddr, abi: JACKPOT_ABI, functionName: "PROBABILITY_PRECISION",
  });
  console.log("Jackpot PROBABILITY_PRECISION:", precision.toString());

  // ─── Tier probabilities (before) ───────────────────────────────────────

  console.log("\nTier probabilities (before):");
  for (let t = 0; t < 9; t++) {
    const prob = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getTierProbability", args: [t] }) as any;
    console.log(`  T${t}: ${ppmToPercent(prob[0])}% (entries: ${prob[1]}, range: ${ppmToPercent(prob[2])}%-${ppmToPercent(prob[3])}%, incr: ${ppmToPercent(prob[4])}%)`);
  }

  // ─── Current tier info ─────────────────────────────────────────────────

  const tierInfo = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getCurrentTierInfo" }) as any;
  console.log(`\nCurrent tier: ${tierInfo[0]}, cost: ${formatEther(tierInfo[1].fixedBetCost)} TRT, pot: ${formatEther(tierInfo[2])} TRT`);

  // ─── Pre-flight checks ────────────────────────────────────────────────

  const balance = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [player] });

  const rouletteAllowance = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "allowance", args: [player, rouletteAddr] });
  const jackpotAllowance = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "allowance", args: [player, jackpotAddr] });

  const rouletteNeeded = ROULETTE_WAGER * BigInt(ROULETTE_SPINS) * 2n;
  const jackpotCostEst = parseEther("3") * BigInt(JACKPOT_DIRECT_BETS);
  const totalNeeded = rouletteNeeded + jackpotCostEst;

  console.log(`\nBalance: ${formatEther(balance)} TRT`);
  console.log(`Roulette allowance: ${formatEther(rouletteAllowance)} TRT (need ~${formatEther(rouletteNeeded)})`);
  console.log(`Jackpot allowance:  ${formatEther(jackpotAllowance)} TRT (need ~${formatEther(jackpotCostEst)})`);

  if (balance < totalNeeded) {
    console.error(`\n!! Insufficient balance. Need ~${formatEther(totalNeeded)} TRT`);
    return;
  }

  if (rouletteAllowance < rouletteNeeded) {
    console.log("\nApproving roulette...");
    const tx = await wallet.writeContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "approve", args: [rouletteAddr, rouletteNeeded * 2n] });
    await pub.waitForTransactionReceipt({ hash: tx });
  }
  if (jackpotAllowance < jackpotCostEst) {
    console.log("Approving jackpot...");
    const tx = await wallet.writeContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "approve", args: [jackpotAddr, jackpotCostEst * 2n] });
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // ─── Initial balances ──────────────────────────────────────────────────

  const initPlayerBal = balance;
  const initRouletteBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
  const initJackpotBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [jackpotAddr] });

  console.log("\n--- Starting Balances ---");
  console.log(`Player:   ${formatEther(initPlayerBal)} TRT`);
  console.log(`Roulette: ${formatEther(initRouletteBal)} TRT`);
  console.log(`Jackpot:  ${formatEther(initJackpotBal)} TRT`);

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 1: ROULETTE SPINS
  // ═════════════════════════════════════════════════════════════════════════

  console.log(`\n============ Phase 1: ${ROULETTE_SPINS} Roulette Spins ============\n`);

  const rouletteResults: RouletteRecord[] = [];

  for (let i = 0; i < ROULETTE_SPINS; i++) {
    const label = `[R ${String(i + 1).padStart(2)}/${ROULETTE_SPINS}]`;

    try {
      const txHash = await wallet.writeContract({
        address: rouletteAddr, abi: ROULETTE_ABI, functionName: "startSpin",
        args: [ROULETTE_WAGER, BigInt(ROULETTE_MULTIPLIER), REFERRER, true],
      });
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash });

      let requestId: bigint | null = null;
      let netStake = 0n, maxPayout = 0n, jackpotContribution = 0n;

      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: ROULETTE_ABI, data: log.data, topics: log.topics });
          if (decoded?.eventName === "SpinStarted") {
            const a = decoded.args as any;
            requestId = a.requestId;
            netStake = a.netStake;
            maxPayout = a.maxPayout;
            jackpotContribution = a.jackpotContribution;
            break;
          }
        } catch {}
      }

      if (requestId === null) {
        console.log(`${label} ERROR: No SpinStarted event`);
        rouletteResults.push({ index: i, requestId: "0", outcome: -1, payout: 0n, jackpotPayout: 0n, spinsConsumed: 0, failed: true, failReason: "NO_EVENT", wager: ROULETTE_WAGER, netStake: 0n, jackpotContribution: 0n });
        continue;
      }

      const record = await waitForRouletteResolution(pub, rouletteAddr, requestId, receipt.blockNumber, i);
      record.wager = ROULETTE_WAGER;
      record.netStake = netStake;
      record.jackpotContribution = jackpotContribution;
      rouletteResults.push(record);

      const outcomeStr = record.failed ? `FAILED(${record.failReason})` : ROULETTE_LABEL[record.outcome] ?? `UNK(${record.outcome})`;
      const payStr = record.payout > 0n ? ` payout:${formatEther(record.payout)}` : "";
      const jpStr = record.jackpotPayout > 0n ? ` jp:${formatEther(record.jackpotPayout)}` : "";
      console.log(`${label} ${outcomeStr}${payStr}${jpStr} rolls:${record.spinsConsumed}`);

    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.log(`${label} TX_ERROR: ${msg.slice(0, 120)}`);
      rouletteResults.push({ index: i, requestId: "0", outcome: -1, payout: 0n, jackpotPayout: 0n, spinsConsumed: 0, failed: true, failReason: msg, wager: ROULETTE_WAGER, netStake: 0n, jackpotContribution: 0n });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 2: JACKPOT DIRECT BETS
  // ═════════════════════════════════════════════════════════════════════════

  console.log(`\n============ Phase 2: ${JACKPOT_DIRECT_BETS} Jackpot Direct Bets ============\n`);

  const directResults: DirectBetRecord[] = [];

  for (let i = 0; i < JACKPOT_DIRECT_BETS; i++) {
    const label = `[J ${String(i + 1).padStart(2)}/${JACKPOT_DIRECT_BETS}]`;

    try {
      const cost = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getCurrentDirectBetCost" });

      const txHash = await wallet.writeContract({
        address: jackpotAddr, abi: JACKPOT_ABI, functionName: "placeDirectBet",
        args: [REFERRER],
      });
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash });

      let requestId: bigint | null = null;
      let tierIndex = 0;

      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: JACKPOT_ABI, data: log.data, topics: log.topics });
          if (decoded?.eventName === "DirectBetRequested") {
            const a = decoded.args as any;
            requestId = a.requestId;
            tierIndex = a.tierIndex;
            break;
          }
        } catch {}
      }

      if (requestId === null) {
        console.log(`${label} ERROR: No DirectBetRequested event`);
        directResults.push({ index: i, requestId: "0", tierIndex: 0, outcomeIndex: -1, cost, payout: 0n, outcomeType: "miss", failed: true, failReason: "NO_EVENT" });
        continue;
      }

      const record = await waitForDirectBetResolution(pub, jackpotAddr, requestId, receipt.blockNumber, i, tierIndex, cost);
      directResults.push(record);

      const typeLabel = record.outcomeType.toUpperCase();
      const payStr = record.payout > 0n ? ` payout:${formatEther(record.payout)}` : "";
      console.log(`${label} T${record.tierIndex} ${typeLabel}${payStr} (cost:${formatEther(cost)}, oc:${record.outcomeIndex})`);

    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.log(`${label} TX_ERROR: ${msg.slice(0, 120)}`);
      directResults.push({ index: i, requestId: "0", tierIndex: -1, outcomeIndex: -1, cost: 0n, payout: 0n, outcomeType: "miss", failed: true, failReason: msg });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ANALYSIS
  // ═════════════════════════════════════════════════════════════════════════

  console.log("\n==================================================================");
  console.log("  RESULTS ANALYSIS");
  console.log("==================================================================");

  // ─── Roulette Analysis ─────────────────────────────────────────────────

  const rCompleted = rouletteResults.filter(r => !r.failed);
  const rFailed = rouletteResults.filter(r => r.failed);
  const rLosses = rCompleted.filter(r => r.outcome === 0);
  const rWins = rCompleted.filter(r => r.outcome === 1);
  const rJackpots = rCompleted.filter(r => r.outcome === 2);

  console.log("\n--- Roulette (50 spins) ---");
  console.log(`Completed: ${rCompleted.length}  |  Failed: ${rFailed.length}`);
  console.log(`Losses: ${rLosses.length}  |  Wins: ${rWins.length}  |  Jackpot triggers: ${rJackpots.length}`);

  const rTotalWagered = rCompleted.reduce((s, r) => s + r.wager, 0n);
  const rTotalPayout = rCompleted.reduce((s, r) => s + r.payout, 0n);
  const rTotalJpPayout = rCompleted.reduce((s, r) => s + r.jackpotPayout, 0n);
  const rTotalJpContrib = rCompleted.reduce((s, r) => s + r.jackpotContribution, 0n);
  const rReturn = rTotalPayout + rTotalJpPayout;

  console.log(`Wagered: ${formatEther(rTotalWagered)} | Payouts: ${formatEther(rTotalPayout)} | JP payouts: ${formatEther(rTotalJpPayout)} | JP contrib: ${formatEther(rTotalJpContrib)}`);
  if (rTotalWagered > 0n) {
    console.log(`RTP: ${(Number((rReturn * 10000n) / rTotalWagered) / 100).toFixed(2)}%`);
  }

  const replayCount = rCompleted.filter(r => r.spinsConsumed > 1).length;
  console.log(`Replays: ${replayCount} (${((replayCount / Math.max(rCompleted.length, 1)) * 100).toFixed(1)}%)`);

  // ─── Direct Bet Analysis ───────────────────────────────────────────────

  const dCompleted = directResults.filter(r => !r.failed);
  const dFailed = directResults.filter(r => r.failed);
  const dMiss = dCompleted.filter(r => r.outcomeType === "miss");
  const dCons1 = dCompleted.filter(r => r.outcomeType === "consolation_1.2x");
  const dCons2 = dCompleted.filter(r => r.outcomeType === "consolation_1.5x");
  const dTierWins = dCompleted.filter(r => r.outcomeType === "tier_win");

  console.log("\n--- Jackpot Direct Bets (50 bets) ---");
  console.log(`Completed: ${dCompleted.length}  |  Failed: ${dFailed.length}`);
  console.log(`Misses:          ${dMiss.length}  (${pct(dMiss.length, dCompleted.length)}%)`);
  console.log(`Consolation 1.2x: ${dCons1.length}  (${pct(dCons1.length, dCompleted.length)}%)`);
  console.log(`Consolation 1.5x: ${dCons2.length}  (${pct(dCons2.length, dCompleted.length)}%)`);
  console.log(`Tier wins:        ${dTierWins.length}  (${pct(dTierWins.length, dCompleted.length)}%)`);

  const dTotalCost = dCompleted.reduce((s, r) => s + r.cost, 0n);
  const dTotalPayout = dCompleted.reduce((s, r) => s + r.payout, 0n);

  console.log(`Total cost: ${formatEther(dTotalCost)} | Total payout: ${formatEther(dTotalPayout)}`);
  if (dTotalCost > 0n) {
    console.log(`Direct bet RTP: ${(Number((dTotalPayout * 10000n) / dTotalCost) / 100).toFixed(2)}%`);
  }

  if (dTierWins.length > 0) {
    console.log("\nTier wins detail:");
    for (const tw of dTierWins) {
      console.log(`  Bet #${tw.index + 1}: tier ${tw.tierIndex}, payout ${formatEther(tw.payout)} TRT`);
    }
  }

  if (dCons1.length + dCons2.length > 0) {
    console.log("\nConsolation wins detail:");
    for (const c of [...dCons1, ...dCons2]) {
      console.log(`  Bet #${c.index + 1}: ${c.outcomeType}, payout ${formatEther(c.payout)} TRT`);
    }
  }

  // ─── Tier probabilities (after) ────────────────────────────────────────

  console.log("\nTier probabilities (after):");
  for (let t = 0; t < 9; t++) {
    const prob = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getTierProbability", args: [t] }) as any;
    console.log(`  T${t}: ${ppmToPercent(prob[0])}%  (entries since win: ${prob[1]})`);
  }

  // ─── Final Balances ────────────────────────────────────────────────────

  const finalPlayerBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [player] });
  const finalRouletteBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
  const finalJackpotBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [jackpotAddr] });

  console.log("\n--- Final Balances ---");
  console.log(`Player:   ${formatEther(finalPlayerBal)} TRT  (delta: ${formatEther(finalPlayerBal - initPlayerBal)})`);
  console.log(`Roulette: ${formatEther(finalRouletteBal)} TRT  (delta: ${formatEther(finalRouletteBal - initRouletteBal)})`);
  console.log(`Jackpot:  ${formatEther(finalJackpotBal)} TRT  (delta: ${formatEther(finalJackpotBal - initJackpotBal)})`);

  // ─── Combined Summary ──────────────────────────────────────────────────

  const totalSpent = rTotalWagered + dTotalCost;
  const totalReturned = rReturn + dTotalPayout;

  console.log("\n--- Combined Summary ---");
  console.log(`Total spent:     ${formatEther(totalSpent)} TRT`);
  console.log(`Total returned:  ${formatEther(totalReturned)} TRT`);
  console.log(`Net P&L:         ${formatEther(totalReturned - totalSpent)} TRT`);
  if (totalSpent > 0n) {
    console.log(`Combined RTP:    ${(Number((totalReturned * 10000n) / totalSpent) / 100).toFixed(2)}%`);
  }

  // ─── Verification Checklist ────────────────────────────────────────────

  console.log("\n--- Verification Checklist ---");
  const checks: Array<[string, boolean, string]> = [
    ["Roulette spins complete", rCompleted.length > 0, `${rCompleted.length}/${ROULETTE_SPINS}`],
    ["Roulette wins occur", rWins.length > 0, `${rWins.length} wins`],
    ["Roulette losses occur", rLosses.length > 0, `${rLosses.length} losses`],
    ["Roulette replay triggers", rCompleted.some(r => r.spinsConsumed > 1), `${replayCount} replays`],
    ["Roulette jackpot triggers", rJackpots.length > 0, `${rJackpots.length} triggers`],
    ["Jackpot contributions flow", rTotalJpContrib > 0n, `${formatEther(rTotalJpContrib)} TRT`],
    ["Direct bets complete", dCompleted.length > 0, `${dCompleted.length}/${JACKPOT_DIRECT_BETS}`],
    ["Direct bet misses occur", dMiss.length > 0, `${dMiss.length} misses`],
    ["Direct bet consolation possible", dCons1.length + dCons2.length > 0, dCons1.length + dCons2.length > 0 ? `${dCons1.length + dCons2.length} consolations` : "None (expected with low sample)"],
    ["Direct bet tier win possible", dTierWins.length > 0, dTierWins.length > 0 ? `${dTierWins.length} tier wins!` : "None (expected with low prob)"],
    ["Precision = 1,000,000", precision === 1_000_000n, precision.toString()],
  ];

  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? "✓" : "~"} ${name}`);
    console.log(`    → ${detail}`);
  }

  // ─── Save Results ──────────────────────────────────────────────────────

  const outPath = new URL("./deployments/combined-stress-results.json", import.meta.url);
  const output = {
    meta: {
      timestamp: new Date().toISOString(),
      network: "arbitrumSepolia",
      precision: precision.toString(),
      roulette: rouletteAddr,
      jackpot: jackpotAddr,
      player,
    },
    roulette: {
      total: rouletteResults.length,
      completed: rCompleted.length,
      failed: rFailed.length,
      losses: rLosses.length,
      wins: rWins.length,
      jackpotTriggers: rJackpots.length,
      totalWagered: rTotalWagered.toString(),
      totalPayout: rTotalPayout.toString(),
      totalJpPayout: rTotalJpPayout.toString(),
      totalJpContrib: rTotalJpContrib.toString(),
    },
    directBets: {
      total: directResults.length,
      completed: dCompleted.length,
      failed: dFailed.length,
      misses: dMiss.length,
      consolation1x2: dCons1.length,
      consolation1x5: dCons2.length,
      tierWins: dTierWins.length,
      totalCost: dTotalCost.toString(),
      totalPayout: dTotalPayout.toString(),
    },
    balances: {
      player: { before: initPlayerBal.toString(), after: finalPlayerBal.toString() },
      roulette: { before: initRouletteBal.toString(), after: finalRouletteBal.toString() },
      jackpot: { before: initJackpotBal.toString(), after: finalJackpotBal.toString() },
    },
  };
  await fs.writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to: ${outPath.pathname}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// RESOLUTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function waitForRouletteResolution(
  pub: any, rouletteAddr: Addr, requestId: bigint, fromBlock: bigint, index: number
): Promise<RouletteRecord> {
  const deadline = Date.now() + VRF_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const pending = await pub.readContract({
      address: rouletteAddr, abi: ROULETTE_ABI, functionName: "pendingSpins", args: [requestId],
    }) as any[];

    if (pending[11]) continue; // exists = true, still pending

    const currentBlock = await pub.getBlockNumber();

    const resolvedLogs = await pub.getLogs({
      address: rouletteAddr,
      event: parseAbiItem("event SpinResolved(uint256 indexed requestId, address indexed player, uint8 outcome, uint256 payout, uint8 spinsConsumed, uint256 jackpotPayout)"),
      args: { requestId },
      fromBlock, toBlock: currentBlock,
    });

    if (resolvedLogs.length > 0) {
      const ev = resolvedLogs[0].args;
      return {
        index, requestId: requestId.toString(),
        outcome: ev.outcome!, payout: ev.payout ?? 0n, jackpotPayout: ev.jackpotPayout ?? 0n,
        spinsConsumed: ev.spinsConsumed!, failed: false,
        wager: 0n, netStake: 0n, jackpotContribution: 0n,
      };
    }

    const failedLogs = await pub.getLogs({
      address: rouletteAddr,
      event: parseAbiItem("event SpinFailed(uint256 indexed requestId, address indexed player, bytes32 reason)"),
      args: { requestId },
      fromBlock, toBlock: currentBlock,
    });

    if (failedLogs.length > 0) {
      return {
        index, requestId: requestId.toString(),
        outcome: -1, payout: 0n, jackpotPayout: 0n, spinsConsumed: 0,
        failed: true, failReason: failedLogs[0].args.reason ?? "unknown",
        wager: 0n, netStake: 0n, jackpotContribution: 0n,
      };
    }

    break;
  }

  return {
    index, requestId: requestId.toString(),
    outcome: -1, payout: 0n, jackpotPayout: 0n, spinsConsumed: 0,
    failed: true, failReason: "VRF_TIMEOUT",
    wager: 0n, netStake: 0n, jackpotContribution: 0n,
  };
}

async function waitForDirectBetResolution(
  pub: any, jackpotAddr: Addr, requestId: bigint, fromBlock: bigint,
  index: number, tierIndex: number, cost: bigint,
): Promise<DirectBetRecord> {
  const deadline = Date.now() + VRF_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const req = await pub.readContract({
      address: jackpotAddr, abi: JACKPOT_ABI, functionName: "directBetRequests", args: [requestId],
    }) as any[];

    if (!req[3]) continue; // settled = false, still pending

    const currentBlock = await pub.getBlockNumber();

    const settledLogs = await pub.getLogs({
      address: jackpotAddr,
      event: parseAbiItem("event DirectBetSettled(uint256 indexed requestId, address indexed player, uint8 outcomeIndex, uint256 payout)"),
      args: { requestId },
      fromBlock, toBlock: currentBlock,
    });

    if (settledLogs.length > 0) {
      const ev = settledLogs[0].args;
      return {
        index, requestId: requestId.toString(),
        tierIndex, outcomeIndex: ev.outcomeIndex!,
        cost, payout: ev.payout ?? 0n,
        outcomeType: classifyOutcome(ev.outcomeIndex!),
        failed: false,
      };
    }

    return {
      index, requestId: requestId.toString(),
      tierIndex, outcomeIndex: -1, cost, payout: 0n,
      outcomeType: "miss", failed: true, failReason: "SETTLED_NO_EVENT",
    };
  }

  return {
    index, requestId: requestId.toString(),
    tierIndex, outcomeIndex: -1, cost, payout: 0n,
    outcomeType: "miss", failed: true, failReason: "VRF_TIMEOUT",
  };
}

function pct(n: number, d: number): string {
  return ((n / Math.max(d, 1)) * 100).toFixed(1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
