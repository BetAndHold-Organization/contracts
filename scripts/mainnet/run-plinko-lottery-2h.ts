import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

const CSV_FILE = "../../contracts/plinko-tickets-2h-2026-04-29T21-04-38.csv";
const NUM_WINNERS = 10;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MINUTES = 10;

interface PlayerEntry {
  wallet: Addr;
  tickets: bigint;
}

function parseCsv(raw: string): PlayerEntry[] {
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0].split(",");

  const iPlayer = header.indexOf("player");
  const iTickets = header.indexOf("tickets");
  if (iPlayer < 0 || iTickets < 0) throw new Error("CSV missing 'player' or 'tickets' column");

  const entries: PlayerEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const wallet = cols[iPlayer].trim().toLowerCase() as Addr;
    const tickets = BigInt(cols[iTickets].trim());
    if (tickets <= 0n) continue;
    entries.push({ wallet, tickets });
  }
  return entries;
}

const LOTTERY_ABI = [
  {
    type: "function", name: "requestWinners", stateMutability: "nonpayable",
    inputs: [
      { name: "players", type: "address[]" },
      { name: "tickets", type: "uint256[]" },
      { name: "numWinners", type: "uint8" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    type: "function", name: "isLotteryFulfilled", stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "getLotteryResult", stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [
      { name: "winners", type: "address[]" },
      { name: "randomWord", type: "uint256" },
      { name: "players", type: "address[]" },
      { name: "tickets", type: "uint256[]" },
      { name: "totalTickets", type: "uint256" },
    ],
  },
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // ─── Load lottery address ────────────────────────────────────────────
  let LOTTERY_ADDRESS: Addr;
  if (process.env.LOTTERY_ADDRESS) {
    LOTTERY_ADDRESS = process.env.LOTTERY_ADDRESS.trim() as Addr;
  } else {
    const deployJson = await fs.readFile(
      new URL("./deployments/lottery-mainnet.json", import.meta.url), "utf-8",
    );
    LOTTERY_ADDRESS = JSON.parse(deployJson).lottery as Addr;
  }

  // ─── Load & parse CSV ───────────────────────────────────────────────
  const csvRaw = await fs.readFile(new URL(CSV_FILE, import.meta.url), "utf-8");
  const entries = parseCsv(csvRaw);
  if (entries.length === 0) throw new Error("CSV is empty or malformed");
  if (entries.length < NUM_WINNERS) throw new Error(`Only ${entries.length} players but need ${NUM_WINNERS} winners`);

  const players = entries.map((e) => e.wallet);
  const tickets = entries.map((e) => e.tickets);
  const totalTickets = tickets.reduce((a, b) => a + b, 0n);

  // ─── Connect ────────────────────────────────────────────────────────
  const conn = await network.connect();
  const [deployer] = await conn.viem.getWalletClients();
  const pub = await conn.viem.getPublicClient();

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  PLINKO LOTTERY 2H — 10 WINNERS");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Lottery contract: ", LOTTERY_ADDRESS);
  console.log("  Deployer:         ", deployer.account.address);
  console.log("  Players:          ", entries.length);
  console.log("  Total tickets:    ", totalTickets.toString());
  console.log("  Winners requested:", NUM_WINNERS);
  console.log("");

  for (let i = 0; i < entries.length; i++) {
    const pct = Number(entries[i].tickets * 10000n / totalTickets) / 100;
    console.log(`  ${String(i + 1).padStart(3)}. ${entries[i].wallet}  ${String(entries[i].tickets).padStart(5)} tix  (${pct.toFixed(2)}%)`);
  }
  console.log("");

  // ─── Send requestWinners tx ─────────────────────────────────────────
  console.log("─── Sending requestWinners transaction... ───\n");

  const txHash = await deployer.writeContract({
    address: LOTTERY_ADDRESS,
    abi: LOTTERY_ABI,
    functionName: "requestWinners",
    args: [players, tickets, NUM_WINNERS],
  });

  console.log("  TX Hash:  ", txHash);

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  console.log("  Block:    ", receipt.blockNumber.toString());
  console.log("  Gas used: ", receipt.gasUsed.toString());

  // ─── Extract requestId from logs (topic[1] of LotteryRequested) ────
  let requestId: bigint | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== LOTTERY_ADDRESS.toLowerCase()) continue;
    if (log.topics.length >= 2) {
      requestId = BigInt(log.topics[1]!);
      break;
    }
  }
  if (requestId === undefined) throw new Error("Could not extract requestId from logs");

  console.log("  Request ID:", requestId.toString());
  console.log("");

  // ─── Poll for VRF fulfillment ──────────────────────────────────────
  console.log("─── Waiting for Chainlink VRF fulfillment... ───\n");
  console.log(`  (polling every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_POLL_MINUTES} minutes)\n`);

  const start = Date.now();
  const deadline = start + MAX_POLL_MINUTES * 60_000;
  let fulfilled = false;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount++;
    fulfilled = await pub.readContract({
      address: LOTTERY_ADDRESS, abi: LOTTERY_ABI,
      functionName: "isLotteryFulfilled", args: [requestId],
    }) as boolean;

    if (fulfilled) break;

    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`  Poll #${pollCount} (${elapsed}s elapsed) — waiting...\r`);
    await sleep(POLL_INTERVAL_MS);
  }

  if (!fulfilled) {
    console.log("\n\n  VRF not fulfilled within", MAX_POLL_MINUTES, "minutes.");
    console.log("  Request ID:", requestId.toString());
    console.log("  Check https://vrf.chain.link for status.");
    return;
  }

  console.log("  FULFILLED!                                    ");
  console.log("");

  // ─── Fetch & display results ───────────────────────────────────────
  const result = await pub.readContract({
    address: LOTTERY_ADDRESS, abi: LOTTERY_ABI,
    functionName: "getLotteryResult", args: [requestId],
  }) as [string[], bigint, string[], bigint[], bigint];

  const [winners, randomWord, , , totalTix] = result;

  const ticketMap = new Map<string, bigint>();
  for (let i = 0; i < players.length; i++) {
    ticketMap.set(players[i].toLowerCase(), tickets[i]);
  }

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  LOTTERY RESULTS");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  TX Hash:       ", txHash);
  console.log("  Request ID:    ", requestId.toString());
  console.log("  Random Word:   ", randomWord.toString());
  console.log("  Total Tickets: ", totalTix.toString());
  console.log("");
  console.log("  WINNERS:");
  console.log("  ─────────────────────────────────────────────────────────");

  for (let i = 0; i < winners.length; i++) {
    const addr = winners[i].toLowerCase();
    const tix = ticketMap.get(addr) ?? 0n;
    const pct = Number(tix * 10000n / totalTix) / 100;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${addr}  (${tix.toString().padStart(5)} tix, ${pct.toFixed(2)}%)`,
    );
  }
  console.log("");

  // ─── Save results to JSON ──────────────────────────────────────────
  const resultData = {
    lottery: LOTTERY_ADDRESS,
    csv: CSV_FILE,
    txHash,
    requestId: requestId.toString(),
    randomWord: randomWord.toString(),
    totalTickets: totalTix.toString(),
    playerCount: entries.length,
    numWinners: NUM_WINNERS,
    executedAt: new Date().toISOString(),
    winners: winners.map((w, i) => ({
      rank: i + 1,
      address: w.toLowerCase(),
      tickets: Number(ticketMap.get(w.toLowerCase()) ?? 0n),
      percentChance: Number((ticketMap.get(w.toLowerCase()) ?? 0n) * 10000n / totalTix) / 100,
    })),
  };

  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const resultPath = new URL("lottery-plinko-2h-result.json", deploymentsDir);
  await fs.writeFile(resultPath, JSON.stringify(resultData, null, 2));
  console.log("  Result saved:", resultPath.pathname);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
