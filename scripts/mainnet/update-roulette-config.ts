import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// V4 Roulette address from deployment
const ROULETTE_ADDRESS = "0xb3f60ca15dea4434fa7bc364563ac1f05d4ac142" as Addr;

// Scaling functions enum (from JackpotScalingLib)
const ScalingFunction = {
  Linear: 0,
  Quadratic: 1,
  Logarithmic: 2,
  Exponential: 3,
} as const;

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  UPDATING ROULETTE V4 CONFIGURATION");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Contract:", ROULETTE_ADDRESS);
  console.log("Deployer:", deployer.account.address);
  console.log("");

  const roulette = await viem.getContractAt("SingleRandomRouletteV2", ROULETTE_ADDRESS);

  // Get current config to preserve unchanged values
  const currentConfig = await roulette.read.getTableConfig();
  console.log("📊 CURRENT TABLE CONFIG:");
  console.log("   Min Wager:", formatEther(currentConfig.minWager), "EVA");
  console.log("   Max Wager:", formatEther(currentConfig.maxWager), "EVA");
  console.log("   Jackpot BPS:", currentConfig.jackpotBps);
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // 1. UPDATE TABLE CONFIG
  // ─────────────────────────────────────────────────────────────────────────
  console.log("1️⃣  Updating Table Config...");
  
  const newTableConfig = {
    enabled: true,
    replayBps: currentConfig.replayBps,           // Keep 5%
    jackpotBps: currentConfig.jackpotBps,         // Keep 3% base (will be overridden by scaling)
    jackpotContributionBps: currentConfig.jackpotContributionBps, // Keep 3.5%
    minMultiplier: currentConfig.minMultiplier,   // Keep 1.01x
    maxMultiplier: currentConfig.maxMultiplier,   // Keep 100x
    minWager: parseEther("0.1"),                  // 0.1 EVA (unchanged)
    maxWager: parseEther("5"),                    // 5 EVA (was 3 EVA) ✨ CHANGED
  };

  console.log("   New Min Wager:", formatEther(newTableConfig.minWager), "EVA");
  console.log("   New Max Wager:", formatEther(newTableConfig.maxWager), "EVA ✨");

  const tx1 = await roulette.write.setTableConfig([newTableConfig], { account: deployer.account });
  console.log("   TX:", tx1);
  await publicClient.waitForTransactionReceipt({ hash: tx1 });
  console.log("   ✓ Table config updated");
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // 2. ENABLE JACKPOT SCALING
  // ─────────────────────────────────────────────────────────────────────────
  console.log("2️⃣  Enabling Jackpot Scaling (Exponential)...");

  const scalingConfig = {
    enabled: true,                                // ✨ ENABLED
    minJackpotBps: 100,                           // 1% minimum
    maxJackpotBps: 800,                           // 8% maximum
    minJackpotWager: parseEther("0.1"),           // Start scaling at 0.1 EVA
    maxJackpotWager: parseEther("5"),             // Max probability at 5 EVA
    functionId: ScalingFunction.Exponential,      // Exponential curve (x³)
    extraData: "0x" as Addr,                      // No extra data needed
  };

  console.log("   Scaling: ENABLED");
  console.log("   Min Jackpot BPS: 100 (1%)");
  console.log("   Max Jackpot BPS: 800 (8%)");
  console.log("   Min Jackpot Wager:", formatEther(scalingConfig.minJackpotWager), "EVA");
  console.log("   Max Jackpot Wager:", formatEther(scalingConfig.maxJackpotWager), "EVA");
  console.log("   Function: Exponential (x³)");

  const tx2 = await roulette.write.setJackpotScalingConfig([scalingConfig], { account: deployer.account });
  console.log("   TX:", tx2);
  await publicClient.waitForTransactionReceipt({ hash: tx2 });
  console.log("   ✓ Jackpot scaling enabled");
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // VERIFY NEW CONFIG
  // ─────────────────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  VERIFYING NEW CONFIGURATION");
  console.log("═══════════════════════════════════════════════════════════════");

  const verifyTableConfig = await roulette.read.getTableConfig();
  console.log("📊 NEW TABLE CONFIG:");
  console.log("   Enabled:", verifyTableConfig.enabled);
  console.log("   Replay BPS:", verifyTableConfig.replayBps, `(${Number(verifyTableConfig.replayBps) / 100}%)`);
  console.log("   Jackpot BPS:", verifyTableConfig.jackpotBps, `(${Number(verifyTableConfig.jackpotBps) / 100}%)`);
  console.log("   Jackpot Contribution BPS:", verifyTableConfig.jackpotContributionBps, `(${Number(verifyTableConfig.jackpotContributionBps) / 100}%)`);
  console.log("   Min Wager:", formatEther(verifyTableConfig.minWager), "EVA");
  console.log("   Max Wager:", formatEther(verifyTableConfig.maxWager), "EVA");
  console.log("");

  const verifyScalingConfig = await roulette.read.getJackpotScalingConfig();
  console.log("📊 NEW JACKPOT SCALING CONFIG:");
  console.log("   Enabled:", verifyScalingConfig.enabled);
  console.log("   Min Jackpot BPS:", verifyScalingConfig.minJackpotBps, `(${Number(verifyScalingConfig.minJackpotBps) / 100}%)`);
  console.log("   Max Jackpot BPS:", verifyScalingConfig.maxJackpotBps, `(${Number(verifyScalingConfig.maxJackpotBps) / 100}%)`);
  console.log("   Min Jackpot Wager:", formatEther(verifyScalingConfig.minJackpotWager), "EVA");
  console.log("   Max Jackpot Wager:", formatEther(verifyScalingConfig.maxJackpotWager), "EVA");
  console.log("   Function ID:", verifyScalingConfig.functionId, `(${["Linear", "Quadratic", "Logarithmic", "Exponential"][verifyScalingConfig.functionId]})`);
  console.log("");

  // Show expected probabilities at different wager levels
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  EXPECTED JACKPOT PROBABILITIES");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("   (Exponential curve: scales as x³ from min to max)");
  console.log("");
  
  const wagers = [0.1, 0.5, 1, 2, 3, 4, 5];
  for (const wager of wagers) {
    // Calculate exponential scaling
    const minW = 0.1;
    const maxW = 5;
    const minBps = 100;
    const maxBps = 800;
    
    if (wager < minW) {
      console.log(`   ${wager} EVA: 0%`);
    } else if (wager >= maxW) {
      console.log(`   ${wager} EVA: ${maxBps / 100}% (max)`);
    } else {
      const position = (wager - minW) / (maxW - minW);
      const scaled = position ** 3; // Exponential (x³)
      const prob = minBps + (maxBps - minBps) * scaled;
      console.log(`   ${wager} EVA: ${(prob / 100).toFixed(2)}%`);
    }
  }
  console.log("");
  console.log("✅ Configuration update complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

