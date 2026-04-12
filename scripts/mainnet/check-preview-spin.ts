import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const ROULETTE = "0x29a597c324dce8f075d55acc7b0e65563ae180ab" as Addr;

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;

  const roulette = await viem.getContractAt("SingleRandomRouletteV2", ROULETTE);

  const idx = await roulette.read.currentConfigIndex();
  const cfg = await roulette.read.getTableConfig([]);
  const scl = await roulette.read.getJackpotScalingConfig([]);

  console.log("Config index:", Number(idx));
  console.log("maxWager:", formatEther(cfg.maxWager), "EVA");
  console.log("Scaling:", scl.enabled, "min=" + Number(scl.minJackpotBps), "max=" + Number(scl.maxJackpotBps));
  console.log("");

  const testCases = [
    { wager: "0.1",  mult: 101,  label: "0.1 EVA @ 1.01x" },
    { wager: "0.1",  mult: 200,  label: "0.1 EVA @ 2.00x" },
    { wager: "1",    mult: 101,  label: "1.0 EVA @ 1.01x" },
    { wager: "1",    mult: 200,  label: "1.0 EVA @ 2.00x" },
    { wager: "3",    mult: 101,  label: "3.0 EVA @ 1.01x" },
    { wager: "3",    mult: 200,  label: "3.0 EVA @ 2.00x" },
    { wager: "5",    mult: 101,  label: "5.0 EVA @ 1.01x" },
    { wager: "5",    mult: 102,  label: "5.0 EVA @ 1.02x" },
    { wager: "5",    mult: 105,  label: "5.0 EVA @ 1.05x" },
    { wager: "5",    mult: 110,  label: "5.0 EVA @ 1.10x" },
    { wager: "5",    mult: 200,  label: "5.0 EVA @ 2.00x" },
    { wager: "5",    mult: 500,  label: "5.0 EVA @ 5.00x" },
    { wager: "5",    mult: 10000, label: "5.0 EVA @ 100x" },
  ];

  console.log("Wager/Mult          | multiplier | replay | jackpot | lose   | total  | notes");
  console.log("-".repeat(95));

  for (const tc of testCases) {
    try {
      const result = await roulette.read.previewSpin([
        parseEther(tc.wager),
        BigInt(tc.mult),
        4294967295n, // type(uint32).max = use current config
        true,        // participate in jackpot
      ]);

      const [mult, replay, jackpot, lose] = [
        Number(result[0]), Number(result[1]),
        Number(result[2]), Number(result[3]),
      ];
      const total = mult + replay + jackpot + lose;
      const notes = lose === 0 ? "⚠ ZERO LOSE" : "";

      console.log(
        tc.label.padEnd(20) + " | " +
        String(mult).padStart(10) + " | " +
        String(replay).padStart(6) + " | " +
        String(jackpot).padStart(7) + " | " +
        String(lose).padStart(6) + " | " +
        String(total).padStart(6) + " | " +
        notes
      );
    } catch (e: any) {
      console.log(tc.label.padEnd(20) + " | REVERTED: " + (e.shortMessage ?? e.message).slice(0, 60));
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
