import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const DEPLOYMENT_PATH = new URL("deployments/arb-mainnet-v5.json", import.meta.url);
const CSV_PATH = new URL("../seedReffers/referral-pending-rewards-2026-04-08.csv", import.meta.url);

const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

interface Recipient {
  address: Addr;
  amountWei: bigint;
  amountEva: string;
}

async function main() {
  const deployment = JSON.parse(await fs.readFile(DEPLOYMENT_PATH, "utf-8"));
  const TOKEN: Addr = deployment.token as Addr;

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(DRY_RUN ? "  AIRDROP PENDING REWARDS (2x) — DRY RUN" : "  AIRDROP PENDING REWARDS (2x) — LIVE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Network: ", await publicClient.getChainId());
  console.log("Deployer:", deployer.account.address);
  console.log("Token:   ", TOKEN);
  console.log("");

  // Parse CSV
  const raw = (await fs.readFile(CSV_PATH, "utf-8")).trim().split("\n");
  const header = raw[0];
  if (!header.startsWith("referrer,pending_wei")) {
    throw new Error(`Unexpected CSV header: ${header}`);
  }

  const recipients: Recipient[] = [];
  const skipped: { address: string; reason: string }[] = [];

  for (let i = 1; i < raw.length; i++) {
    const cols = raw[i].split(",");
    if (cols.length < 3) {
      skipped.push({ address: `row ${i}`, reason: "malformed row" });
      continue;
    }

    const address = cols[0].trim().toLowerCase() as Addr;
    const pendingWei = cols[1].trim();
    const pendingEva = cols[2].trim();

    if (address === "0x0000000000000000000000000000000000000000") {
      skipped.push({ address, reason: "zero address" });
      continue;
    }
    if (!address.startsWith("0x") || address.length !== 42) {
      skipped.push({ address, reason: "invalid address" });
      continue;
    }

    const baseAmount = BigInt(pendingWei);
    if (baseAmount === 0n) {
      skipped.push({ address, reason: "zero pending" });
      continue;
    }

    const amount = baseAmount * 2n;
    recipients.push({ address, amountWei: amount, amountEva: formatEther(amount) });
  }

  // Summary
  const totalWei = recipients.reduce((sum, r) => sum + r.amountWei, 0n);
  console.log(`Recipients with pending rewards: ${recipients.length}`);
  console.log(`Skipped (zero/invalid):          ${skipped.length}`);
  console.log(`Total to airdrop:                ${formatEther(totalWei)} EVA`);
  console.log("");

  // Show per-recipient breakdown
  console.log("─── Recipient Breakdown ───");
  for (const r of recipients) {
    console.log(`  ${r.address}  →  ${r.amountEva} EVA  (${r.amountWei} wei)`);
  }
  console.log("");

  if (skipped.length > 0) {
    console.log("─── Skipped ───");
    for (const s of skipped) {
      console.log(`  ${s.address}  — ${s.reason}`);
    }
    console.log("");
  }

  // Check deployer EVA balance
  const token = await viem.getContractAt("EverValueCoin", TOKEN);
  const balance: bigint = await token.read.balanceOf([deployer.account.address]);
  console.log(`Deployer EVA balance: ${formatEther(balance)} EVA`);

  if (balance < totalWei) {
    console.error(`\n  INSUFFICIENT BALANCE: need ${formatEther(totalWei)} but have ${formatEther(balance)}`);
    if (!DRY_RUN) {
      process.exit(1);
    } else {
      console.log("  (dry run — continuing anyway)\n");
    }
  } else {
    console.log(`  Balance sufficient ✓\n`);
  }

  if (DRY_RUN) {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  DRY RUN COMPLETE — no transfers executed");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`Would transfer ${formatEther(totalWei)} EVA to ${recipients.length} addresses`);
    return;
  }

  // Live execution
  console.log("Starting transfers...\n");
  let successCount = 0;
  let failCount = 0;
  let totalGas = 0n;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    console.log(`[${i + 1}/${recipients.length}] ${r.address}  →  ${r.amountEva} EVA`);

    try {
      const tx = await token.write.transfer(
        [r.address, r.amountWei],
        { account: deployer.account },
      );
      console.log(`  TX: ${tx}`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      totalGas += receipt.gasUsed;
      console.log(`  Confirmed block ${receipt.blockNumber}  gas=${receipt.gasUsed}`);
      successCount++;
    } catch (err: any) {
      console.error(`  FAILED: ${err.shortMessage ?? err.message}`);
      failCount++;
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  AIRDROP COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Successful: ${successCount}`);
  console.log(`Failed:     ${failCount}`);
  console.log(`Total gas:  ${totalGas}`);
  console.log(`Total sent: ${formatEther(recipients.reduce((s, r) => s + r.amountWei, 0n))} EVA`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
