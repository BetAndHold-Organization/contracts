import { network } from "hardhat";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// V4 Roulette address
const ROULETTE_ADDRESS = "0xb3f60ca15dea4434fa7bc364563ac1f05d4ac142" as Addr;

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ROULETTE V4 ON-CHAIN CONFIGURATION");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Contract:", ROULETTE_ADDRESS);
  console.log("");

  const roulette = await viem.getContractAt("SingleRandomRouletteV2", ROULETTE_ADDRESS);

  // Table Config
  console.log("📊 TABLE CONFIG:");
  const tableConfig = await roulette.read.getTableConfig();
  console.log("   Enabled:", tableConfig.enabled);
  console.log("   Replay BPS:", tableConfig.replayBps, `(${Number(tableConfig.replayBps) / 100}%)`);
  console.log("   Jackpot BPS:", tableConfig.jackpotBps, `(${Number(tableConfig.jackpotBps) / 100}%)`);
  console.log("   Jackpot Contribution BPS:", tableConfig.jackpotContributionBps, `(${Number(tableConfig.jackpotContributionBps) / 100}%)`);
  console.log("   Min Multiplier:", tableConfig.minMultiplier, `(${Number(tableConfig.minMultiplier) / 100}x)`);
  console.log("   Max Multiplier:", tableConfig.maxMultiplier, `(${Number(tableConfig.maxMultiplier) / 100}x)`);
  console.log("   Min Wager:", formatEther(tableConfig.minWager), "EVA");
  console.log("   Max Wager:", formatEther(tableConfig.maxWager), "EVA");
  console.log("");

  // Jackpot Scaling Config
  console.log("📊 JACKPOT SCALING CONFIG:");
  const scalingConfig = await roulette.read.getJackpotScalingConfig();
  console.log("   Enabled:", scalingConfig.enabled);
  console.log("   Min Jackpot BPS:", scalingConfig.minJackpotBps, `(${Number(scalingConfig.minJackpotBps) / 100}%)`);
  console.log("   Max Jackpot BPS:", scalingConfig.maxJackpotBps, `(${Number(scalingConfig.maxJackpotBps) / 100}%)`);
  console.log("   Min Jackpot Wager:", formatEther(scalingConfig.minJackpotWager), "EVA");
  console.log("   Max Jackpot Wager:", formatEther(scalingConfig.maxJackpotWager), "EVA");
  console.log("   Function ID:", scalingConfig.functionId, `(${["Linear", "Quadratic", "Logarithmic", "Exponential"][scalingConfig.functionId]})`);
  console.log("");

  // Current config index
  const configIndex = await roulette.read.currentConfigIndex();
  console.log("📊 CURRENT CONFIG INDEX:", configIndex);

  // Jackpot address
  const jackpotAddr = await roulette.read.jackpot();
  console.log("📊 JACKPOT ADDRESS:", jackpotAddr);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

