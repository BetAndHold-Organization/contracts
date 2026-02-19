import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

// V4 Deployment addresses
const REFERRAL_CONTRACT = "0xd64a1b0b213877cde3f9b4a0fa93bffa4878a71b" as Addr;

// Override referrers for specific players
const REFERRER_OVERRIDES: Record<string, string> = {
  "0x5ee14ad58471186540bb494fb0d309327bff0fde": "0x9545997091e07b5696477d18a2ee9e7c75a3b3b9",
  "0x298739c5d431159d26b7de9e43a8c2e6e74a9063": "0x9545997091e07b5696477d18a2ee9e7c75a3b3b9",
};

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SEEDING REFERRALS FOR V4");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.account.address);
  console.log("Referral Contract:", REFERRAL_CONTRACT);
  console.log("");

  // Load referral data
  const jsonPath = new URL("../referrals/referral-tree-for-contracts.json", import.meta.url);
  const data = JSON.parse(await fs.readFile(jsonPath, "utf-8"));

  // Get the arrays from the JSON
  let players: string[] = data.adminSetReferrers.players;
  let referrers: string[] = data.adminSetReferrers.referrers;

  console.log("Original relationships:", players.length);

  // Apply overrides
  let overridesApplied = 0;
  for (let i = 0; i < players.length; i++) {
    const playerLower = players[i].toLowerCase();
    if (REFERRER_OVERRIDES[playerLower]) {
      const oldReferrer = referrers[i];
      referrers[i] = REFERRER_OVERRIDES[playerLower];
      console.log(`Override: ${players[i]}`);
      console.log(`  Old referrer: ${oldReferrer}`);
      console.log(`  New referrer: ${referrers[i]}`);
      overridesApplied++;
    }
  }
  console.log(`\nOverrides applied: ${overridesApplied}`);

  // Get the referral contract
  const referral = await viem.getContractAt("MultiLevelReferral", REFERRAL_CONTRACT);

  // Check which relationships are already set
  console.log("\nChecking existing referrers...");
  const playersToSet: Addr[] = [];
  const referrersToSet: Addr[] = [];

  for (let i = 0; i < players.length; i++) {
    const player = players[i] as Addr;
    const referrer = referrers[i] as Addr;
    
    try {
      const existingReferrer = await referral.read.referrerOf([player]);
      if (existingReferrer === "0x0000000000000000000000000000000000000000") {
        playersToSet.push(player);
        referrersToSet.push(referrer);
      } else {
        console.log(`  Skipping ${player} (already has referrer: ${existingReferrer})`);
      }
    } catch {
      playersToSet.push(player);
      referrersToSet.push(referrer);
    }
  }

  console.log(`\nRelationships to set: ${playersToSet.length}`);

  if (playersToSet.length === 0) {
    console.log("All referrals already set!");
    return;
  }

  // Batch into chunks of 50 to avoid gas limits
  const BATCH_SIZE = 50;
  const batches = Math.ceil(playersToSet.length / BATCH_SIZE);

  console.log(`\nProcessing in ${batches} batch(es)...`);

  for (let batch = 0; batch < batches; batch++) {
    const start = batch * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, playersToSet.length);
    
    const batchPlayers = playersToSet.slice(start, end);
    const batchReferrers = referrersToSet.slice(start, end);

    console.log(`\nBatch ${batch + 1}/${batches}: ${batchPlayers.length} relationships`);

    const tx = await referral.write.adminSetReferrers(
      [batchPlayers, batchReferrers],
      { account: deployer.account }
    );
    
    console.log(`  TX: ${tx}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`  ✓ Confirmed in block ${receipt.blockNumber}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  REFERRAL SEEDING COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Total relationships set: ${playersToSet.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });


