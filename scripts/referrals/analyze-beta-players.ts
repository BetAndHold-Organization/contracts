import playersData from "./players-backup.json";
import { formatEther } from "viem";

// Sort players by totalBets descending
const players = [...playersData.nodes]
  .filter(p => p.totalBets > 0)
  .sort((a, b) => b.totalBets - a.totalBets);

console.log("═══════════════════════════════════════════════════════════════");
console.log("  BETA PLAYERS ANALYSIS");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`Total players with bets: ${players.length}`);
console.log("");

// Show top 15 players
console.log("TOP 15 PLAYERS (Most Active - Potential Level 1 Referrers):");
console.log("─────────────────────────────────────────────────────────────────");
for (let i = 0; i < Math.min(15, players.length); i++) {
  const p = players[i];
  const wager = formatEther(BigInt(p.totalWager));
  console.log(`${(i+1).toString().padStart(2)}. ${p.address} | ${p.totalBets.toString().padStart(3)} bets | ${parseFloat(wager).toFixed(1).padStart(6)} EVA`);
}
console.log("");

// Show bottom 15 players
console.log("BOTTOM 15 PLAYERS (Least Active - Will be Referred):");
console.log("─────────────────────────────────────────────────────────────────");
for (let i = Math.max(0, players.length - 15); i < players.length; i++) {
  const p = players[i];
  const wager = formatEther(BigInt(p.totalWager));
  console.log(`${(i+1).toString().padStart(2)}. ${p.address} | ${p.totalBets.toString().padStart(3)} bets | ${parseFloat(wager).toFixed(1).padStart(6)} EVA`);
}
console.log("");

// Proposed structure
console.log("═══════════════════════════════════════════════════════════════");
console.log("  PROPOSED REFERRAL STRUCTURE");
console.log("═══════════════════════════════════════════════════════════════");

const HOUSE = "0x8248f7b7f7cb8fa51db9138b42a6bb7af1721e9e"; // House wallet

// Tier 1: Top 5 players → referred by House
const tier1Count = 5;
const tier1 = players.slice(0, tier1Count);

// Tier 2: Next 10 players → distributed among Tier 1
const tier2Count = 10;
const tier2 = players.slice(tier1Count, tier1Count + tier2Count);

// Tier 3: Rest → distributed among Tier 1 + Tier 2
const tier3 = players.slice(tier1Count + tier2Count);

console.log("");
console.log(`TIER 1 (${tier1.length} players) → Referred by HOUSE`);
console.log("These are your top performers who will earn from everyone below:");
for (const p of tier1) {
  console.log(`  • ${p.address} (${p.totalBets} bets)`);
}

console.log("");
console.log(`TIER 2 (${tier2.length} players) → Referred by Tier 1`);
console.log("Distributed evenly among Tier 1 referrers:");
for (let i = 0; i < tier2.length; i++) {
  const referrer = tier1[i % tier1.length];
  console.log(`  • ${tier2[i].address.slice(0,10)}... (${tier2[i].totalBets} bets) → ${referrer.address.slice(0,10)}...`);
}

console.log("");
console.log(`TIER 3 (${tier3.length} players) → Referred by Tier 1 & 2`);
console.log("Distributed among all Tier 1 + Tier 2 referrers:");

// Build the full referral structure
const referralStructure: Array<{referee: string, referrer: string, refereeBets: number, referrerBets: number}> = [];

// Tier 1 → House
for (const p of tier1) {
  referralStructure.push({
    referee: p.address,
    referrer: HOUSE,
    refereeBets: p.totalBets,
    referrerBets: 0
  });
}

// Tier 2 → Tier 1 (round robin)
for (let i = 0; i < tier2.length; i++) {
  const referrer = tier1[i % tier1.length];
  referralStructure.push({
    referee: tier2[i].address,
    referrer: referrer.address,
    refereeBets: tier2[i].totalBets,
    referrerBets: referrer.totalBets
  });
}

// Tier 3 → Tier 1 + Tier 2 (round robin)
const allReferrers = [...tier1, ...tier2];
for (let i = 0; i < tier3.length; i++) {
  const referrer = allReferrers[i % allReferrers.length];
  referralStructure.push({
    referee: tier3[i].address,
    referrer: referrer.address,
    refereeBets: tier3[i].totalBets,
    referrerBets: referrer.totalBets
  });
}

// Count referees per referrer
const referrerCounts: Record<string, number> = {};
for (const r of referralStructure) {
  referrerCounts[r.referrer] = (referrerCounts[r.referrer] || 0) + 1;
}

console.log("");
console.log("REFERRER DISTRIBUTION:");
console.log("─────────────────────────────────────────────────────────────────");
const sortedReferrers = Object.entries(referrerCounts).sort((a, b) => b[1] - a[1]);
for (const [addr, count] of sortedReferrers) {
  const player = players.find(p => p.address.toLowerCase() === addr.toLowerCase());
  const bets = player ? player.totalBets : 0;
  console.log(`  ${addr.slice(0,10)}... | ${count.toString().padStart(2)} referees | ${bets.toString().padStart(3)} bets`);
}

console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  SUMMARY");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`Total referral relationships: ${referralStructure.length}`);
console.log(`Unique referrers: ${Object.keys(referrerCounts).length}`);
console.log("");

// Output JSON for seeding
const seedData = {
  referrals: referralStructure.map(r => ({
    referee: r.referee,
    referrer: r.referrer
  }))
};

import { writeFileSync } from "fs";
writeFileSync(
  new URL("./beta-referral-seed.json", import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
  JSON.stringify(seedData, null, 2)
);
console.log("✓ Saved to scripts/referrals/beta-referral-seed.json");

