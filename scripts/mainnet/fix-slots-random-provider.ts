/**
 * Register MultiLineSlots as consumer in RandomProvider
 */

import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

const CONSUMER_RANGE_LIMIT = 9n; // 9 random values for 3x3 grid

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("       REGISTER SLOTS IN RANDOM PROVIDER                            ");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Load deployment
  const deploymentPath = new URL("./deployments/arb-mainnet-public.json", import.meta.url);
  const content = await fs.readFile(deploymentPath, "utf-8");
  const deployment = JSON.parse(content);

  const slotsAddress = deployment.slots as Addr;
  const randomProviderAddress = deployment.randomProvider as Addr;

  console.log("Slots:", slotsAddress);
  console.log("RandomProvider:", randomProviderAddress);

  // Connect
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("Deployer:", deployer.account.address);

  const randomProvider = await viem.getContractAt("RandomProvider", randomProviderAddress);

  // Check current status
  console.log("\nChecking current status...");
  try {
    const status = await randomProvider.read.allowedConsumers([slotsAddress]);
    console.log("  Current allowed:", status[0]);
    console.log("  Current range limit:", status[1]);
    
    if (status[0] === true) {
      console.log("\n✅ Slots is already registered!");
      return;
    }
  } catch (e) {
    console.log("  Could not read current status, will register anyway");
  }

  // Register
  console.log("\nRegistering slots as consumer...");
  const tx = await randomProvider.write.setConsumerStatus(
    [slotsAddress, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  console.log("  Tx hash:", tx);
  
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  ✓ Transaction confirmed");

  // Verify
  console.log("\nVerifying registration...");
  const newStatus = await randomProvider.read.allowedConsumers([slotsAddress]);
  console.log("  Allowed:", newStatus[0]);
  console.log("  Range limit:", newStatus[1]);

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("✅ DONE - Slots is now registered in RandomProvider!");
  console.log("═══════════════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

