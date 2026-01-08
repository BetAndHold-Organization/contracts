/**
 * Jackpot Progression Simulator
 * 
 * Simulates multiple complete progressions through all 9 tiers
 * to analyze expected prizes and jackpot sustainability
 */

// ============================================================
// PROPOSED CONFIGURATION
// ============================================================

interface TierConfig {
  prizeBps: number;      // Prize as % of jackpot (basis points: 1000 = 10%)
  minProbBps: number;    // Min probability (bps)
  maxProbBps: number;    // Max probability (bps)
  minBalance: number;    // Balance where prob = min
  maxBalance: number;    // Balance where prob = max
}

const TIER_CONFIGS: TierConfig[] = [
  { prizeBps: 300,  minProbBps: 2500, maxProbBps: 7000, minBalance: 5,  maxBalance: 15 },  // Tier 1: 3%
  { prizeBps: 300,  minProbBps: 2200, maxProbBps: 6500, minBalance: 6,  maxBalance: 18 },  // Tier 2: 3%
  { prizeBps: 400,  minProbBps: 2000, maxProbBps: 6000, minBalance: 8,  maxBalance: 20 },  // Tier 3: 4%
  { prizeBps: 500,  minProbBps: 1800, maxProbBps: 5500, minBalance: 10, maxBalance: 25 },  // Tier 4: 5%
  { prizeBps: 700,  minProbBps: 1500, maxProbBps: 5000, minBalance: 12, maxBalance: 30 },  // Tier 5: 7%
  { prizeBps: 1000, minProbBps: 1200, maxProbBps: 4500, minBalance: 15, maxBalance: 35 },  // Tier 6: 10%
  { prizeBps: 1500, minProbBps: 1000, maxProbBps: 4000, minBalance: 18, maxBalance: 40 },  // Tier 7: 15%
  { prizeBps: 1800, minProbBps: 800,  maxProbBps: 3500, minBalance: 22, maxBalance: 50 },  // Tier 8: 18%
  { prizeBps: 4500, minProbBps: 500,  maxProbBps: 3000, minBalance: 30, maxBalance: 70 },  // Tier 9: 45%
];

// Consolation outcomes
const CONSOLATION_1_PROB = 1200; // 12% chance of 1.3x
const CONSOLATION_1_MULT = 1.3;
const CONSOLATION_2_PROB = 600;  // 6% chance of 1.8x
const CONSOLATION_2_MULT = 1.8;

// Cost per attempt (% of prize)
const COST_BPS = 1750; // 17.5% of prize

// ============================================================
// SIMULATION FUNCTIONS
// ============================================================

function interpolateProbability(tier: TierConfig, balance: number): number {
  if (balance <= tier.minBalance) return tier.minProbBps;
  if (balance >= tier.maxBalance) return tier.maxProbBps;
  
  const ratio = (balance - tier.minBalance) / (tier.maxBalance - tier.minBalance);
  return tier.minProbBps + ratio * (tier.maxProbBps - tier.minProbBps);
}

function calculatePrize(balance: number, prizeBps: number): number {
  return (balance * prizeBps) / 10000;
}

function calculateCost(prize: number): number {
  return (prize * COST_BPS) / 10000;
}

interface AttemptResult {
  won: boolean;
  consolation: number;
  cost: number;
  prize: number;
}

function simulateAttempt(tierIndex: number, balance: number, betAmount: number): AttemptResult {
  const tier = TIER_CONFIGS[tierIndex];
  const prob = interpolateProbability(tier, balance);
  const roll = Math.random() * 10000;
  
  // Check tier win first
  if (roll < prob) {
    const prize = calculatePrize(balance, tier.prizeBps);
    return { won: true, consolation: 0, cost: betAmount, prize };
  }
  
  // Check consolations
  const consolationRoll = Math.random() * 10000;
  if (consolationRoll < CONSOLATION_1_PROB) {
    return { won: false, consolation: betAmount * CONSOLATION_1_MULT, cost: betAmount, prize: 0 };
  }
  if (consolationRoll < CONSOLATION_1_PROB + CONSOLATION_2_PROB) {
    return { won: false, consolation: betAmount * CONSOLATION_2_MULT, cost: betAmount, prize: 0 };
  }
  
  // Lost
  return { won: false, consolation: 0, cost: betAmount, prize: 0 };
}

interface TierStats {
  attempts: number;
  prize: number;
  totalCost: number;
  consolationWon: number;
}

