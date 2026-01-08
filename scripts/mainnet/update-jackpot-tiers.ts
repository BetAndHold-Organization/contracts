import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

// ============================================================
// CONFIGURE YOUR NEW TIER LADDER HERE
// 
// NEW BALANCED CONFIGURATION (simulated for sustainability)
// - Total prizes: 3+3+4+5+7+10+15+18+45 = 110% distributed across tiers
// - Cost per attempt: 17.5% of tier prize
// - Jackpot stable over 20+ cycles (-1.7% change)
// - Tier 9 avg payout: ~15 EVA (with 20 EVA jackpot)
// ============================================================
function buildTierLadder() {
  // Each tier config:
  // - prizeMetric: % of jackpot (if isPercent=true) or fixed EVA amount
  // - isTerminal: if true, winning resets player to tier 0
  // - isPercent: true = % of balance, false = fixed amount
  // - fixedBetCost: fixed cost in wei (use 0n if dynamic)
  // - useDynamicCost: true = cost derived from prize %
  // - costBps: % of prize as bet cost (e.g., 1750 = 17.5%)

  const TIER_COUNT = 9;
  
  // Prize percentages for each tier (in bps: 300 = 3%, 4500 = 45%, etc.)
  // Escalating prizes: small early, big at the end
  const PRIZES = [
    300n,   // Tier 1: 3%
    300n,   // Tier 2: 3%
    400n,   // Tier 3: 4%
    500n,   // Tier 4: 5%
    700n,   // Tier 5: 7%
    1000n,  // Tier 6: 10%
    1500n,  // Tier 7: 15%
    1800n,  // Tier 8: 18%
    4500n,  // Tier 9: 45% (GRAND PRIZE)
  ];
  
  // Cost as % of prize (1750 = 17.5% of prize) - BALANCED FOR SUSTAINABILITY
  const COST_BPS = 1750;

  return Array.from({ length: TIER_COUNT }, (_, index) => ({
    prizeMetric: PRIZES[index],
    isTerminal: index === TIER_COUNT - 1,
    isPercent: true,
    fixedBetCost: 0n,
    useDynamicCost: true,
    costBps: COST_BPS,
  }));
}
// ============================================================

async function loadDeployment(): Promise<{ jackpot: Addr }> {
  // Change path if using a different deployment file
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

  const jackpot = await viem.getContractAt("ProgressiveJackpot", deployment.jackpot);

  // Build and display new tier config
  const newTiers = buildTierLadder();
  console.log("\nNew tier configuration:");
  newTiers.forEach((t, i) => {
    console.log(`  Tier ${i + 1}: ${t.prizeMetric}bps (${Number(t.prizeMetric) / 100}%), costBps: ${t.costBps}, terminal: ${t.isTerminal}`);
  });

  // Update tier ladder
  console.log("\nUpdating tier ladder...");
  const tx = await jackpot.write.setTierLadder([newTiers], { account: deployer.account });
  console.log("Tx:", tx);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("✓ Tier ladder updated!");

  // Verify
  const ladder = await jackpot.read.getTierLadder();
  console.log("\nVerification - current tiers:");
  (ladder as any[]).forEach((t: any, i: number) => {
    console.log(`  Tier ${i + 1}: ${t.prizeMetric}bps, costBps: ${t.costBps}, terminal: ${t.isTerminal}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

