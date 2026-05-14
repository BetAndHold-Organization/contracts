import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const TOKEN = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as Addr;
const AMOUNT_PER_WINNER = parseEther("5");

const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

const WINNERS: Addr[] = [
  "0x11a33c3895e589c56984da0c50629e9f43feff3b",
  "0x0604baa606e0d3ea112fe38bc5356ab96913980f",
  "0x182923f85f1485f931a830f83ef4a0b36ff4e2e2",
  "0xcf5349a36457ce5ae4bf4e5dae72a355c6bf5bf5",
  "0xb364f0c221d8e7a2353568118c3d40e911f7cc53",
  "0xb55b122495aecc8da5aee034e93367afa833ac72",
  "0xfbfd829a0acf02ac393ebe06136c17b67bc58a4c",
  "0x1cfe5ef0ece8a363244a51bc99a6681d8af170cc",
  "0x394ecd123435e8970d88c89192fc83d6ae52aeb8",
  "0xdc17d456a9b1a91e8eacf8c035aef986e5d31310",
];

const CSV_DIR = new URL("./deployments/", import.meta.url);
const CSV_FILE = "airdrop-lottery-36h-winners.csv";

type Result = { recipient: string; amount: string; status: string; txHash: string };

function buildCsv(rows: Result[]): string {
  const header = "recipient,amount_eva,status,tx_hash";
  const lines = rows.map((r) => `${r.recipient},${r.amount},${r.status},${r.txHash}`);
  return [header, ...lines].join("\n") + "\n";
}

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();

  const totalAmount = AMOUNT_PER_WINNER * BigInt(WINNERS.length);
  const amountStr = formatEther(AMOUNT_PER_WINNER);

  console.log("══════════════════════════════════════════════════════════════");
  console.log(DRY_RUN
    ? "  LOTTERY 36H WINNER AIRDROP — DRY RUN"
    : "  LOTTERY 36H WINNER AIRDROP — LIVE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Token:            ", TOKEN);
  console.log("  Amount per winner:", amountStr, "EVA");
  console.log("  Winners:          ", WINNERS.length);
  console.log("  Total to send:    ", formatEther(totalAmount), "EVA");
  console.log("");

  const token = await viem.getContractAt("EverValueCoin", TOKEN);
  const balance = await token.read.balanceOf([deployer.account.address]);
  const ethBalance = await pub.getBalance({ address: deployer.account.address });

  console.log("  Deployer EVA:     ", formatEther(balance));
  console.log("  Deployer ETH:     ", formatEther(ethBalance));
  console.log("");

  if (balance < totalAmount) {
    console.error("  INSUFFICIENT BALANCE. Need", formatEther(totalAmount), "EVA, have", formatEther(balance));
    process.exit(1);
  }
  console.log("  ✓ Sufficient EVA balance");
  console.log("");

  console.log("─── RECIPIENTS ───");
  for (let i = 0; i < WINNERS.length; i++) {
    console.log(`  ${String(i + 1).padStart(2)}. ${WINNERS[i]}  →  ${amountStr} EVA`);
  }
  console.log("");

  if (DRY_RUN) {
    const rows: Result[] = WINNERS.map((w) => ({
      recipient: w, amount: amountStr, status: "pending", txHash: "",
    }));
    await fs.mkdir(CSV_DIR, { recursive: true });
    const csvPath = new URL(CSV_FILE, CSV_DIR);
    await fs.writeFile(csvPath, buildCsv(rows));

    console.log("══════════════════════════════════════════════════════════════");
    console.log("  DRY RUN COMPLETE — no transactions sent");
    console.log("══════════════════════════════════════════════════════════════");
    console.log("  CSV preview saved:", csvPath.pathname);
    console.log("");
    console.log("  To execute for real:");
    console.log('  $env:DRY_RUN="false"; npx hardhat run scripts/mainnet/airdrop-lottery-36h-winners.ts --network arbitrum');
    console.log("");
    return;
  }

  console.log("─── SENDING ───");
  const rows: Result[] = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < WINNERS.length; i++) {
    const recipient = WINNERS[i];
    try {
      const tx = await token.write.transfer(
        [recipient, AMOUNT_PER_WINNER],
        { account: deployer.account },
      );
      await pub.waitForTransactionReceipt({ hash: tx });
      success++;
      rows.push({ recipient, amount: amountStr, status: "success", txHash: tx });
      console.log(`  [${String(i + 1).padStart(2)}/${WINNERS.length}] ✓ ${recipient}`);
    } catch (e: any) {
      failed++;
      rows.push({ recipient, amount: amountStr, status: "failed", txHash: "" });
      console.error(`  [${String(i + 1).padStart(2)}/${WINNERS.length}] ✗ ${recipient} — ${e?.shortMessage || e?.message}`);
    }
  }

  await fs.mkdir(CSV_DIR, { recursive: true });
  const csvPath = new URL(CSV_FILE, CSV_DIR);
  await fs.writeFile(csvPath, buildCsv(rows));

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  AIRDROP COMPLETE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Successful:", success);
  console.log("  Failed:    ", failed);
  console.log("  EVA sent:  ", formatEther(AMOUNT_PER_WINNER * BigInt(success)));
  console.log("  CSV saved: ", csvPath.pathname);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
