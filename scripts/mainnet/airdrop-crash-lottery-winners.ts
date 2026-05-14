import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const TOKEN = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as Addr;
const AMOUNT_PER_WINNER = parseEther("5");

const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

const WINNERS: Addr[] = [
  "0x88db7645a43f59611e9983d13c46886b17cd9ba0",
  "0x4f3942d58d1058e39a8fb39efa1f11d5d9d945a3",
  "0x9f157d563fbf376f90fe8b3452507649a2d6a38f",
  "0x4402340196da28ac48608ac996d229ae78fb3f2e",
  "0xc86efeb23e102b927b07073ca8bf4ad9c9e518e6",
];

const CSV_DIR = new URL("./deployments/", import.meta.url);
const CSV_FILE = "airdrop-crash-lottery-winners.csv";

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
    ? "  CRASH LOTTERY WINNER AIRDROP — DRY RUN"
    : "  CRASH LOTTERY WINNER AIRDROP — LIVE");
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
    console.log('  $env:DRY_RUN="false"; npx hardhat run scripts/mainnet/airdrop-crash-lottery-winners.ts --network arbitrum');
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