interface SimulationResult {
  tierStats: TierStats[];
  totalAttempts: number;
  totalPrizeWon: number;
  totalCostPaid: number;
  totalConsolation: number;
  finalJackpotBalance: number;
  netPlayerProfit: number;
}

function simulateFullProgression(startingBalance: number): SimulationResult {
  let jackpotBalance = startingBalance;
  const tierStats: TierStats[] = [];
  let totalAttempts = 0;
  let totalPrizeWon = 0;
  let totalCostPaid = 0;
  let totalConsolation = 0;
  
  for (let tierIndex = 0; tierIndex < 9; tierIndex++) {
    const tier = TIER_CONFIGS[tierIndex];
    let attempts = 0;
    let tierPrize = 0;
    let tierCost = 0;
    let tierConsolation = 0;
    
    // Keep attempting until we win this tier
    while (true) {
      attempts++;
      totalAttempts++;
      
      // Calculate cost for this attempt
      const expectedPrize = calculatePrize(jackpotBalance, tier.prizeBps);
      const cost = calculateCost(expectedPrize);
      
      // Player pays cost (goes to jackpot)
      jackpotBalance += cost;
      tierCost += cost;
      totalCostPaid += cost;
      
      // Simulate the attempt
      const result = simulateAttempt(tierIndex, jackpotBalance, cost);
      
      if (result.won) {
        // Prize comes out of jackpot
        tierPrize = result.prize;
        jackpotBalance -= tierPrize;
        totalPrizeWon += tierPrize;
        break;
      } else if (result.consolation > 0) {
        // Consolation comes out of jackpot
        jackpotBalance -= result.consolation;
        tierConsolation += result.consolation;
        totalConsolation += result.consolation;
      }
      
      // Safety: prevent infinite loops (max 1000 attempts per tier)
      if (attempts > 1000) {
        console.log(`  ⚠️ Tier ${tierIndex + 1} exceeded 1000 attempts, forcing win`);
        tierPrize = calculatePrize(jackpotBalance, tier.prizeBps);
        jackpotBalance -= tierPrize;
        totalPrizeWon += tierPrize;
        break;
      }
    }
    
    tierStats.push({
      attempts,
      prize: tierPrize,
      totalCost: tierCost,
      consolationWon: tierConsolation,
    });
  }
  
  return {
    tierStats,
    totalAttempts,
    totalPrizeWon,
    totalCostPaid,
    totalConsolation,
    finalJackpotBalance: jackpotBalance,
    netPlayerProfit: totalPrizeWon + totalConsolation - totalCostPaid,
  };
}

// ============================================================
// ANALYSIS
// ============================================================

function printExpectedValues(startingBalance: number) {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("                    EXPECTED VALUES PER TIER                                ");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");
  console.log(`Starting Jackpot Balance: ${startingBalance} EVA\n`);
  
  let balance = startingBalance;
  
  console.log("┌──────┬─────────┬───────────┬───────────┬──────────────┬──────────────┐");
  console.log("│ Tier │ Prize % │ Prize EVA │ Cost EVA  │ Prob @ start │ Avg Attempts │");
  console.log("├──────┼─────────┼───────────┼───────────┼──────────────┼──────────────┤");
  
  for (let i = 0; i < 9; i++) {
    const tier = TIER_CONFIGS[i];
    const prize = calculatePrize(balance, tier.prizeBps);
    const cost = calculateCost(prize);
    const prob = interpolateProbability(tier, balance);
    const avgAttempts = 10000 / prob;
    
    console.log(
      `│  ${i + 1}   │  ${(tier.prizeBps / 100).toFixed(0).padStart(3)}%   │ ` +
      `${prize.toFixed(3).padStart(9)} │ ${cost.toFixed(4).padStart(9)} │ ` +
      `${(prob / 100).toFixed(1).padStart(10)}%  │ ${avgAttempts.toFixed(1).padStart(10)}x │`
    );
    
    // Update balance for next tier (subtract prize won)
    balance -= prize;
  }
  
  console.log("└──────┴─────────┴───────────┴───────────┴──────────────┴──────────────┘");
  console.log(`\nFinal jackpot after all 9 tiers won: ${balance.toFixed(3)} EVA`);
}

