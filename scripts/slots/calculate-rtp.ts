/**
 * RTP Calculator for MultiLineSlots
 * 
 * This script helps calculate the expected RTP based on symbol configurations.
 * Use it to tune symbol weights and payouts before deploying.
 */

interface SymbolConfig {
  name: string;
  weightBps: number;      // Weight in basis points (sum should be 10000)
  threeMatchPayout: number;  // Payout for 3 matching (in hundredths, 150 = 1.5x)
  twoMatchPayout: number;    // Payout for 2 matching (in hundredths, 50 = 0.5x)
  isWild: boolean;
  enabled: boolean;
}

interface RTPBreakdown {
  symbol: string;
  weight: number;
  threeMatchProb: number;
  threeMatchRTP: number;
  twoMatchProb: number;
  twoMatchRTP: number;
  totalRTP: number;
}

/**
 * Calculate RTP for a single payline (without wilds for simplicity)
 */
function calculateSingleLineRTP(symbols: SymbolConfig[]): {
  totalRTP: number;
  breakdown: RTPBreakdown[];
} {
  const enabledSymbols = symbols.filter(s => s.enabled && !s.isWild);
  const totalWeight = symbols.filter(s => s.enabled).reduce((sum, s) => sum + s.weightBps, 0);
  
  const breakdown: RTPBreakdown[] = [];
  let totalRTP = 0;

  for (const symbol of enabledSymbols) {
    const weight = symbol.weightBps / totalWeight;
    
    // 3-match probability: weight^3
    const p3 = Math.pow(weight, 3);
    const rtp3 = p3 * (symbol.threeMatchPayout / 100);
    
    // 2-match probability: 3 * weight^2 * (1 - weight)
    const p2 = 3 * Math.pow(weight, 2) * (1 - weight);
    const rtp2 = p2 * (symbol.twoMatchPayout / 100);
    
    const symbolRTP = rtp3 + rtp2;
    totalRTP += symbolRTP;

    breakdown.push({
      symbol: symbol.name,
      weight: weight * 100,
      threeMatchProb: p3 * 100,
      threeMatchRTP: rtp3 * 100,
      twoMatchProb: p2 * 100,
      twoMatchRTP: rtp2 * 100,
      totalRTP: symbolRTP * 100,
    });
  }

  // Add wild boost estimate (simplified)
  const wildSymbol = symbols.find(s => s.enabled && s.isWild);
  if (wildSymbol) {
    const wildWeight = wildSymbol.weightBps / totalWeight;
    // Rough estimate: wilds boost RTP by increasing match probabilities
    // Each non-wild symbol gets boosted by ~3 * weight * wildWeight
    const wildBoost = enabledSymbols.reduce((sum, s) => {
      const w = s.weightBps / totalWeight;
      // Boost for 3-match with 1 wild: 3 * w^2 * wildWeight
      const boost3 = 3 * Math.pow(w, 2) * wildWeight * (s.threeMatchPayout / 100);
      // Boost for 3-match with 2 wilds: 3 * w * wildWeight^2
      const boost3_2 = 3 * w * Math.pow(wildWeight, 2) * (s.threeMatchPayout / 100);
      return sum + boost3 + boost3_2;
    }, 0);
    
    totalRTP += wildBoost;
    
    breakdown.push({
      symbol: `${wildSymbol.name} (WILD BOOST)`,
      weight: wildWeight * 100,
      threeMatchProb: 0,
      threeMatchRTP: wildBoost * 100,
      twoMatchProb: 0,
      twoMatchRTP: 0,
      totalRTP: wildBoost * 100,
    });
  }

  return { totalRTP: totalRTP * 100, breakdown };
}

/**
 * Calculate effective RTP considering fees
 */
