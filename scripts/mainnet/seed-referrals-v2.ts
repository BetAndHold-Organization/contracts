import { network } from "hardhat";
import "dotenv/config";

type Addr = `0x${string}`;

// Load deployment addresses
import deploymentV2 from "./deployments/arb-mainnet-v2.json";
import referralSeed from "../referrals/referral-seed.json";

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SEEDING REFERRALS FOR V2 DEPLOYMENT");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.account.address);
  console.log("MultiLevelReferral V2:", deploymentV2.referral);
  console.log("");

  const referral = await viem.getContractAt("MultiLevelReferral", deploymentV2.referral as Addr);

  // Parse referral seed into parallel arrays
  const referees: Addr[] = [];
  const referrers: Addr[] = [];

  for (const entry of referralSeed.referrals) {
    // Check if already set
    const existingReferrer = await referral.read.referrerOf([entry.referee as Addr]);
    if (existingReferrer !== "0x0000000000000000000000000000000000000000") {
      console.log(`⚠ Skipping ${entry.referee} - already has referrer`);
      continue;
    }
    referees.push(entry.referee as Addr);
    referrers.push(entry.referrer as Addr);
  }

  if (referees.length === 0) {
    console.log("✓ All referrals already seeded!");
    return;
  }

  console.log(`Seeding ${referees.length} referral relationships...`);
  console.log("");

  // Display relationships to be seeded
  for (let i = 0; i < referees.length; i++) {
    console.log(`  ${referees[i]} → ${referrers[i]}`);
  }
  console.log("");

  // Seed in one transaction
  const tx = await referral.write.adminSetReferrers([referees, referrers], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  console.log("✓ Referrals seeded!");
  console.log("  Tx:", tx);

  // Verify a few
  console.log("");
  console.log("Verifying...");
  for (let i = 0; i < Math.min(3, referees.length); i++) {
    const ref = await referral.read.referrerOf([referees[i]]);
    console.log(`  ${referees[i]} → ${ref}`);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DONE - Seeded", referees.length, "referrals");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});



