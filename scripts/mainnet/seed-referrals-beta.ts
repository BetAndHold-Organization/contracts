/**
 * Seed referral relationships from beta testers data
 * 
 * This script reads beta-referral-seed.json and sets up initial referrer
 * relationships in the MultiLevelReferral contract for V2 deployment.
 * 
 * Structure:
 * - Tier 1 (top 5 by bets): NO referrer - they are root level
 * - Tier 2 (next 10): referred by Tier 1 round-robin
 * - Tier 3 (rest): referred by Tier 1+2 round-robin
 */

import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

interface ReferralEntry {
  referee: string;
  referrer: string;
  note?: string;
}

interface SeedData {
  referrals: ReferralEntry[];
  tier1_root_players: Array<{ address: string; bets: number; note: string }>;
  summary: {
    totalRelationships: number;
    tier1_players: number;
    tier2_players: number;
    tier3_players: number;
  };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("              SEED BETA TESTER REFERRALS (V2)                       ");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Load V2 deployment
  const deploymentPath = new URL("./deployments/arb-mainnet-v2.json", import.meta.url);
  let deployment: any;
  try {
    const content = await fs.readFile(deploymentPath, "utf-8");
    deployment = JSON.parse(content);
  } catch (e) {
    throw new Error("Could not read V2 deployment.");
  }

  const referralAddress = deployment.referral as Addr;
  console.log("MultiLevelReferral:", referralAddress);

  // Load seed data
  const seedPath = new URL("../referrals/beta-referral-seed.json", import.meta.url);
  let seedData: SeedData;
  try {
    const content = await fs.readFile(seedPath, "utf-8");
    seedData = JSON.parse(content);
  } catch (e) {
    throw new Error("Could not read beta-referral-seed.json");
  }

  console.log("\nSeed data loaded:");
  console.log("  Total relationships:", seedData.summary.totalRelationships);
  console.log("  Tier 1 (root):", seedData.summary.tier1_players);
  console.log("  Tier 2:", seedData.summary.tier2_players);
  console.log("  Tier 3:", seedData.summary.tier3_players);
  console.log("");

  // Connect to network
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("Deployer:", deployer.account.address);
  console.log("");

  // Get referral contract
  const referral = await viem.getContractAt("MultiLevelReferral", referralAddress);

  // Filter out entries where referee already has a referrer
  const referrals = seedData.referrals;
  const toProcess: { referee: Addr; referrer: Addr }[] = [];
  let skipCount = 0;

  console.log("Checking existing referrers...");
  for (const entry of referrals) {
    const referee = entry.referee as Addr;
    const referrer = entry.referrer as Addr;
    
    try {
      const existingReferrer = await referral.read.getReferrer([referee]);
      if (existingReferrer !== "0x0000000000000000000000000000000000000000") {
        skipCount++;
        continue;
      }
      toProcess.push({ referee, referrer });
    } catch {
      toProcess.push({ referee, referrer });
    }
  }

  console.log(`  ✓ ${toProcess.length} to process, ${skipCount} already have referrers\n`);

  if (toProcess.length === 0) {
    console.log("Nothing to process!");
    return;
  }

  // Process in batches using adminSetReferrers
  const BATCH_SIZE = 20;
  let successCount = 0;
  let errorCount = 0;

  console.log("Setting up referral relationships...\n");

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, Math.min(i + BATCH_SIZE, toProcess.length));
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);
    
    console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} entries)...`);

    const referees = batch.map(e => e.referee);
    const referrers = batch.map(e => e.referrer);

    try {
      const tx = await referral.write.adminSetReferrers(
        [referees, referrers],
        { account: deployer.account }
      );
      await publicClient.waitForTransactionReceipt({ hash: tx });
      
      console.log(`  ✓ Batch ${batchNum} complete`);
      successCount += batch.length;

      // Show some entries
      for (const entry of batch.slice(0, 3)) {
        console.log(`    ${entry.referee.slice(0, 10)}... → ${entry.referrer.slice(0, 10)}...`);
      }
      if (batch.length > 3) {
        console.log(`    ... and ${batch.length - 3} more`);
      }
    } catch (e: any) {
      console.log(`  ❌ Batch ${batchNum} failed: ${e.message?.slice(0, 80)}`);
      errorCount += batch.length;
    }

    // Small delay between batches
    if (i + BATCH_SIZE < toProcess.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("                           SUMMARY                                  ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  ✓ Success:", successCount);
  console.log("  ⏭ Skipped:", skipCount);
  console.log("  ❌ Errors:", errorCount);
  console.log("");

  // Show Tier 1 players (they have no referrer, which is correct)
  console.log("Tier 1 Root Players (no referrer - they are the top):");
  for (const p of seedData.tier1_root_players) {
    console.log(`  🏆 ${p.address} (${p.bets} bets)`);
  }
  console.log("");

  console.log("✅ Done!");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