function calculateEffectiveRTP(
  houseEdgeBps: number,
  referralBps: number,
  jackpotContributionBps: number
): { effectiveEdge: number; targetRTP: number } {
  // Net stake rate = 100% - house - referral
  const netStakeRate = 10000 - houseEdgeBps - referralBps;
  
  // Pool funding rate = netStakeRate * (1 - jackpotContribution)
  const poolFundingRate = (netStakeRate * (10000 - jackpotContributionBps)) / 10000;
  
  // Effective edge = 100% - poolFundingRate
  const effectiveEdge = 10000 - poolFundingRate;
  
  return {
    effectiveEdge: effectiveEdge / 100,
    targetRTP: poolFundingRate / 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//                          EXAMPLE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

// Configuration tuned for ~92.64% RTP (to match 7.36% effective edge)
// Fine-tuned payouts to achieve target RTP
const exampleSymbols: SymbolConfig[] = [
  {
    name: "Cherry 🍒",
    weightBps: 3000,  // 30%
    threeMatchPayout: 405,   // 4.05x
    twoMatchPayout: 53,      // 0.53x
    isWild: false,
    enabled: true,
  },
  {
    name: "Lemon 🍋",
    weightBps: 2700,  // 27%
    threeMatchPayout: 510,   // 5.1x
    twoMatchPayout: 63,      // 0.63x
    isWild: false,
    enabled: true,
  },
  {
    name: "Orange 🍊",
    weightBps: 2000,  // 20%
    threeMatchPayout: 815,   // 8.15x
    twoMatchPayout: 107,     // 1.07x
    isWild: false,
    enabled: true,
  },
  {
    name: "Diamond 💎",
    weightBps: 1300,  // 13%
    threeMatchPayout: 1830,  // 18.3x
    twoMatchPayout: 215,     // 2.15x
    isWild: false,
    enabled: true,
  },
  {
    name: "Tiger 🐯",
    weightBps: 800,   // 8%
    threeMatchPayout: 5100,  // 51.0x
    twoMatchPayout: 420,     // 4.2x
    isWild: false,
    enabled: true,
  },
  {
    name: "Star 🌟",
    weightBps: 200,   // 2%
    threeMatchPayout: 0,     // Wild doesn't have own payout
    twoMatchPayout: 0,
    isWild: true,
    enabled: true,
  },
];

// ═══════════════════════════════════════════════════════════════════════
//                              MAIN
// ═══════════════════════════════════════════════════════════════════════

function main() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("                    MULTILINE SLOTS RTP CALCULATOR                  ");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Calculate effective RTP target
  const fees = calculateEffectiveRTP(200, 200, 350); // 2% house, 2% referral, 3.5% jackpot
  
  console.log("FEE STRUCTURE:");
  console.log("─────────────────────────────────────────────────────────────────");
  console.log(`  House Edge:              2.00%`);
  console.log(`  Referral Fee:            2.00%`);
  console.log(`  Jackpot Contribution:    3.50%`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Effective Edge:          ${fees.effectiveEdge.toFixed(2)}%`);
  console.log(`  TARGET RTP:              ${fees.targetRTP.toFixed(2)}%`);
  console.log("");

  // Calculate symbol RTP
  const { totalRTP, breakdown } = calculateSingleLineRTP(exampleSymbols);
  
  console.log("SYMBOL CONFIGURATION:");
  console.log("─────────────────────────────────────────────────────────────────");
  console.log("┌─────────────────┬────────┬──────────────┬──────────────┬──────────┐");
  console.log("│ Symbol          │ Weight │ 3-Match RTP  │ 2-Match RTP  │ Total    │");
  console.log("├─────────────────┼────────┼──────────────┼──────────────┼──────────┤");
  
  for (const b of breakdown) {
    const name = b.symbol.padEnd(15);
    const weight = b.weight.toFixed(1).padStart(5) + "%";
    const rtp3 = b.threeMatchRTP.toFixed(2).padStart(10) + "%";
    const rtp2 = b.twoMatchRTP.toFixed(2).padStart(10) + "%";
    const total = b.totalRTP.toFixed(2).padStart(6) + "%";
    console.log(`│ ${name} │ ${weight} │ ${rtp3} │ ${rtp2} │ ${total} │`);
  }
  
  console.log("├─────────────────┼────────┼──────────────┼──────────────┼──────────┤");
  console.log(`│ TOTAL RTP       │        │              │              │ ${totalRTP.toFixed(2).padStart(6)}% │`);
  console.log("└─────────────────┴────────┴──────────────┴──────────────┴──────────┘");
  console.log("");

  // Compare with target
  const diff = totalRTP - fees.targetRTP;
  const status = Math.abs(diff) < 1 ? "✅ GOOD" : diff > 0 ? "⚠️ TOO HIGH" : "⚠️ TOO LOW";
  
  console.log("ANALYSIS:");
  console.log("─────────────────────────────────────────────────────────────────");
  console.log(`  Calculated RTP:  ${totalRTP.toFixed(2)}%`);
  console.log(`  Target RTP:      ${fees.targetRTP.toFixed(2)}%`);
  console.log(`  Difference:      ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}%`);
  console.log(`  Status:          ${status}`);
  console.log("");

  if (Math.abs(diff) >= 1) {
    console.log("RECOMMENDATION:");
    console.log("─────────────────────────────────────────────────────────────────");
    if (diff > 0) {
      console.log("  RTP is too high. Consider:");
      console.log("    - Reducing payouts");
      console.log("    - Increasing weights of low-paying symbols");
    } else {
      console.log("  RTP is too low. Consider:");
      console.log("    - Increasing payouts");
      console.log("    - Increasing weights of high-paying symbols");
    }
    console.log("");
  }

  // Output Solidity configuration
  console.log("SOLIDITY CONFIGURATION:");
  console.log("─────────────────────────────────────────────────────────────────");
  console.log("// Copy this to your deployment script:\n");
  console.log("const symbolConfigs = [");
  for (let i = 0; i < exampleSymbols.length; i++) {
    const s = exampleSymbols[i];
    console.log(`  { // ${i}: ${s.name}`);
    console.log(`    weightBps: ${s.weightBps},`);
    console.log(`    threeMatchPayout: ${s.threeMatchPayout},`);
    console.log(`    twoMatchPayout: ${s.twoMatchPayout},`);
    console.log(`    isWild: ${s.isWild},`);
    console.log(`    enabled: ${s.enabled},`);
    console.log(`  },`);
  }
  console.log("];");
}

main();

