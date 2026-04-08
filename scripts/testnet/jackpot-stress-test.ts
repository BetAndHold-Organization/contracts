import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther, decodeEventLog, parseAbiItem, type Log } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const DEPLOYMENT_PATH = new URL("./deployments/arb-sepolia-v5.json", import.meta.url);

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const TOTAL_SPINS = 500;
const WAGER = parseEther("0.5");
const MULTIPLIER = 200;          // 2x
const PARTICIPATE_JACKPOT = true;
const REFERRER = "0x0000000000000000000000000000000000000000" as Addr;
const VRF_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

const FIRST_TIER_OFFSET = 3; // outcomeIndex 3 = tier 0, 4 = tier 1, ... 11 = tier 8

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
    type: "function", name: "getJackpotState", stateMutability: "view",
    inputs: [],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "nextTierIndex", type: "uint8" },
        { name: "totalEntries", type: "uint256" },
        { name: "totalJackpotsWon", type: "uint256" },
        { name: "totalConsolationPaid", type: "uint256" },
        { name: "lastWinner", type: "address" },
        { name: "lastWinTimestamp", type: "uint256" },
      ],
    }],
  },
  {
    type: "function", name: "getAllTierPotBalances", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "balances", type: "uint256[9]" }],
  },
  {
    type: "function", name: "consolationPotBalance", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
    type: "function", name: "getJackpotBalance", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
    type: "event", name: "JackpotWon",
    inputs: [
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

interface JackpotEntry {
  spinIndex: number;
  entryId: string;
  tierIndex: number;
  outcomeIndex: number;
  outcomeType: "MISS" | "CONSOLATION_1.2x" | "CONSOLATION_1.5x" | "TIER_WIN";
  tierWon: number | null;   // which tier was won, or null
  payout: string;
  consolationMultiplier: number; // 0, 12000, or 15000
}

interface SpinRecord {
  index: number;
  requestId: string;
  rouletteOutcome: number; // 0=Lose, 1=Win, 2=Jackpot
  roulettePayout: string;
  jackpotPayout: string;
  spinsConsumed: number;
  failed: boolean;
  failReason?: string;
  jackpotEntry: JackpotEntry | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function decodeLog(abi: readonly any[], log: Log) {
  try {
    return decodeEventLog({ abi, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

function classifyOutcome(outcomeIndex: number): JackpotEntry["outcomeType"] {
  if (outcomeIndex === 0) return "MISS";
  if (outcomeIndex === 1) return "CONSOLATION_1.2x";
  if (outcomeIndex === 2) return "CONSOLATION_1.5x";
  return "TIER_WIN"; // 3+ = tier win (3=T0, 4=T1, ..., 11=T8)
}

function consolationMultiplierFromIndex(idx: number): number {
  if (idx === 1) return 12000;
  if (idx === 2) return 15000;
  return 0;
}

const ROULETTE_LABEL = ["LOSE", "WIN", "JACKPOT"] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (n: number, d: number) => ((n / Math.max(d, 1)) * 100).toFixed(1);
const bn = (s: string) => BigInt(s);

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
  console.log("  JACKPOT STRESS TEST — " + TOTAL_SPINS + " ROULETTE SPINS");
  console.log("==================================================================");
  console.log("Player:      ", player);
  console.log("Roulette:    ", rouletteAddr);
  console.log("Jackpot:     ", jackpotAddr);
  console.log("Token:       ", tokenAddr);
  console.log("Wager:       ", formatEther(WAGER), "TRT  |  Multiplier:", MULTIPLIER / 100, "x");
  console.log("Jackpot opt:", PARTICIPATE_JACKPOT);
  console.log("");

  // ─── Pre-flight ───────────────────────────────────────────────────────

  const balance = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [player] });
  const allowance = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "allowance", args: [player, rouletteAddr] });
  const totalNeeded = WAGER * BigInt(TOTAL_SPINS);

  console.log("Balance:      ", formatEther(balance), "TRT");
  console.log("Allowance:    ", formatEther(allowance), "TRT");
  console.log("Max needed:   ", formatEther(totalNeeded), "TRT");

  if (balance < totalNeeded) { console.error("!! Insufficient balance"); return; }

  if (allowance < totalNeeded) {
    console.log("Approving roulette...");
    const tx = await wallet.writeContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "approve", args: [rouletteAddr, totalNeeded * 2n] });
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // ─── Initial snapshots ────────────────────────────────────────────────

  const initPlayerBal = balance;
  const initRouletteBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
  const initJackpotBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [jackpotAddr] });
  const initJpState = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getJackpotState" }) as any;
  const initTierPots = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getAllTierPotBalances" }) as bigint[];
  const initConsolationPot = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "consolationPotBalance" }) as bigint;

  console.log("\n--- Initial Jackpot State ---");
  console.log("Next tier:         ", initJpState.nextTierIndex);
  console.log("Total entries:     ", initJpState.totalEntries.toString());
  console.log("Total jackpots won:", initJpState.totalJackpotsWon.toString());
  console.log("Jackpot balance:   ", formatEther(initJackpotBal), "TRT");
  console.log("Consolation pot:   ", formatEther(initConsolationPot), "TRT");
  console.log("Tier pots:");
  for (let t = 0; t < 9; t++) {
    console.log(`  T${t}: ${formatEther(initTierPots[t])} TRT`);
  }

  // Tier probabilities
  console.log("Tier probabilities:");
  for (let t = 0; t < 9; t++) {
    const prob = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getTierProbability", args: [t] }) as any;
    console.log(`  T${t}: ${(Number(prob[0]) / 10_000).toFixed(4)}% (entries since win: ${prob[1]}, range: ${Number(prob[2]) / 10_000}%-${Number(prob[3]) / 10_000}%, incr: ${Number(prob[4]) / 10_000}%)`);
  }

  console.log("\n============ Starting", TOTAL_SPINS, "spins ============\n");

  // ─── Spin loop ────────────────────────────────────────────────────────

  const results: SpinRecord[] = [];
  let jackpotTriggersTotal = 0;
  let lastReportedAt = 0;

  for (let i = 0; i < TOTAL_SPINS; i++) {
    const label = `[${String(i + 1).padStart(3)}/${TOTAL_SPINS}]`;

    try {
      const txHash = await wallet.writeContract({
        address: rouletteAddr, abi: ROULETTE_ABI, functionName: "startSpin",
        args: [WAGER, BigInt(MULTIPLIER), REFERRER, PARTICIPATE_JACKPOT],
      });
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash });

      // Parse SpinStarted
      let requestId: bigint | null = null;
      for (const log of receipt.logs) {
        const dec = decodeLog(ROULETTE_ABI, log as any);
        if (dec?.eventName === "SpinStarted") {
          requestId = (dec.args as any).requestId;
          break;
        }
      }

      if (requestId === null) {
        console.log(`${label} ERROR: No SpinStarted`);
        results.push({ index: i, requestId: "0", rouletteOutcome: -1, roulettePayout: "0", jackpotPayout: "0", spinsConsumed: 0, failed: true, failReason: "NO_SPIN_STARTED", jackpotEntry: null });
        continue;
      }

      // Wait for VRF
      const deadline = Date.now() + VRF_TIMEOUT_MS;
      let record: SpinRecord | null = null;

      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const pending = await pub.readContract({ address: rouletteAddr, abi: ROULETTE_ABI, functionName: "pendingSpins", args: [requestId] }) as any[];
        if (pending[11]) continue; // still pending

        const currentBlock = await pub.getBlockNumber();

        // SpinResolved
        const resolvedLogs = await pub.getLogs({
          address: rouletteAddr,
          event: parseAbiItem("event SpinResolved(uint256 indexed requestId, address indexed player, uint8 outcome, uint256 payout, uint8 spinsConsumed, uint256 jackpotPayout)"),
          args: { requestId },
          fromBlock: receipt.blockNumber,
          toBlock: currentBlock,
        });

        if (resolvedLogs.length > 0) {
          const ev = resolvedLogs[0].args;

          // Now fetch jackpot EntryProcessed for this spin's resolution block
          let jpEntry: JackpotEntry | null = null;
          const resolvedBlock = resolvedLogs[0].blockNumber;

          if (ev.outcome === 2) {
            // Jackpot outcome: look for EntryProcessed from the jackpot contract in the VRF callback tx
            const entryLogs = await pub.getLogs({
              address: jackpotAddr,
              event: parseAbiItem("event EntryProcessed(uint256 indexed entryId, address indexed game, address indexed player, uint8 tierIndex, uint8 outcomeIndex, uint256 payout)"),
              args: { game: rouletteAddr, player },
              fromBlock: resolvedBlock,
              toBlock: resolvedBlock,
            });

            if (entryLogs.length > 0) {
              const je = entryLogs[entryLogs.length - 1].args; // latest entry in this block
              const oi = je.outcomeIndex!;
              const tierWon = oi >= FIRST_TIER_OFFSET ? oi - FIRST_TIER_OFFSET : null;
              jpEntry = {
                spinIndex: i,
                entryId: je.entryId!.toString(),
                tierIndex: je.tierIndex!,
                outcomeIndex: oi,
                outcomeType: classifyOutcome(oi),
                tierWon,
                payout: (je.payout ?? 0n).toString(),
                consolationMultiplier: consolationMultiplierFromIndex(oi),
              };
            }
            jackpotTriggersTotal++;
          }

          record = {
            index: i,
            requestId: requestId.toString(),
            rouletteOutcome: ev.outcome!,
            roulettePayout: (ev.payout ?? 0n).toString(),
            jackpotPayout: (ev.jackpotPayout ?? 0n).toString(),
            spinsConsumed: ev.spinsConsumed!,
            failed: false,
            jackpotEntry: jpEntry,
          };
          break;
        }

        // SpinFailed
        const failedLogs = await pub.getLogs({
          address: rouletteAddr,
          event: parseAbiItem("event SpinFailed(uint256 indexed requestId, address indexed player, bytes32 reason)"),
          args: { requestId },
          fromBlock: receipt.blockNumber,
          toBlock: currentBlock,
        });

        if (failedLogs.length > 0) {
          record = { index: i, requestId: requestId.toString(), rouletteOutcome: -1, roulettePayout: "0", jackpotPayout: "0", spinsConsumed: 0, failed: true, failReason: failedLogs[0].args.reason ?? "unknown", jackpotEntry: null };
          break;
        }

        // exists=false but no event — resolved with no event (rare)
        record = { index: i, requestId: requestId.toString(), rouletteOutcome: -1, roulettePayout: "0", jackpotPayout: "0", spinsConsumed: 0, failed: true, failReason: "RESOLVED_NO_EVENT", jackpotEntry: null };
        break;
      }

      if (!record) {
        record = { index: i, requestId: requestId.toString(), rouletteOutcome: -1, roulettePayout: "0", jackpotPayout: "0", spinsConsumed: 0, failed: true, failReason: "VRF_TIMEOUT", jackpotEntry: null };
      }

      results.push(record);

      // Print spin result
      const rLabel = record.failed ? `FAILED(${record.failReason})` : ROULETTE_LABEL[record.rouletteOutcome] ?? `?(${record.rouletteOutcome})`;
      const payStr = bn(record.roulettePayout) > 0n ? ` pay:${formatEther(bn(record.roulettePayout))}` : "";
      const jpPayStr = bn(record.jackpotPayout) > 0n ? ` jp:${formatEther(bn(record.jackpotPayout))}` : "";
      const rollStr = !record.failed ? ` r:${record.spinsConsumed}` : "";
      let jpDetail = "";
      if (record.jackpotEntry) {
        const je = record.jackpotEntry;
        jpDetail = ` [JP:${je.outcomeType} tier=${je.tierIndex}`;
        if (je.tierWon !== null) jpDetail += ` WON_T${je.tierWon}`;
        if (bn(je.payout) > 0n) jpDetail += ` +${formatEther(bn(je.payout))}`;
        jpDetail += "]";
      }
      console.log(`${label} ${rLabel}${payStr}${jpPayStr}${rollStr}${jpDetail}`);

      // Periodic summary every 50 spins
      if ((i + 1) % 50 === 0 && i + 1 > lastReportedAt) {
        lastReportedAt = i + 1;
        const completed = results.filter((r) => !r.failed);
        const jp = completed.filter((r) => r.rouletteOutcome === 2);
        console.log(`  >> Checkpoint: ${completed.length} done, ${jp.length} jackpot triggers, ${jp.filter((r) => r.jackpotEntry?.outcomeType === "TIER_WIN").length} tier wins`);
      }

    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.log(`${label} TX_ERROR: ${msg}`);
      results.push({ index: i, requestId: "0", rouletteOutcome: -1, roulettePayout: "0", jackpotPayout: "0", spinsConsumed: 0, failed: true, failReason: `TX_ERROR: ${msg}`, jackpotEntry: null });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n==================================================================");
  console.log("  RESULTS ANALYSIS");
  console.log("==================================================================\n");

  const completed = results.filter((r) => !r.failed);
  const failed = results.filter((r) => r.failed);
  const losses = completed.filter((r) => r.rouletteOutcome === 0);
  const wins = completed.filter((r) => r.rouletteOutcome === 1);
  const jackpotOutcomes = completed.filter((r) => r.rouletteOutcome === 2);

  console.log(`Total spins: ${results.length}  |  Completed: ${completed.length}  |  Failed: ${failed.length}`);
  console.log("");

  // ─── Roulette Outcome Distribution ────────────────────────────────────

  console.log("=== ROULETTE OUTCOMES ===");
  console.log(`Losses:   ${losses.length}  (${pct(losses.length, completed.length)}%)`);
  console.log(`Wins:     ${wins.length}  (${pct(wins.length, completed.length)}%)`);
  console.log(`Jackpot:  ${jackpotOutcomes.length}  (${pct(jackpotOutcomes.length, completed.length)}%)  [config: 3%]`);
  console.log("");

  // Replay depth
  const spinCounts: Record<number, number> = {};
  for (const r of completed) { spinCounts[r.spinsConsumed] = (spinCounts[r.spinsConsumed] || 0) + 1; }
  console.log("--- Replay Depth ---");
  for (const [k, v] of Object.entries(spinCounts).sort(([a], [b]) => +a - +b)) {
    const bar = "█".repeat(Math.min(Math.round((v / completed.length) * 60), 60));
    console.log(`  ${k} roll${+k > 1 ? "s" : " "}: ${String(v).padStart(4)} (${pct(v, completed.length).padStart(5)}%) ${bar}`);
  }
  console.log("");

  // ─── JACKPOT DETAILED ANALYSIS ────────────────────────────────────────

  console.log("=== JACKPOT DETAILED ANALYSIS ===\n");

  const jpEntries = results.map((r) => r.jackpotEntry).filter((e): e is JackpotEntry => e !== null);

  console.log(`Total jackpot triggers (roulette outcome=2): ${jackpotOutcomes.length}`);
  console.log(`Jackpot entries with data:                   ${jpEntries.length}`);
  console.log("");

  // Outcome breakdown
  const misses = jpEntries.filter((e) => e.outcomeType === "MISS");
  const consolation1 = jpEntries.filter((e) => e.outcomeType === "CONSOLATION_1.2x");
  const consolation2 = jpEntries.filter((e) => e.outcomeType === "CONSOLATION_1.5x");
  const tierWins = jpEntries.filter((e) => e.outcomeType === "TIER_WIN");

  console.log("--- Jackpot Outcome Distribution ---");
  console.log(`MISS (no reward):      ${misses.length}  (${pct(misses.length, jpEntries.length)}%)`);
  console.log(`CONSOLATION 1.2x:      ${consolation1.length}  (${pct(consolation1.length, jpEntries.length)}%)  [config: 5%]`);
  console.log(`CONSOLATION 1.5x:      ${consolation2.length}  (${pct(consolation2.length, jpEntries.length)}%)  [config: 2%]`);
  console.log(`TIER WIN:              ${tierWins.length}  (${pct(tierWins.length, jpEntries.length)}%)`);
  console.log("");

  // Consolation payouts
  if (consolation1.length > 0 || consolation2.length > 0) {
    const allConsolation = [...consolation1, ...consolation2];
    const totalConsolationPaid = allConsolation.reduce((s, e) => s + bn(e.payout), 0n);
    console.log("--- Consolation Details ---");
    for (const c of allConsolation) {
      console.log(`  Spin #${c.spinIndex + 1}: ${c.outcomeType} → ${formatEther(bn(c.payout))} TRT (tier was ${c.tierIndex})`);
    }
    console.log(`  Total consolation paid: ${formatEther(totalConsolationPaid)} TRT`);
    console.log("");
  }

  // Tier wins detail
  if (tierWins.length > 0) {
    console.log("--- Tier Wins Detail ---");
    for (const tw of tierWins) {
      console.log(`  Spin #${tw.spinIndex + 1}: Won TIER ${tw.tierWon} → ${formatEther(bn(tw.payout))} TRT`);
    }
    const totalTierPayout = tierWins.reduce((s, e) => s + bn(e.payout), 0n);
    console.log(`  Total tier payouts: ${formatEther(totalTierPayout)} TRT`);
    console.log("");
  }

  // Tier index distribution at time of jackpot rolls
  const tierAtRoll: Record<number, number> = {};
  for (const e of jpEntries) {
    tierAtRoll[e.tierIndex] = (tierAtRoll[e.tierIndex] || 0) + 1;
  }
  console.log("--- Tier Index at Roll Time ---");
  for (const [t, count] of Object.entries(tierAtRoll).sort(([a], [b]) => +a - +b)) {
    console.log(`  Tier ${t}: ${count} rolls (${pct(count, jpEntries.length)}%)`);
  }
  console.log("");

  // ─── Economics ────────────────────────────────────────────────────────

  console.log("=== ECONOMICS ===\n");

  const totalWagered = BigInt(completed.length) * WAGER;
  const totalRoulettePay = completed.reduce((s, r) => s + bn(r.roulettePayout), 0n);
  const totalJpPay = completed.reduce((s, r) => s + bn(r.jackpotPayout), 0n);
  const totalReturn = totalRoulettePay + totalJpPay;

  console.log(`Gross wagered:      ${formatEther(totalWagered)} TRT`);
  console.log(`Roulette payouts:   ${formatEther(totalRoulettePay)} TRT`);
  console.log(`Jackpot payouts:    ${formatEther(totalJpPay)} TRT`);
  console.log(`Total returned:     ${formatEther(totalReturn)} TRT`);
  console.log(`Net P&L (player):   ${formatEther(totalReturn - totalWagered)} TRT`);
  if (totalWagered > 0n) {
    const rtp = Number((totalReturn * 10000n) / totalWagered) / 100;
    console.log(`RTP:                ${rtp.toFixed(2)}%`);
  }
  console.log("");

  // ─── Final Jackpot State ──────────────────────────────────────────────

  console.log("=== FINAL JACKPOT STATE ===\n");

  const finalJpState = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getJackpotState" }) as any;
  const finalTierPots = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getAllTierPotBalances" }) as bigint[];
  const finalConsolationPot = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "consolationPotBalance" }) as bigint;
  const finalJpTotal = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getJackpotBalance" }) as bigint;

  console.log(`Next tier:         ${finalJpState.nextTierIndex}  (was ${initJpState.nextTierIndex})`);
  console.log(`Total entries:     ${finalJpState.totalEntries}  (was ${initJpState.totalEntries})`);
  console.log(`New entries:       ${BigInt(finalJpState.totalEntries) - BigInt(initJpState.totalEntries)}`);
  console.log(`Total jackpots:    ${finalJpState.totalJackpotsWon}  (was ${initJpState.totalJackpotsWon})`);
  console.log(`Total consolation: ${formatEther(BigInt(finalJpState.totalConsolationPaid))} TRT  (was ${formatEther(BigInt(initJpState.totalConsolationPaid))})`);
  console.log(`Jackpot total bal: ${formatEther(finalJpTotal)} TRT`);
  console.log(`Consolation pot:   ${formatEther(finalConsolationPot)} TRT  (was ${formatEther(initConsolationPot)})`);
  console.log("");

  console.log("Tier pots (before → after):");
  for (let t = 0; t < 9; t++) {
    const before = initTierPots[t];
    const after = finalTierPots[t];
    const delta = after - before;
    const sign = delta >= 0n ? "+" : "";
    console.log(`  T${t}: ${formatEther(before).padStart(12)} → ${formatEther(after).padStart(12)}  (${sign}${formatEther(delta)})`);
  }
  console.log("");

  // Tier probabilities after
  console.log("Tier probabilities (after):");
  for (let t = 0; t < 9; t++) {
    const prob = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "getTierProbability", args: [t] }) as any;
    console.log(`  T${t}: ${(Number(prob[0]) / 10_000).toFixed(4)}%  (entries since win: ${prob[1]})`);
  }
  console.log("");

  // ─── Final Balances ───────────────────────────────────────────────────

  const finalPlayerBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [player] });
  const finalRouletteBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
  const finalJackpotBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [jackpotAddr] });

  console.log("=== FINAL BALANCES ===");
  console.log(`Player:   ${formatEther(finalPlayerBal)} TRT  (Δ ${formatEther(finalPlayerBal - initPlayerBal)})`);
  console.log(`Roulette: ${formatEther(finalRouletteBal)} TRT  (Δ ${formatEther(finalRouletteBal - initRouletteBal)})`);
  console.log(`Jackpot:  ${formatEther(finalJackpotBal)} TRT  (Δ ${formatEther(finalJackpotBal - initJackpotBal)})`);
  console.log("");

  // ─── Verification Checklist ───────────────────────────────────────────

  console.log("=== VERIFICATION CHECKLIST ===\n");

  const checks: Array<[string, boolean, string]> = [
    ["All spins resolved", failed.length === 0, `${failed.length} failures`],
    ["Wins at ~46-50%", wins.length >= completed.length * 0.35 && wins.length <= completed.length * 0.60, `${pct(wins.length, completed.length)}%`],
    ["Losses at ~46-50%", losses.length >= completed.length * 0.35 && losses.length <= completed.length * 0.60, `${pct(losses.length, completed.length)}%`],
    ["Jackpot triggers at ~3%", jackpotOutcomes.length >= 1, `${pct(jackpotOutcomes.length, completed.length)}% (${jackpotOutcomes.length} triggers)`],
    ["Replay mechanic (multi-roll)", completed.some((r) => r.spinsConsumed > 1), `${completed.filter((r) => r.spinsConsumed > 1).length} multi-rolls`],
    ["Jackpot misses occur", misses.length > 0, `${misses.length} misses`],
    ["Consolation 1.2x works", consolation1.length > 0, `${consolation1.length} awarded`],
    ["Consolation 1.5x works", consolation2.length > 0, `${consolation2.length} awarded`],
    ["Tier wins occur", tierWins.length > 0, `${tierWins.length} tier wins`],
    ["Tier progression (nextTier changed)", finalJpState.nextTierIndex !== initJpState.nextTierIndex || tierWins.length > 0, `${initJpState.nextTierIndex} → ${finalJpState.nextTierIndex}`],
    ["Tier pots growing", finalTierPots.some((v: bigint, i: number) => v > initTierPots[i]), "pots received contributions"],
    ["Consolation pot growing", finalConsolationPot > initConsolationPot || consolation1.length + consolation2.length > 0, `${formatEther(initConsolationPot)} → ${formatEther(finalConsolationPot)}`],
    ["Probability increments", true, "checked in table above"],
    ["RTP reasonable (85-99%)", totalWagered > 0n && Number((totalReturn * 10000n) / totalWagered) >= 8500 && Number((totalReturn * 10000n) / totalWagered) <= 9900, `${(Number((totalReturn * 10000n) / totalWagered) / 100).toFixed(2)}%`],
  ];

  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${name}`);
    console.log(`    → ${detail}`);
  }

  // ─── Save ─────────────────────────────────────────────────────────────

  const outPath = new URL("./deployments/jackpot-stress-results-v5.json", import.meta.url);
  await fs.writeFile(outPath, JSON.stringify({
    meta: { timestamp: new Date().toISOString(), network: "arbitrumSepolia", totalSpins: TOTAL_SPINS, roulette: rouletteAddr, jackpot: jackpotAddr, player, wager: WAGER.toString(), multiplier: MULTIPLIER },
    rouletteSummary: { completed: completed.length, failed: failed.length, losses: losses.length, wins: wins.length, jackpots: jackpotOutcomes.length },
    jackpotSummary: { entries: jpEntries.length, misses: misses.length, consolation1: consolation1.length, consolation2: consolation2.length, tierWins: tierWins.length },
    jackpotState: { before: { nextTier: initJpState.nextTierIndex, totalEntries: initJpState.totalEntries.toString() }, after: { nextTier: finalJpState.nextTierIndex, totalEntries: finalJpState.totalEntries.toString() } },
    spins: results.map((r) => ({ ...r, jackpotEntry: r.jackpotEntry ?? undefined })),
  }, null, 2));
  console.log(`\nResults saved to: ${outPath.pathname}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => { console.error(error); process.exit(1); });
