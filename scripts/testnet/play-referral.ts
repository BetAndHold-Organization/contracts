/**
 * Testnet referral payout play.
 *
 *   npx hardhat run scripts/testnet/play-referral.ts --network arbitrumSepolia
 *
 * Verifies the MultiLevelReferral flow end-to-end:
 *   1. player2 plays PaymentOnlyGameAdapter referencing player1 as referrer.
 *      First call records player1 as player2's upline (level 1).
 *   2. player2 plays a second time so MLR credits player1 again.
 *   3. We read MLR.pendingRewards[player1] and confirm > 0.
 *   4. player1 calls withdrawRewards() → EVA arrives in their wallet.
 *
 * No VRF involved — PaymentOnlyGameAdapter is sync from the player's perspective.
 */

import { parseEther, formatEther } from "viem";

import {
  loadTestnetContext, banner, step, ok, info, warn, fmtEva,
  printPlayerBalance,
  type TestnetContext,
} from "./play-lib.js";

type Addr = `0x${string}`;

const PER_PLAY = parseEther("2"); // bigger bet so the referral cut is visible

async function play2Plays(ctx: TestnetContext, gameId: Addr) {
  const game = await ctx.viem.getContractAt(
    "PaymentOnlyGameAdapter", ctx.deployment.contracts.paymentOnlyGameAdapter,
    { client: { wallet: ctx.walletClients.player2 } },
  );
  const tx = await game.write.play([PER_PLAY, ctx.wallets.player1.address, gameId]);
  await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
}

async function main() {
  const ctx = await loadTestnetContext();

  banner("TESTNET REFERRAL PAYOUT FLOW");
  info(`player1 (referrer): ${ctx.wallets.player1.address}`);
  info(`player2 (referee):  ${ctx.wallets.player2.address}`);

  const mlrRead = await ctx.viem.getContractAt(
    "MultiLevelReferral", ctx.deployment.contracts.mlr,
  );
  const token = await ctx.viem.getContractAt(
    "EverValueCoin", ctx.deployment.contracts.evaToken,
  );

  // ── Pre-flight: any pre-existing referrer for player2? ──
  const existingReferrer = await mlrRead.read.getReferrer([ctx.wallets.player2.address]);
  if (existingReferrer !== "0x0000000000000000000000000000000000000000") {
    info(`Pre-existing referrer for player2: ${existingReferrer}`);
    if (existingReferrer.toLowerCase() !== ctx.wallets.player1.address.toLowerCase()) {
      warn(`Existing referrer differs from player1 — MLR records the FIRST referrer permanently. Future plays will credit ${existingReferrer}, not player1.`);
    }
  } else {
    info("player2 has no referrer yet — first play will set player1");
  }

  const player1RewardsBefore = await mlrRead.read.pendingRewards([ctx.wallets.player1.address]);
  const player1EvaBefore = await token.read.balanceOf([ctx.wallets.player1.address]);
  info(`player1.pendingRewards (before): ${fmtEva(player1RewardsBefore)}`);
  info(`player1.balanceOf      (before): ${fmtEva(player1EvaBefore)}`);

  // ── Play twice with player1 as referrer ──
  banner("player2 plays PaymentOnlyGameAdapter twice referencing player1");
  step(`Play #1: ${fmtEva(PER_PLAY)} referencing player1`);
  await play2Plays(ctx, ("0x" + "0a".repeat(32)) as Addr);
  ok("Play 1 done");

  step(`Play #2: ${fmtEva(PER_PLAY)} referencing player1 (referrer is now locked in)`);
  await play2Plays(ctx, ("0x" + "0b".repeat(32)) as Addr);
  ok("Play 2 done");

  // ── Check MLR credit ──
  banner("MLR state after plays");
  const player2Referrer = await mlrRead.read.getReferrer([ctx.wallets.player2.address]);
  info(`MLR.getReferrer(player2):       ${player2Referrer}`);
  const player1RewardsAfter = await mlrRead.read.pendingRewards([ctx.wallets.player1.address]);
  info(`player1.pendingRewards (after): ${fmtEva(player1RewardsAfter)}`);
  const delta = player1RewardsAfter - player1RewardsBefore;
  info(`→ credited this run:           ${fmtEva(delta)}`);

  if (delta === 0n) {
    warn("No reward credited to player1. Likely cause: player2 already had a different upline. See pre-flight note above.");
  }

  // ── Withdraw ──
  banner("player1 withdraws referral rewards");
  if (player1RewardsAfter === 0n) {
    warn("player1.pendingRewards is 0 — nothing to withdraw, skipping");
  } else {
    const mlrAsP1 = await ctx.viem.getContractAt(
      "MultiLevelReferral", ctx.deployment.contracts.mlr,
      { client: { wallet: ctx.walletClients.player1 } },
    );
    const tx = await mlrAsP1.write.withdrawRewards();
    await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
    ok("withdrawRewards() confirmed");

    const player1EvaAfter = await token.read.balanceOf([ctx.wallets.player1.address]);
    const player1RewardsFinal = await mlrRead.read.pendingRewards([ctx.wallets.player1.address]);
    info(`player1.balanceOf      (final): ${fmtEva(player1EvaAfter)}`);
    info(`player1.pendingRewards (final): ${fmtEva(player1RewardsFinal)}`);
    info(`→ EVA gained from withdraw:    ${fmtEva(player1EvaAfter - player1EvaBefore)}`);
  }

  banner("FINAL BALANCES");
  await printPlayerBalance(ctx, "player1");
  await printPlayerBalance(ctx, "player2");
  console.log("");
}

main().catch((e) => {
  console.error("\n✖ Play-referral failed:", e);
  process.exit(1);
});
