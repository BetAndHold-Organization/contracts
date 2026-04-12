import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const DEPLOYMENT = {
  roulette: "0x29a597c324dce8f075d55acc7b0e65563ae180ab" as Addr,
};

// ─── New Table Config ───────────────────────────────────────────────────────
// Only change: maxWager raised from 3 EVA to 5 EVA
const NEW_TABLE_CONFIG = {
  enabled: true,
  replayBps: 500,                          // 5% replay (unchanged)
  jackpotBps: 300,                         // 3% base jackpot (static fallback, unchanged)
  jackpotContributionBps: 300,             // 3% of net stake → jackpot (unchanged)
  minMultiplier: 101,                      // 1.01x (unchanged)
  maxMultiplier: 10000,                    // 100x (unchanged)
  minWager: parseEther("0.1"),             // 0.1 EVA (unchanged)
  maxWager: parseEther("5"),               // 5 EVA (was 3 EVA)
};

// ─── New Jackpot Scaling Config ─────────────────────────────────────────────
// Logarithmic curve: probability scales from 3% (at 0.1 EVA) to 6.51% (at 5 EVA)
// 651 bps is the mathematically safe cap — no zero-lose edge case at any multiplier
const NEW_SCALING_CONFIG = {
  enabled: true,
  minJackpotBps: 300,                      // 3% at minJackpotWager
  maxJackpotBps: 651,                      // 6.51% at maxJackpotWager (safe cap)
  minJackpotWager: parseEther("0.1"),      // scaling starts here
  maxJackpotWager: parseEther("5"),        // scaling caps here
  functionId: 2,                           // 0=Linear, 1=Quadratic, 2=Logarithmic, 3=Exponential
  extraData: "0x" as `0x${string}`,        // reserved, empty
};

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  UPDATE ROULETTE CONFIG — V5 MAINNET");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Network:  ", await publicClient.getChainId());
  console.log("Deployer: ", deployer.account.address);
  console.log("Roulette: ", DEPLOYMENT.roulette);
  console.log("");

  const roulette = await viem.getContractAt("SingleRandomRouletteV2", DEPLOYMENT.roulette);

  // ── Read current config ──────────────────────────────────────────────────
  const oldIdx = await roulette.read.currentConfigIndex();
  const oldCfg = await roulette.read.getTableConfig([]);
  const oldScl = await roulette.read.getJackpotScalingConfig([]);

  console.log("CURRENT CONFIG (index " + Number(oldIdx) + "):");
  console.log("  maxWager:          ", formatEther(oldCfg.maxWager), "EVA");
  console.log("  jackpotBps:        ", Number(oldCfg.jackpotBps), "(" + (Number(oldCfg.jackpotBps) / 100) + "%)");
  console.log("  scaling enabled:   ", oldScl.enabled);
  if (oldScl.enabled) {
    console.log("  scaling range:     ", Number(oldScl.minJackpotBps) + "–" + Number(oldScl.maxJackpotBps) + " bps");
  }
  console.log("");

  // ── Step 1: Set new table config ─────────────────────────────────────────
  console.log("Step 1: setTableConfig (maxWager → 5 EVA)...");
  let tx = await roulette.write.setTableConfig(
    [NEW_TABLE_CONFIG],
    { account: deployer.account }
  );
  let receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  TX:", tx);
  console.log("  Confirmed block", receipt.blockNumber, " gas=" + receipt.gasUsed);

  const newIdx = await roulette.read.currentConfigIndex();
  console.log("  New config index:", Number(newIdx));
  console.log("");

  // ── Step 2: Set jackpot scaling config ───────────────────────────────────
  console.log("Step 2: setJackpotScalingConfig (Logarithmic 3%→6.51%)...");
  tx = await roulette.write.setJackpotScalingConfig(
    [NEW_SCALING_CONFIG],
    { account: deployer.account }
  );
  receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  TX:", tx);
  console.log("  Confirmed block", receipt.blockNumber, " gas=" + receipt.gasUsed);
  console.log("");

  // ── Verify ───────────────────────────────────────────────────────────────
  console.log("VERIFYING ON-CHAIN...");
  const verifyCfg = await roulette.read.getTableConfig([]);
  const verifyScl = await roulette.read.getJackpotScalingConfig([]);
  const verifyIdx = await roulette.read.currentConfigIndex();

  console.log("  Config index:           ", Number(verifyIdx));
  console.log("  enabled:                ", verifyCfg.enabled);
  console.log("  replayBps:              ", Number(verifyCfg.replayBps), "(" + (Number(verifyCfg.replayBps) / 100) + "%)");
  console.log("  jackpotBps:             ", Number(verifyCfg.jackpotBps), "(" + (Number(verifyCfg.jackpotBps) / 100) + "%)");
  console.log("  jackpotContributionBps: ", Number(verifyCfg.jackpotContributionBps), "(" + (Number(verifyCfg.jackpotContributionBps) / 100) + "%)");
  console.log("  minMultiplier:          ", Number(verifyCfg.minMultiplier), "(" + (Number(verifyCfg.minMultiplier) / 100) + "x)");
  console.log("  maxMultiplier:          ", Number(verifyCfg.maxMultiplier), "(" + (Number(verifyCfg.maxMultiplier) / 100) + "x)");
  console.log("  minWager:               ", formatEther(verifyCfg.minWager), "EVA");
  console.log("  maxWager:               ", formatEther(verifyCfg.maxWager), "EVA");
  console.log("");
  console.log("  scaling enabled:        ", verifyScl.enabled);
  console.log("  minJackpotBps:          ", Number(verifyScl.minJackpotBps), "(" + (Number(verifyScl.minJackpotBps) / 100) + "%)");
  console.log("  maxJackpotBps:          ", Number(verifyScl.maxJackpotBps), "(" + (Number(verifyScl.maxJackpotBps) / 100) + "%)");
  console.log("  minJackpotWager:        ", formatEther(verifyScl.minJackpotWager), "EVA");
  console.log("  maxJackpotWager:        ", formatEther(verifyScl.maxJackpotWager), "EVA");
  console.log("  functionId:             ", Number(verifyScl.functionId), "(0=Linear, 1=Quadratic, 2=Logarithmic, 3=Exponential)");
  console.log("");

  // ── Show jackpot probability curve ───────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  JACKPOT PROBABILITY CURVE (Logarithmic √x)");
  console.log("═══════════════════════════════════════════════════════════════");

  const ONE = 1e18;
  const minW = 0.1;
  const maxW = 5.0;
  const span = maxW - minW;
  const minBps = 300;
  const maxBps = 651;
  const delta = maxBps - minBps;

  const wagers = [0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
  for (const w of wagers) {
    let bps: number;
    if (w <= minW) { bps = minBps; }
    else if (w >= maxW) { bps = maxBps; }
    else {
      const pos = (w - minW) / span;
      const scaled = Math.sqrt(pos);
      bps = Math.floor(minBps + delta * scaled);
    }
    const bar = "█".repeat(Math.round(bps / 40));
    console.log(`  ${w.toFixed(2)} EVA → ${bps} bps (${(bps / 100).toFixed(2)}%)  ${bar}`);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  CONFIGURATION UPDATE COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
