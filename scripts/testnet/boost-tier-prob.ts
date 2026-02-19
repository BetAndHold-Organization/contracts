import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

async function main() {
  const deploymentRaw = await fs.readFile("scripts/testnet/deployments/arb-sepolia-v4.json", "utf8");
  const deployment = JSON.parse(deploymentRaw);

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const jackpot = await viem.getContractAt("ProgressiveJackpotV2", deployment.jackpot);

  const TIER_INDEX = 0;
  const SIMULATED_ENTRIES = 163n;

  // Read current state
  const [currentProb, entries, minProb, maxProb, increment] =
    await jackpot.read.getTierProbability([TIER_INDEX]);

  console.log(`Tier ${TIER_INDEX} BEFORE boost:`);
  console.log(`  Current probability: ${currentProb} bps (${Number(currentProb) / 100}%)`);
  console.log(`  Entries since win:   ${entries}`);
  console.log(`  Config: min=${minProb} max=${maxProb} increment=${increment}`);
  console.log("");

  // Boost
  console.log(`Boosting tier ${TIER_INDEX} by ${SIMULATED_ENTRIES} simulated entries...`);
  const tx = await jackpot.write.boostTierProbability(
    [TIER_INDEX, SIMULATED_ENTRIES],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });

  // Read new state
  const [newProb, newEntries] = await jackpot.read.getTierProbability([TIER_INDEX]);

  console.log(`Tier ${TIER_INDEX} AFTER boost:`);
  console.log(`  Current probability: ${newProb} bps (${Number(newProb) / 100}%)`);
  console.log(`  Entries since win:   ${newEntries}`);
  console.log("  ✓ Done");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
