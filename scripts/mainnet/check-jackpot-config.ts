import { network } from "hardhat";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// V4 Jackpot address
const JACKPOT_ADDRESS = "0x55c4bb3b11dbdb048a06b3442ac4757b57ca6874" as Addr;

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  JACKPOT V4 ON-CHAIN CONFIGURATION");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Contract:", JACKPOT_ADDRESS);
  console.log("");

  const jackpot = await viem.getContractAt("ProgressiveJackpotV2", JACKPOT_ADDRESS);

  // Consolation config
  console.log("📊 CONSOLATION CONFIGURATION:");
  const consolationPotBalance = await jackpot.read.consolationPotBalance();
  const consolationShareBps = await jackpot.read.consolationShareBps();
  const consolation1ProbBps = await jackpot.read.consolation1ProbBps();
  const consolation2ProbBps = await jackpot.read.consolation2ProbBps();
  
  console.log("   Consolation Pot Balance:", formatEther(consolationPotBalance), "EVA");
  console.log("   Consolation Share:", consolationShareBps, "bps (", Number(consolationShareBps) / 100, "%)");
  console.log("   Consolation 1 (1.2x) Prob:", consolation1ProbBps, "bps (", Number(consolation1ProbBps) / 100, "%)");
  console.log("   Consolation 2 (1.5x) Prob:", consolation2ProbBps, "bps (", Number(consolation2ProbBps) / 100, "%)");
  console.log("");

  // Tier pot balances
  console.log("📊 TIER POT BALANCES:");
  const allBalances = await jackpot.read.getAllTierPotBalances();
  for (let i = 0; i < 9; i++) {
    console.log(`   Tier ${i}: ${formatEther(allBalances[i])} EVA`);
  }
  console.log("");

  // Tier probability config
  console.log("📊 TIER PROBABILITY CONFIG (Tier 0 as example):");
  const probConfig = await jackpot.read.getTierProbability([0]);
  console.log("   Current Prob:", probConfig[0], "bps (", Number(probConfig[0]) / 100, "%)");
  console.log("   Entries Since Win:", probConfig[1]);
  console.log("   Min Prob:", probConfig[2], "bps (", Number(probConfig[2]) / 100, "%)");
  console.log("   Max Prob:", probConfig[3], "bps (", Number(probConfig[3]) / 100, "%)");
  console.log("   Increment:", probConfig[4], "bps (", Number(probConfig[4]) / 100, "% per entry)");
  console.log("");

  // Jackpot state
  console.log("📊 JACKPOT STATE:");
  const state = await jackpot.read.getJackpotState();
  console.log("   Next Tier Index:", state.nextTierIndex);
  console.log("   Total Entries:", state.totalEntries);
  console.log("   Total Jackpots Won:", state.totalJackpotsWon);
  console.log("   Total Consolation Paid:", formatEther(state.totalConsolationPaid), "EVA");
  console.log("   Last Winner:", state.lastWinner);
  console.log("");

  // Total balance
  const totalBalance = await jackpot.read.getJackpotBalance();
  console.log("📊 TOTAL JACKPOT BALANCE:", formatEther(totalBalance), "EVA");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });


