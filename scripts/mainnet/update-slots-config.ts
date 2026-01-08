/**
 * Update MultiLineSlots configuration
 * 
 * Use this script to change min/max wager, jackpot contribution, etc.
 */

import { network } from "hardhat";
import { parseEther } from "viem";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("              UPDATE MULTILINE SLOTS CONFIGURATION                  ");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Load deployment
  const deploymentPath = new URL("./deployments/arb-mainnet-public.json", import.meta.url);
  let deployment: any;
  try {
    const content = await fs.readFile(deploymentPath, "utf-8");
    deployment = JSON.parse(content);
  } catch (e) {
    throw new Error("Could not read deployment file.");
  }

  const slotsAddress = deployment.slots as Addr;
  if (!slotsAddress) {
    throw new Error("Slots address not found in deployment. Deploy slots first.");
  }

  console.log("Slots contract:", slotsAddress);

  // Connect
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("Deployer:", deployer.account.address);

  const slots = await viem.getContractAt("MultiLineSlots", slotsAddress);

  // New configuration
  const newConfig = {
    enabled: true,
    activeSymbolCount: 6,
    jackpotContributionBps: 350,  // 3.5%
    minWagerPerLine: parseEther("0.1"),  // 0.1 EVA min
    maxWagerPerLine: parseEther("3"),    // 3 EVA max
  };

  console.log("\nNew configuration:");
  console.log("  Enabled:", newConfig.enabled);
  console.log("  Active Symbols:", newConfig.activeSymbolCount);
  console.log("  Jackpot Contribution:", newConfig.jackpotContributionBps / 100, "%");
  console.log("  Min Wager/Line:", "0.1 EVA");
  console.log("  Max Wager/Line:", "3 EVA");

  // Update config
  console.log("\nUpdating configuration...");
  const tx = await slots.write.setSlotsConfig([newConfig], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  console.log("✓ Configuration updated!");

  // Verify new config
  const config = await slots.read.getSlotsConfig();
  console.log("\nVerified new config:");
  console.log("  Min Wager/Line:", config.minWagerPerLine.toString(), "wei");
  console.log("  Max Wager/Line:", config.maxWagerPerLine.toString(), "wei");

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("                           DONE                                     ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("\nNew betting limits:");
  console.log("  Min bet (1 line):  0.1 EVA");
  console.log("  Max bet (5 lines): 15 EVA");
  console.log("\nMax payout (5 × 3 EVA × 51x): 765 EVA");
  console.log("Min payout (1 × 0.1 EVA × 51x): 5.1 EVA");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

