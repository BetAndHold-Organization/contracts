/**
 * Quick check of RandomProvider consumer status
 */

import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

async function main() {
  // Load deployment
  const deploymentPath = new URL("./deployments/arb-mainnet-public.json", import.meta.url);
  const content = await fs.readFile(deploymentPath, "utf-8");
  const deployment = JSON.parse(content);

  const slotsAddress = deployment.slots as Addr;
  const randomProviderAddress = deployment.randomProvider as Addr;

  console.log("Checking RandomProvider consumer status...\n");
  console.log("Slots:", slotsAddress);
  console.log("RandomProvider:", randomProviderAddress);

  // Connect
  const conn = await network.connect();
  const viem = conn.viem;

  const randomProvider = await viem.getContractAt("RandomProvider", randomProviderAddress);

  // Read BOTH mappings separately
  const isAllowed = await randomProvider.read.allowedConsumers([slotsAddress]);
  const maxRanges = await randomProvider.read.maxRangesAllowed([slotsAddress]);

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  allowedConsumers[slots]:", isAllowed);
  console.log("  maxRangesAllowed[slots]:", maxRanges);
  console.log("═══════════════════════════════════════════════════════════════════");

  if (isAllowed === true) {
    console.log("\n✅ Slots IS registered as consumer!");
  } else {
    console.log("\n❌ Slots is NOT registered as consumer");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});



