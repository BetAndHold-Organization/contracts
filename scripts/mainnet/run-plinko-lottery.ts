import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════════
// PLINKO LOTTERY — Run a 10-winner draw from plinko_tickets CSV
// Reads player/ticket data, calls requestWinners, polls for VRF fulfillment,
// and prints txHash, requestId, and full results.
// ═══════════════════════════════════════════════════════════════════════════

const NUM_WINNERS = 10;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MINUTES = 10;

// ─── CSV parser ──────────────────────────────────────────────────────────

interface PlayerEntry {
  wallet: Addr;
  tickets: bigint;
}

function parseCsv(raw: string): PlayerEntry[] {
  const lines = raw.trim().split(/\r?\n/);
  const entries: PlayerEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 3) continue;

    const wallet = cols[0].trim().toLowerCase() as Addr;
    const range = cols[2].trim();
    const [startStr, endStr] = range.split("-");
    const ticketCount = BigInt(endStr) - BigInt(startStr) + 1n;

    entries.push({ wallet, tickets: ticketCount });
  }

  return entries;
}

// ─── ABI fragments ───────────────────────────────────────────────────────

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
  {
    type: "event", name: "LotteryRequested",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "totalTickets", type: "uint256", indexed: false },
      { name: "numWinners", type: "uint8", indexed: false },
      { name: "playerCount", type: "uint256", indexed: false },
    ],
  },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ─── Load lottery address ────────────────────────────────────────────
  let LOTTERY_ADDRESS = (process.env.LOTTERY_ADDRESS || "").trim() as Addr;

  if (!LOTTERY_ADDRESS) {
    try {
      const deployJson = await fs.readFile(
        new URL("./deployments/lottery-mainnet.json", import.meta.url),
        "utf-8",
      );
      const deploy = JSON.parse(deployJson);
      LOTTERY_ADDRESS = deploy.lottery as Addr;
    } catch {
      throw new Error(
        "Set LOTTERY_ADDRESS env var or deploy first (lottery-mainnet.json not found)",
      );
    }
  }

  // ─── Load CSV ────────────────────────────────────────────────────────
  const csvPath = new URL("../../contracts/plinko_tickets (2).csv", import.meta.url);
  const csvRaw = await fs.readFile(csvPath, "utf-8");
  const entries = parseCsv(csvRaw);

  if (entries.length === 0) throw new Error("CSV is empty or malformed");

  const players = entries.map((e) => e.wallet);
  const tickets = entries.map((e) => e.tickets);
  const totalTickets = tickets.reduce((a, b) => a + b, 0n);

  // ─── Connect ─────────────────────────────────────────────────────────
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  PLINKO LOTTERY — 10 WINNERS");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Lottery contract: ", LOTTERY_ADDRESS);
  console.log("  Deployer:         ", deployer.account.address);
  console.log("  Players:          ", entries.length);
  console.log("  Total tickets:    ", totalTickets.toString());
  console.log("  Winners requested:", NUM_WINNERS);
  console.log("");

  // ─── Send requestWinners tx ──────────────────────────────────────────
  console.log("─── Sending requestWinners transaction... ───\n");

  const txHash = await deployer.writeContract({
    address: LOTTERY_ADDRESS,
    abi: LOTTERY_ABI,
    functionName: "requestWinners",
    args: [players, tickets, NUM_WINNERS],
  });

  console.log("  TX Hash:          ", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("  Block:            ", receipt.blockNumber.toString());
  console.log("  Gas used:         ", receipt.gasUsed.toString());

  // ─── Extract requestId from LotteryRequested event ───────────────────
  const requestedTopic = "0x" + Buffer.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("not-used"),
      ),
    ),
  ).toString("hex");

  // Parse logs manually — the requestId is the first indexed topic (topic[1])
  const LOTTERY_REQUESTED_SIGNATURE =
    "0xb8e57e01e9f738b1f3be5ae3e25129f36cd51689000000000000000000000000";

  let requestId: bigint | undefined;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== LOTTERY_ADDRESS.toLowerCase()) continue;
    if (log.topics.length >= 2) {
      requestId = BigInt(log.topics[1]!);
      break;
    }
  }

  if (requestId === undefined) {
    throw new Error("Could not extract requestId from transaction logs");
  }

  console.log("  Request ID:       ", requestId.toString());
  console.log("");

  // ─── Poll for VRF fulfillment ────────────────────────────────────────
  console.log("─── Waiting for Chainlink VRF fulfillment... ───\n");
  console.log("  (polling every", POLL_INTERVAL_MS / 1000, "seconds, max", MAX_POLL_MINUTES, "minutes)\n");

  const deadline = Date.now() + MAX_POLL_MINUTES * 60 * 1000;
  let fulfilled = false;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount++;
    fulfilled = await publicClient.readContract({
      address: LOTTERY_ADDRESS,
      abi: LOTTERY_ABI,
      functionName: "isLotteryFulfilled",
      args: [requestId],
    }) as boolean;

    if (fulfilled) break;

    const elapsed = Math.round((Date.now() - (deadline - MAX_POLL_MINUTES * 60 * 1000)) / 1000);
    process.stdout.write(`  Poll #${pollCount} (${elapsed}s elapsed) — not yet fulfilled\r`);
    await sleep(POLL_INTERVAL_MS);
  }

  if (!fulfilled) {
    console.log("\n");
    console.log("  VRF not fulfilled within", MAX_POLL_MINUTES, "minutes.");
    console.log("  Request ID:", requestId.toString());
    console.log("  Check https://vrf.chain.link for status.");
    console.log("  Once fulfilled, query the result with:");
    console.log("    getLotteryResult(" + requestId.toString() + ")");
    return;
  }

  console.log("  FULFILLED!                                    ");
  console.log("");

  // ─── Fetch results ──────────────────────────────────────────────────
  const result = await publicClient.readContract({
    address: LOTTERY_ADDRESS,
    abi: LOTTERY_ABI,
    functionName: "getLotteryResult",
    args: [requestId],
  }) as [string[], bigint, string[], bigint[], bigint];

  const [winners, randomWord, , ticketsArr, totalTix] = result;

  // Build a lookup: address → tickets for display
  const ticketMap = new Map<string, bigint>();
  for (let i = 0; i < players.length; i++) {
    ticketMap.set(players[i].toLowerCase(), tickets[i]);
  }

  // ─── Print results ──────────────────────────────────────────────────
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
  console.log("  ─────────────────────────────────────────────────────");

  for (let i = 0; i < winners.length; i++) {
    const addr = winners[i].toLowerCase();
    const tix = ticketMap.get(addr) ?? 0n;
    const pct = Number(tix * 10000n / totalTix) / 100;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${addr}  (${tix.toString().padStart(4)} tickets, ${pct.toFixed(2)}%)`,
    );
  }

  console.log("");

  // ─── Save results to JSON ───────────────────────────────────────────
  const resultData = {
    lottery: LOTTERY_ADDRESS,
    txHash,
    requestId: requestId.toString(),
    randomWord: randomWord.toString(),
    totalTickets: totalTix.toString(),
    playerCount: players.length,
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
  const resultPath = new URL("lottery-plinko-result.json", deploymentsDir);
  await fs.writeFile(resultPath, JSON.stringify(resultData, null, 2));
  console.log("  Result saved:  ", resultPath.pathname);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
