import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

const DEPLOYMENT_PATH = new URL("deployments/arb-mainnet-v5.json", import.meta.url);

const BATCH_SIZE = 50;

async function main() {
  const deployment = JSON.parse(await fs.readFile(DEPLOYMENT_PATH, "utf-8"));
  const REFERRAL_CONTRACT = deployment.referral as Addr;

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SEEDING REFERRALS FOR V5");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Network:          ", (await publicClient.getChainId()));
  console.log("Deployer:         ", deployer.account.address);
  console.log("Referral contract:", REFERRAL_CONTRACT);
  console.log("");

  // Load merged CSV
  const csvPath = new URL("../seedReffers/merged-referral-tree-v5.csv", import.meta.url);
  const raw = (await fs.readFile(csvPath, "utf-8")).trim().split("\n");

  const header = raw[0];
  if (!header.startsWith("player,referrer")) {
    throw new Error(`Unexpected CSV header: ${header}`);
  }

  const allPlayers: Addr[] = [];
  const allReferrers: Addr[] = [];

  for (let i = 1; i < raw.length; i++) {
    const cols = raw[i].split(",");
    if (cols.length < 2) continue;
    const player = cols[0].trim().toLowerCase() as Addr;
    const referrer = cols[1].trim().toLowerCase() as Addr;
    if (!player.startsWith("0x") || !referrer.startsWith("0x")) {
      console.warn(`  Skipping invalid row ${i}: ${raw[i]}`);
      continue;
    }
    allPlayers.push(player);
    allReferrers.push(referrer);
  }

  console.log(`Loaded ${allPlayers.length} relationships from CSV`);

  // Get referral contract
  const referral = await viem.getContractAt("MultiLevelReferral", REFERRAL_CONTRACT);

  // Pre-check: filter out already-set relationships
  console.log("\nChecking existing referrers on-chain...");
  const playersToSet: Addr[] = [];
  const referrersToSet: Addr[] = [];
  let alreadySet = 0;
  let mismatch = 0;

  for (let i = 0; i < allPlayers.length; i++) {
    try {
      const existing = await referral.read.referrerOf([allPlayers[i]]);
      if (existing !== "0x0000000000000000000000000000000000000000") {
        alreadySet++;
        if (existing.toLowerCase() !== allReferrers[i].toLowerCase()) {
          mismatch++;
          console.warn(`  MISMATCH: ${allPlayers[i]} on-chain=${existing}, csv=${allReferrers[i]}`);
        }
        continue;
      }
    } catch {
      // If read fails, assume not set
    }
    playersToSet.push(allPlayers[i]);
    referrersToSet.push(allReferrers[i]);

    if ((i + 1) % 100 === 0) {
      console.log(`  Checked ${i + 1}/${allPlayers.length}...`);
    }
  }

  console.log(`\nAlready set on-chain: ${alreadySet} (mismatches: ${mismatch})`);
  console.log(`Remaining to seed:    ${playersToSet.length}`);

  if (playersToSet.length === 0) {
    console.log("\nAll referrals already seeded!");
    return;
  }

  // Batch execution
  const totalBatches = Math.ceil(playersToSet.length / BATCH_SIZE);
  console.log(`\nProcessing ${playersToSet.length} relationships in ${totalBatches} batch(es) of ${BATCH_SIZE}...\n`);

  let totalGas = 0n;

  for (let b = 0; b < totalBatches; b++) {
    const start = b * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, playersToSet.length);
    const batchPlayers = playersToSet.slice(start, end);
    const batchReferrers = referrersToSet.slice(start, end);

    console.log(`Batch ${b + 1}/${totalBatches}  (${batchPlayers.length} entries, rows ${start + 1}–${end})`);

    try {
      const tx = await referral.write.adminSetReferrers(
        [batchPlayers, batchReferrers],
        { account: deployer.account }
      );
      console.log(`  TX: ${tx}`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      totalGas += receipt.gasUsed;
      console.log(`  Confirmed block ${receipt.blockNumber}  gas=${receipt.gasUsed}`);
    } catch (err: any) {
      console.error(`  FAILED at batch ${b + 1}:`, err.shortMessage ?? err.message);
      console.error(`  First player in failed batch: ${batchPlayers[0]}`);
      console.error(`  Stopping. Re-run the script to resume from where it left off.`);
      process.exit(1);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  REFERRAL SEEDING COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Relationships seeded: ${playersToSet.length}`);
  console.log(`Total gas used:       ${totalGas}`);
  console.log(`Contract:             ${REFERRAL_CONTRACT}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
