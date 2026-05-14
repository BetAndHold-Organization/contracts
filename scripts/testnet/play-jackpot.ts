/**
 * Testnet Roulette ↔ ProgressiveJackpot integration play.
 *
 *   npx hardhat run scripts/testnet/play-jackpot.ts --network arbitrumSepolia
 *
 * Roulette is already registered as a PJ game (done in deploy). This script:
 *   1. Bumps Roulette's jackpotBps temporarily to maximize odds of a Jackpot
 *      outcome (so we exercise the _enterJackpot / PJ.processJackpotEntry path).
 *   2. Runs N spins from player1 with participateInJackpot=true.
 *   3. Reports each SpinResolved outcome.
 *   4. Restores Roulette's jackpotBps to the default deploy value.
 *
 * NOTE: Outcomes still depend on VRF — we elevate probability, not guarantee.
 * With jackpotBps=5000 and replayBps=0, ~50% of spins should hit Jackpot.
 */

import { parseEther, formatEther } from "viem";

import {
  loadTestnetContext, banner, step, ok, info, warn, fmtEva,
  extractVrfRequestId, waitForRequestEvent, printPlayerBalance,
  type TestnetContext,
} from "./play-lib.js";

type Addr = `0x${string}`;

const BET            = parseEther("1");
const SPIN_COUNT     = 4;             // 4 spins → ~93% chance of seeing at least 1 jackpot at 50% per-spin
const ELEVATED_JBPS  = 5000;          // 50% jackpot probability
const DEFAULT_JBPS   = 100;           // restored after the test
const ROULETTE_MULT  = 200n;          // min mult so multiplierBps stays small (less competition for the band)
const ROULETTE_MIN_MULTIPLIER = 200;
const ROULETTE_MAX_MULTIPLIER = 5000;

async function spinOnce(ctx: TestnetContext, label: string) {
  const roulette = await ctx.viem.getContractAt(
    "SingleRandomRoulette", ctx.deployment.contracts.roulette,
    { client: { wallet: ctx.walletClients.player1 } },
  );
  step(`${label}: startSpin (participateInJackpot=true)`);
  const txHash = await roulette.write.startSpin([
    BET, ROULETTE_MULT, "0x0000000000000000000000000000000000000000", true,
  ]);
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`requestId = ${requestId}`);

  const reader = await ctx.viem.getContractAt(
    "SingleRandomRoulette", ctx.deployment.contracts.roulette,
  );
  const settled = await waitForRequestEvent<{
    requestId: bigint; player: Addr; outcome: number; payout: bigint;
    spinsConsumed: number; jackpotPayout: bigint;
  }>(reader, "SpinResolved", requestId, fromBlock, { label: "SpinResolved" });

  const name = ["Lose", "Multiplier", "Jackpot"][settled.outcome] ?? `Outcome#${settled.outcome}`;
  info(`outcome=${name}, payout=${fmtEva(settled.payout)}, jackpotPayout=${fmtEva(settled.jackpotPayout)}`);
  return settled;
}

async function main() {
  const ctx = await loadTestnetContext();

  banner("TESTNET ROULETTE → PROGRESSIVE JACKPOT");
  await printPlayerBalance(ctx, "player1");

  step(`Elevating Roulette jackpotBps to ${ELEVATED_JBPS} (50%) to exercise the jackpot path`);
  await ctx.deployerClient.writeContract({
    address: ctx.deployment.contracts.roulette,
    abi: (await ctx.viem.getContractAt("SingleRandomRoulette", ctx.deployment.contracts.roulette)).abi,
    functionName: "setTableConfig",
    args: [{
      enabled: true,
      replayBps: 0,
      jackpotBps: ELEVATED_JBPS,
      minMultiplier: ROULETTE_MIN_MULTIPLIER,
      maxMultiplier: ROULETTE_MAX_MULTIPLIER,
      minWager: 0n,
      maxWager: 0n,
    }],
  });
  ok("Roulette table updated");

  const outcomes: number[] = [];
  let jackpotPaidTotal = 0n;
  for (let i = 1; i <= SPIN_COUNT; i++) {
    const r = await spinOnce(ctx, `Spin ${i}/${SPIN_COUNT}`);
    outcomes.push(r.outcome);
    jackpotPaidTotal += r.jackpotPayout;
  }

  step(`Restoring jackpotBps to ${DEFAULT_JBPS}`);
  await ctx.deployerClient.writeContract({
    address: ctx.deployment.contracts.roulette,
    abi: (await ctx.viem.getContractAt("SingleRandomRoulette", ctx.deployment.contracts.roulette)).abi,
    functionName: "setTableConfig",
    args: [{
      enabled: true,
      replayBps: 0,
      jackpotBps: DEFAULT_JBPS,
      minMultiplier: ROULETTE_MIN_MULTIPLIER,
      maxMultiplier: ROULETTE_MAX_MULTIPLIER,
      minWager: 0n,
      maxWager: 0n,
    }],
  });
  ok("Roulette restored");

  banner("RESULTS");
  const count = { lose: 0, mult: 0, jp: 0 };
  for (const o of outcomes) {
    if (o === 0) count.lose++;
    else if (o === 1) count.mult++;
    else if (o === 2) count.jp++;
  }
  info(`Spins: Lose=${count.lose}, Multiplier=${count.mult}, Jackpot=${count.jp}`);
  info(`Total jackpotPayout received: ${fmtEva(jackpotPaidTotal)}`);
  await printPlayerBalance(ctx, "player1");
  if (count.jp === 0) {
    warn(`No Jackpot outcomes this run — VRF variance. Re-run for more samples.`);
  }
}

main().catch((e) => {
  console.error("\n✖ Play-jackpot failed:", e);
  process.exit(1);
});
