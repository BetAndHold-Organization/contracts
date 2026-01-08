import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// ============================================================
// SCALING FUNCTION TYPES
// ============================================================
const SCALING_LINEAR = 0;
const SCALING_QUADRATIC = 1;
const SCALING_LOG = 2;

// ============================================================
// HELPER TYPES
// ============================================================
type ScalingConfig = {
  enabled: boolean;
  minJackpotBps: number;  // min probability (bps)
  maxJackpotBps: number;  // max probability (bps)
  minJackpotWager: bigint; // jackpot balance where prob = min
  maxJackpotWager: bigint; // jackpot balance where prob = max
  functionId: number;      // scaling curve type
  extraData: `0x${string}`;
};

type OutcomeConfig = {
  scaling: ScalingConfig;
  tierAdvance: number;           // tiers to advance on win
  tierResetTo: number;           // reset tier (for terminal)
  consolationMultiplier: number; // in bps (15000 = 1.5x)
  awardsTier: boolean;           // does this outcome award a tier prize?
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Constant probability (same regardless of jackpot balance)
function scalingConst(bps: number): ScalingConfig {
  return {
    enabled: true,
    minJackpotBps: bps,
    maxJackpotBps: bps,
    minJackpotWager: 0n,
    maxJackpotWager: 1n,
    functionId: SCALING_LINEAR,
    extraData: "0x",
  };
}

// Probability scales with jackpot balance (minBal → maxBal EVA)
function scalingRange(minBps: number, maxBps: number, minBal: string, maxBal: string, fn: number): ScalingConfig {
  return {
    enabled: true,
    minJackpotBps: minBps,
    maxJackpotBps: maxBps,
    minJackpotWager: parseEther(minBal),
    maxJackpotWager: parseEther(maxBal),
    functionId: fn,
    extraData: "0x",
  };
}

// ============================================================
// CONFIGURE YOUR OUTCOME PROBABILITIES HERE
// Edit the values below and run the script to update on-chain
// 
// NEW BALANCED CONFIGURATION (simulated for sustainability)
// - Cost per tier: 17.5% of prize (configured in tier ladder)
// - Jackpot stable over 20+ cycles
// - Tier 9 avg payout: ~15 EVA (with 20 EVA jackpot)
// ============================================================
function buildScaledOutcomes(): OutcomeConfig[] {
  const outcomes: OutcomeConfig[] = [];

  // =====================================================
  // NON-TIER OUTCOMES (outcomes 0-2)
  // =====================================================

  // Outcome 0: No prize (fallback outcome - absorbs remainder)
  outcomes.push({ 
    scaling: scalingConst(0),             // fallback, gets remainder probability
    tierAdvance: 0, 
    tierResetTo: 0, 
    consolationMultiplier: 0,             // no payout
    awardsTier: false 
  });

  // Outcome 1: Consolation 1.3x payout
  outcomes.push({ 
    scaling: scalingConst(1200),          // 12% constant probability
    tierAdvance: 0, 
    tierResetTo: 0, 
    consolationMultiplier: 13_000,        // 1.3x wager
    awardsTier: false 
  });

  // Outcome 2: Consolation 1.8x payout
  outcomes.push({ 
    scaling: scalingConst(600),           // 6% constant probability
    tierAdvance: 0, 
    tierResetTo: 0, 
    consolationMultiplier: 18_000,        // 1.8x wager
    awardsTier: false 
  });

  // =====================================================
  // TIER AWARD OUTCOMES (outcomes 3-11 = tiers 1-9)
  // scalingRange(minBps, maxBps, minBalance, maxBalance, curve)
  //   - minBps: probability when jackpot <= minBalance
  //   - maxBps: probability when jackpot >= maxBalance
  //   - Scales linearly between based on jackpot balance
  // =====================================================

  // Tier 1 (outcome 3): Prize = 3% of jackpot
  // High probability early tier - easy to win, small prize
  outcomes.push({ 
    scaling: scalingRange(2500, 7000, "5", "15", SCALING_LINEAR),   // 25%-70%, jackpot 5-15 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  // Tier 2 (outcome 4): Prize = 3% of jackpot
  outcomes.push({ 
    scaling: scalingRange(2200, 6500, "6", "18", SCALING_LINEAR),   // 22%-65%, jackpot 6-18 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  // Tier 3 (outcome 5): Prize = 4% of jackpot
  outcomes.push({ 
    scaling: scalingRange(2000, 6000, "8", "20", SCALING_LINEAR),   // 20%-60%, jackpot 8-20 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  // Tier 4 (outcome 6): Prize = 5% of jackpot
  outcomes.push({ 
    scaling: scalingRange(1800, 5500, "10", "25", SCALING_LINEAR),  // 18%-55%, jackpot 10-25 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  // Tier 5 (outcome 7): Prize = 7% of jackpot
  outcomes.push({ 
    scaling: scalingRange(1500, 5000, "12", "30", SCALING_LINEAR),  // 15%-50%, jackpot 12-30 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  // Tier 6 (outcome 8): Prize = 10% of jackpot
  outcomes.push({ 
    scaling: scalingRange(1200, 4500, "15", "35", SCALING_LINEAR),  // 12%-45%, jackpot 15-35 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  // Tier 7 (outcome 9): Prize = 15% of jackpot
  outcomes.push({ 
    scaling: scalingRange(1000, 4000, "18", "40", SCALING_LINEAR),  // 10%-40%, jackpot 18-40 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  // Tier 8 (outcome 10): Prize = 18% of jackpot
  outcomes.push({ 
    scaling: scalingRange(800, 3500, "22", "50", SCALING_LINEAR),   // 8%-35%, jackpot 22-50 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  // Tier 9 (outcome 11): Prize = 45% of jackpot (GRAND PRIZE - terminal)
  // Lower probability but still achievable - big payoff!
  outcomes.push({ 
    scaling: scalingRange(500, 3000, "30", "70", SCALING_LINEAR),   // 5%-30%, jackpot 30-70 EVA
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true 
  });

  return outcomes;
}
// ============================================================

async function loadDeployment(): Promise<{ jackpot: Addr; roulette: Addr }> {
  const p = new URL("./deployments/arb-mainnet-public.json", import.meta.url);
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function main() {
  const deployment = await loadDeployment();
  
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("Deployer:", deployer.account.address);
  console.log("Jackpot:", deployment.jackpot);
  console.log("Roulette:", deployment.roulette);

  const jackpot = await viem.getContractAt("ProgressiveJackpot", deployment.jackpot);

  const outcomes = buildScaledOutcomes();

  console.log("\nNew outcome configuration:");
  outcomes.forEach((o, i) => {
    const type = o.awardsTier ? `Tier ${i - 2}` : (o.consolationMultiplier > 0 ? `Consolation ${o.consolationMultiplier/10000}x` : "No prize");
    console.log(`  [${i}] ${type}: ${o.scaling.minJackpotBps/100}% - ${o.scaling.maxJackpotBps/100}%`);
  });

  // Update roulette game outcomes
  console.log("\n1. Updating roulette game outcomes...");
  const tx1 = await jackpot.write.registerGame([deployment.roulette, outcomes], { account: deployer.account });
  console.log("   Tx:", tx1);
  await publicClient.waitForTransactionReceipt({ hash: tx1 });
  console.log("   ✓ Roulette outcomes updated!");

  // Update direct bet outcomes
  console.log("\n2. Updating direct bet outcomes...");
  const tx2 = await jackpot.write.configureDirectBet([true, outcomes], { account: deployer.account });
  console.log("   Tx:", tx2);
  await publicClient.waitForTransactionReceipt({ hash: tx2 });
  console.log("   ✓ Direct bet outcomes updated!");

  console.log("\n✓ All outcome probabilities updated!");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