function runSimulations(numSimulations: number, startingBalance: number) {
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log(`                    ${numSimulations} FULL PROGRESSION SIMULATIONS                       `);
  console.log("═══════════════════════════════════════════════════════════════════════════\n");
  
  const results: SimulationResult[] = [];
  
  for (let sim = 0; sim < numSimulations; sim++) {
    const result = simulateFullProgression(startingBalance);
    results.push(result);
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`SIMULATION #${sim + 1}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    console.log("\n┌──────┬──────────┬────────────┬────────────┬─────────────┐");
    console.log("│ Tier │ Attempts │ Prize Won  │ Cost Paid  │ Consolation │");
    console.log("├──────┼──────────┼────────────┼────────────┼─────────────┤");
    
    for (let i = 0; i < 9; i++) {
      const s = result.tierStats[i];
      console.log(
        `│  ${i + 1}   │ ` +
        `${s.attempts.toString().padStart(8)} │ ` +
        `${s.prize.toFixed(3).padStart(10)} │ ` +
        `${s.totalCost.toFixed(3).padStart(10)} │ ` +
        `${s.consolationWon.toFixed(3).padStart(11)} │`
      );
    }
    
    console.log("└──────┴──────────┴────────────┴────────────┴─────────────┘");
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`   Total attempts:       ${result.totalAttempts}`);
    console.log(`   Total prize won:      ${result.totalPrizeWon.toFixed(3)} EVA`);
    console.log(`   Total consolation:    ${result.totalConsolation.toFixed(3)} EVA`);
    console.log(`   Total cost paid:      ${result.totalCostPaid.toFixed(3)} EVA`);
    console.log(`   ─────────────────────────────────────`);
    console.log(`   Net player profit:    ${result.netPlayerProfit.toFixed(3)} EVA`);
    console.log(`   Final jackpot:        ${result.finalJackpotBalance.toFixed(3)} EVA`);
  }
  
  // Aggregate statistics
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("                         AGGREGATE STATISTICS                               ");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");
  
  const avgAttempts = results.reduce((sum, r) => sum + r.totalAttempts, 0) / numSimulations;
  const avgPrize = results.reduce((sum, r) => sum + r.totalPrizeWon, 0) / numSimulations;
  const avgConsolation = results.reduce((sum, r) => sum + r.totalConsolation, 0) / numSimulations;
  const avgCost = results.reduce((sum, r) => sum + r.totalCostPaid, 0) / numSimulations;
  const avgProfit = results.reduce((sum, r) => sum + r.netPlayerProfit, 0) / numSimulations;
  const avgFinalBalance = results.reduce((sum, r) => sum + r.finalJackpotBalance, 0) / numSimulations;
  
  const minAttempts = Math.min(...results.map(r => r.totalAttempts));
  const maxAttempts = Math.max(...results.map(r => r.totalAttempts));
  const minProfit = Math.min(...results.map(r => r.netPlayerProfit));
  const maxProfit = Math.max(...results.map(r => r.netPlayerProfit));
  
  console.log(`Starting Jackpot:         ${startingBalance} EVA`);
  console.log(`Number of simulations:    ${numSimulations}`);
  console.log(``);
  console.log(`Average attempts:         ${avgAttempts.toFixed(1)} (min: ${minAttempts}, max: ${maxAttempts})`);
  console.log(`Average prizes won:       ${avgPrize.toFixed(3)} EVA`);
  console.log(`Average consolation:      ${avgConsolation.toFixed(3)} EVA`);
  console.log(`Average cost paid:        ${avgCost.toFixed(3)} EVA`);
  console.log(`Average net profit:       ${avgProfit.toFixed(3)} EVA (min: ${minProfit.toFixed(3)}, max: ${maxProfit.toFixed(3)})`);
  console.log(`Average final jackpot:    ${avgFinalBalance.toFixed(3)} EVA`);
  console.log(``);
  console.log(`Jackpot sustainability:   ${((avgFinalBalance / startingBalance) * 100).toFixed(1)}% retained`);
  
  // Per-tier average attempts
  console.log("\n┌──────┬────────────────┬────────────────┐");
  console.log("│ Tier │ Avg Attempts   │ Avg Prize      │");
  console.log("├──────┼────────────────┼────────────────┤");
  
  for (let i = 0; i < 9; i++) {
    const avgTierAttempts = results.reduce((sum, r) => sum + r.tierStats[i].attempts, 0) / numSimulations;
    const avgTierPrize = results.reduce((sum, r) => sum + r.tierStats[i].prize, 0) / numSimulations;
    console.log(
      `│  ${i + 1}   │ ` +
      `${avgTierAttempts.toFixed(1).padStart(14)} │ ` +
      `${avgTierPrize.toFixed(3).padStart(12)} EVA │`
    );
  }
  
  console.log("└──────┴────────────────┴────────────────┘");
}

// ============================================================
// MULTI-CYCLE SIMULATION
// ============================================================

interface CycleResult {
  cycleNumber: number;
  startingBalance: number;
  endingBalance: number;
  totalAttempts: number;
  totalPrizeWon: number;
  totalConsolation: number;
  totalCostPaid: number;
  tier9Prize: number;
}

function simulateMultipleCycles(startingBalance: number, numCycles: number): CycleResult[] {
  const results: CycleResult[] = [];
  let currentBalance = startingBalance;
  
  for (let cycle = 1; cycle <= numCycles; cycle++) {
    // Check if jackpot is too low to continue
    if (currentBalance < 0.1) {
      console.log(`\n⚠️ Jackpot depleted at cycle ${cycle} (${currentBalance.toFixed(4)} EVA)`);
      break;
    }
    
    const simResult = simulateFullProgression(currentBalance);
    
    results.push({
      cycleNumber: cycle,
      startingBalance: currentBalance,
      endingBalance: simResult.finalJackpotBalance,
      totalAttempts: simResult.totalAttempts,
      totalPrizeWon: simResult.totalPrizeWon,
      totalConsolation: simResult.totalConsolation,
      totalCostPaid: simResult.totalCostPaid,
      tier9Prize: simResult.tierStats[8].prize,
    });
    
    // Next cycle starts with remaining balance
    currentBalance = simResult.finalJackpotBalance;
  }
  
  return results;
}

function runMultiCycleSimulation(startingBalance: number, numCycles: number, numRuns: number) {
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log(`          MULTI-CYCLE SIMULATION (${numCycles} cycles × ${numRuns} runs)              `);
  console.log("═══════════════════════════════════════════════════════════════════════════\n");
  console.log(`Starting Jackpot: ${startingBalance} EVA`);
  console.log(`Cost per attempt: ${COST_BPS / 100}% of prize\n`);
  
  const allRuns: CycleResult[][] = [];
  
  for (let run = 0; run < numRuns; run++) {
    const cycles = simulateMultipleCycles(startingBalance, numCycles);
    allRuns.push(cycles);
  }
  
  // Show detailed results for first run
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("DETAILED RUN #1");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  console.log("┌───────┬────────────┬────────────┬──────────┬────────────┬────────────┐");
  console.log("│ Cycle │ Start EVA  │  End EVA   │ Attempts │ Tier9 Prize│   Change   │");
  console.log("├───────┼────────────┼────────────┼──────────┼────────────┼────────────┤");
  
  for (const cycle of allRuns[0]) {
    const change = cycle.endingBalance - cycle.startingBalance;
    const changeStr = change >= 0 ? `+${change.toFixed(2)}` : change.toFixed(2);
    console.log(
      `│  ${cycle.cycleNumber.toString().padStart(3)}  │ ` +
      `${cycle.startingBalance.toFixed(2).padStart(10)} │ ` +
      `${cycle.endingBalance.toFixed(2).padStart(10)} │ ` +
      `${cycle.totalAttempts.toString().padStart(8)} │ ` +
      `${cycle.tier9Prize.toFixed(2).padStart(10)} │ ` +
      `${changeStr.padStart(10)} │`
    );
  }
  console.log("└───────┴────────────┴────────────┴──────────┴────────────┴────────────┘");
  
  // Aggregate statistics across all runs
  console.log("\n═══════════════════════════════════════════════════════════════════════════");
  console.log("                    AGGREGATE ACROSS ALL RUNS                              ");
  console.log("═══════════════════════════════════════════════════════════════════════════\n");
  
  // Calculate per-cycle averages
  const cycleStats: { 
    avgStart: number; 
    avgEnd: number; 
    avgAttempts: number; 
    avgTier9: number;
    avgChange: number;
  }[] = [];
  
  for (let c = 0; c < numCycles; c++) {
    const cyclesAtIndex = allRuns.map(run => run[c]).filter(Boolean);
    if (cyclesAtIndex.length === 0) break;
    
    cycleStats.push({
      avgStart: cyclesAtIndex.reduce((sum, r) => sum + r.startingBalance, 0) / cyclesAtIndex.length,
      avgEnd: cyclesAtIndex.reduce((sum, r) => sum + r.endingBalance, 0) / cyclesAtIndex.length,
      avgAttempts: cyclesAtIndex.reduce((sum, r) => sum + r.totalAttempts, 0) / cyclesAtIndex.length,
      avgTier9: cyclesAtIndex.reduce((sum, r) => sum + r.tier9Prize, 0) / cyclesAtIndex.length,
      avgChange: cyclesAtIndex.reduce((sum, r) => sum + (r.endingBalance - r.startingBalance), 0) / cyclesAtIndex.length,
    });
  }
  
  console.log("┌───────┬────────────┬────────────┬──────────┬────────────┬────────────┐");
  console.log("│ Cycle │ Avg Start  │  Avg End   │ Avg Att. │ Avg Tier9  │ Avg Change │");
  console.log("├───────┼────────────┼────────────┼──────────┼────────────┼────────────┤");
  
  for (let i = 0; i < cycleStats.length; i++) {
    const s = cycleStats[i];
    const changeStr = s.avgChange >= 0 ? `+${s.avgChange.toFixed(2)}` : s.avgChange.toFixed(2);
    console.log(
      `│  ${(i + 1).toString().padStart(3)}  │ ` +
      `${s.avgStart.toFixed(2).padStart(10)} │ ` +
      `${s.avgEnd.toFixed(2).padStart(10)} │ ` +
      `${s.avgAttempts.toFixed(1).padStart(8)} │ ` +
      `${s.avgTier9.toFixed(2).padStart(10)} │ ` +
      `${changeStr.padStart(10)} │`
    );
  }
  console.log("└───────┴────────────┴────────────┴──────────┴────────────┴────────────┘");
  
  // Final summary
  const finalBalances = allRuns.map(run => run[run.length - 1]?.endingBalance || 0);
  const avgFinalBalance = finalBalances.reduce((a, b) => a + b, 0) / finalBalances.length;
  const minFinalBalance = Math.min(...finalBalances);
  const maxFinalBalance = Math.max(...finalBalances);
  
  const totalTier9Prizes = allRuns.map(run => run.reduce((sum, c) => sum + c.tier9Prize, 0));
  const avgTotalTier9 = totalTier9Prizes.reduce((a, b) => a + b, 0) / totalTier9Prizes.length;
  
  console.log("\n📊 RESUMEN FINAL:");
  console.log(`   Jackpot inicial:        ${startingBalance} EVA`);
  console.log(`   Jackpot final promedio: ${avgFinalBalance.toFixed(2)} EVA`);
  console.log(`   Jackpot final min:      ${minFinalBalance.toFixed(2)} EVA`);
  console.log(`   Jackpot final max:      ${maxFinalBalance.toFixed(2)} EVA`);
  console.log(`   Cambio total promedio:  ${(avgFinalBalance - startingBalance) >= 0 ? '+' : ''}${(avgFinalBalance - startingBalance).toFixed(2)} EVA`);
  console.log(`   Tier 9 total promedio:  ${avgTotalTier9.toFixed(2)} EVA (across ${numCycles} cycles)`);
  console.log(`   Tier 9 promedio/ciclo:  ${(avgTotalTier9 / numCycles).toFixed(2)} EVA`);
  
  // Sustainability check
  const growthRate = ((avgFinalBalance / startingBalance) - 1) * 100;
  console.log(`\n🎯 SOSTENIBILIDAD:`);
  if (growthRate > 5) {
    console.log(`   ✅ Jackpot CRECE ${growthRate.toFixed(1)}% en ${numCycles} ciclos`);
    console.log(`   → Sistema sostenible, puede reducir costos o aumentar premios`);
  } else if (growthRate > -5) {
    console.log(`   ✅ Jackpot ESTABLE (${growthRate >= 0 ? '+' : ''}${growthRate.toFixed(1)}% en ${numCycles} ciclos)`);
    console.log(`   → Sistema balanceado perfectamente`);
  } else if (growthRate > -30) {
    console.log(`   ⚠️ Jackpot DECRECE ${growthRate.toFixed(1)}% en ${numCycles} ciclos`);
    console.log(`   → Necesita ajustes menores para ser sostenible`);
  } else {
    console.log(`   ❌ Jackpot INSOSTENIBLE (${growthRate.toFixed(1)}% en ${numCycles} ciclos)`);
    console.log(`   → Se vaciará rápidamente, aumentar costos o reducir premios`);
  }
}

// ============================================================
// MAIN
// ============================================================

const STARTING_BALANCE = 20; // EVA
const NUM_CYCLES = 20;       // Ciclos consecutivos (más para mejor estadística)
const NUM_RUNS = 10;         // Veces que repetimos la simulación

console.log("\n");
printExpectedValues(STARTING_BALANCE);
runMultiCycleSimulation(STARTING_BALANCE, NUM_CYCLES, NUM_RUNS);

