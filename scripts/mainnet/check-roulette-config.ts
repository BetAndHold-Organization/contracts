import { network } from "hardhat";
import "dotenv/config";

type Addr = `0x${string}`;

const V5_ROULETTE = "0x29a597c324dce8f075d55acc7b0e65563ae180ab" as Addr;
const V5_HANDLER  = "0xabe66fc056dd0e116b90201e487ea102fd7df1ba" as Addr;

const V4_ROULETTE = "0xb3f60ca15dea4434fa7bc364563ac1f05d4ac142" as Addr;
const V4_HANDLER  = "0xce9f2e4586d674162610daec693ae9b1083c11d4" as Addr;

function bpsToPercent(bps: number) { return (bps / 100).toFixed(2) + "%"; }
function toEVA(wei: bigint) { return (Number(wei) / 1e18).toFixed(2) + " EVA"; }
function multStr(h: number) { return (h / 100).toFixed(2) + "x"; }

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;

  const rouletteV5 = await viem.getContractAt("SingleRandomRouletteV2", V5_ROULETTE);
  const rouletteV4 = await viem.getContractAt("SingleRandomRoulette", V4_ROULETTE);
  const handlerV5  = await viem.getContractAt("PaymentHandler", V5_HANDLER);
  const handlerV4  = await viem.getContractAt("PaymentHandler", V4_HANDLER);

  const v5Cfg = await rouletteV5.read.getTableConfig([]);
  const v5Scl = await rouletteV5.read.getJackpotScalingConfig([]);
  const v5Idx = await rouletteV5.read.currentConfigIndex();
  const v5Jp  = await rouletteV5.read.jackpot();
  const v5Hcfg = await handlerV5.read.getGameConfig([V5_ROULETTE]);

  const v4Cfg = await rouletteV4.read.getTableConfig([]);
  const v4Scl = await rouletteV4.read.getJackpotScalingConfig([]);
  const v4Idx = await rouletteV4.read.currentConfigIndex();
  const v4Jp  = await rouletteV4.read.jackpot();
  const v4Hcfg = await handlerV4.read.getGameConfig([V4_ROULETTE]);

  function printConfig(label: string, addr: string, cfg: any, scl: any, idx: any, jp: string, hcfg: any) {
    console.log("");
    console.log("─".repeat(80));
    console.log(`  ${label}  (${addr})`);
    console.log("─".repeat(80));
    console.log(`  Config index:           ${Number(idx)}`);
    console.log(`  enabled:                ${cfg.enabled}`);
    console.log(`  replayBps:              ${Number(cfg.replayBps)}  (${bpsToPercent(Number(cfg.replayBps))})`);
    console.log(`  jackpotBps:             ${Number(cfg.jackpotBps)}  (${bpsToPercent(Number(cfg.jackpotBps))})`);
    console.log(`  jackpotContributionBps: ${Number(cfg.jackpotContributionBps)}  (${bpsToPercent(Number(cfg.jackpotContributionBps))})`);
    console.log(`  minMultiplier:          ${Number(cfg.minMultiplier)}  (${multStr(Number(cfg.minMultiplier))})`);
    console.log(`  maxMultiplier:          ${Number(cfg.maxMultiplier)}  (${multStr(Number(cfg.maxMultiplier))})`);
    console.log(`  minWager:               ${cfg.minWager}  (${toEVA(cfg.minWager)})`);
    console.log(`  maxWager:               ${cfg.maxWager}  (${toEVA(cfg.maxWager)})`);
    console.log(`  jackpot address:        ${jp}`);
    console.log(`  scaling enabled:        ${scl.enabled}`);
    if (scl.enabled) {
      console.log(`    minJackpotBps:        ${Number(scl.minJackpotBps)}`);
      console.log(`    maxJackpotBps:        ${Number(scl.maxJackpotBps)}`);
    }
    console.log(`  Handler config:`);
    console.log(`    payoutTarget:         ${hcfg[0]}`);
    console.log(`    feeCollector:         ${hcfg[1]}`);
    console.log(`    treasury:             ${hcfg[2]}`);
    console.log(`    houseEdgeBps:         ${Number(hcfg[3])}  (${bpsToPercent(Number(hcfg[3]))})`);
    console.log(`    referralBps:          ${Number(hcfg[4])}  (${bpsToPercent(Number(hcfg[4]))})`);
  }

  console.log("");
  console.log("═".repeat(80));
  console.log("  ON-CHAIN ROULETTE + JACKPOT CONFIGURATION (LIVE READ)");
  console.log("═".repeat(80));

  printConfig("V4 ROULETTE", V4_ROULETTE, v4Cfg, v4Scl, v4Idx, v4Jp, v4Hcfg);
  printConfig("V5 ROULETTE", V5_ROULETTE, v5Cfg, v5Scl, v5Idx, v5Jp, v5Hcfg);

  console.log("");
  console.log("═".repeat(80));
  console.log("  DIFF (V4 → V5)");
  console.log("═".repeat(80));

  const fields = ["enabled", "replayBps", "jackpotBps", "jackpotContributionBps", "minMultiplier", "maxMultiplier", "minWager", "maxWager"] as const;
  let anyDiff = false;
  for (const f of fields) {
    const a = v4Cfg[f];
    const b = v5Cfg[f];
    if (a.toString() !== b.toString()) {
      anyDiff = true;
      console.log(`  CHANGED ${f}: ${a} → ${b}`);
    }
  }
  if (Number(v4Hcfg[3]) !== Number(v5Hcfg[3])) {
    anyDiff = true;
    console.log(`  CHANGED houseEdgeBps: ${Number(v4Hcfg[3])} → ${Number(v5Hcfg[3])}`);
  }
  if (Number(v4Hcfg[4]) !== Number(v5Hcfg[4])) {
    anyDiff = true;
    console.log(`  CHANGED referralBps: ${Number(v4Hcfg[4])} → ${Number(v5Hcfg[4])}`);
  }
  if (v4Scl.enabled !== v5Scl.enabled) {
    anyDiff = true;
    console.log(`  CHANGED scalingEnabled: ${v4Scl.enabled} → ${v5Scl.enabled}`);
  }
  if (!anyDiff) console.log("  (no differences)");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
