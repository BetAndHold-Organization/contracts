import { network } from "hardhat";
import "dotenv/config";

type Addr = `0x${string}`;

// Load deployment addresses
import deploymentV2 from "./deployments/arb-mainnet-v2.json";

// ═══════════════════════════════════════════════════════════════════════════
// NEW PROBABILITY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
// 
// Target: n/500 progression
//   - 1st bet:   1/500 = 0.2%  = 20 bps
//   - 2nd bet:   2/500 = 0.4%  = 40 bps
//   - 3rd bet:   3/500 = 0.6%  = 60 bps
//   - ...
//   - 100th bet: 100/500 = 20% = 2000 bps (max, 1/5)
//   - 101st+:    stays at 2000 bps (1/5)
//
// Formula: prob = minProb + (entriesSinceWin × increment)
//   - minProb = 20 bps (1/500)
//   - increment = 20 bps (adds 1/500 each entry)
//   - maxProb = 2000 bps (caps at 100/500)
//
const NEW_PROB_MIN_BPS = 20;           // 1/500 = 0.2%
const NEW_PROB_MAX_BPS = 2000;         // 100/500 = 1/5 = 20%
const NEW_PROB_INCREMENT_BPS = 20;     // Each entry adds 1/500 = 0.2%

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  UPDATING JACKPOT V2 PROBABILITY CONFIG");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.account.address);
  console.log("Jackpot V2:", deploymentV2.jackpot);
  console.log("");

  const jackpot = await viem.getContractAt("ProgressiveJackpotV2", deploymentV2.jackpot as Addr);

  // Get current config for tier 0 as reference
  console.log("Current probability config (Tier 0):");
  const currentConfig = await jackpot.read.tierProbConfigs([0]);
  console.log("  - minProbBps:", currentConfig[0], `(${Number(currentConfig[0]) / 100}%)`);
  console.log("  - maxProbBps:", currentConfig[1], `(${Number(currentConfig[1]) / 100}%)`);
  console.log("  - incrementBps:", currentConfig[2], `(${Number(currentConfig[2]) / 100}%)`);
  console.log("");

  console.log("New probability config:");
  console.log("  - minProbBps:", NEW_PROB_MIN_BPS, `(${NEW_PROB_MIN_BPS / 100}% = 1/${10000 / NEW_PROB_MIN_BPS})`);
  console.log("  - maxProbBps:", NEW_PROB_MAX_BPS, `(${NEW_PROB_MAX_BPS / 100}% = 1/${10000 / NEW_PROB_MAX_BPS})`);
  console.log("  - incrementBps:", NEW_PROB_INCREMENT_BPS, `(${NEW_PROB_INCREMENT_BPS / 100}%)`);
  console.log("");

  // Calculate entries needed to reach max
  const entriesToMax = Math.ceil((NEW_PROB_MAX_BPS - NEW_PROB_MIN_BPS) / NEW_PROB_INCREMENT_BPS);
  console.log(`Entries to reach max probability: ${entriesToMax}`);
  console.log("");
  
  // Show progression example (n/500)
  console.log("Probability progression (n/500):");
  const samples = [0, 1, 2, 3, 10, 25, 50, 75, 99, 100, 101];
  for (const n of samples) {
    const probBps = Math.min(NEW_PROB_MAX_BPS, NEW_PROB_MIN_BPS + n * NEW_PROB_INCREMENT_BPS);
    const numerator = probBps / 20;  // Each 20 bps = 1/500
    const pct = probBps / 100;
    console.log(`  Entry ${(n+1).toString().padStart(3)}: ${probBps.toString().padStart(4)} bps (${pct.toFixed(1).padStart(4)}%) = ${numerator}/500`);
  }
  console.log("");

  // Update all tiers
  console.log("Updating all tier probability configs...");
  const tx = await jackpot.write.setAllTierProbConfigs(
    [NEW_PROB_MIN_BPS, NEW_PROB_MAX_BPS, NEW_PROB_INCREMENT_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("✓ Probability configs updated!");
  console.log("  Tx:", tx);

  // Verify
  console.log("");
  console.log("Verifying new config (Tier 0):");
  const newConfig = await jackpot.read.tierProbConfigs([0]);
  console.log("  - minProbBps:", newConfig[0], `(${Number(newConfig[0]) / 100}%)`);
  console.log("  - maxProbBps:", newConfig[1], `(${Number(newConfig[1]) / 100}%)`);
  console.log("  - incrementBps:", newConfig[2], `(${Number(newConfig[2]) / 100}%)`);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DONE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

