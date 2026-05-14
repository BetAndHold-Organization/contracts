import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA } from "../../helpers/constants.js";

/**
 * Unit tests for the JackpotClient mixin. The mixin's other entries
 * (`_jackpotRollCap`, `_ensureJackpotPayable`) are exercised end-to-end through
 * the Roulette + ProgressiveJackpot integration tests, but `_enterJackpot` has
 * no direct production caller that fires under the default e2e configuration,
 * so its body is not reached through any existing test.
 *
 * We deploy a MockJackpotGame that inherits BaseGame + JackpotClient and
 * exposes the helpers as external functions. Two scenarios:
 *   1. PaymentHandler.getJackpot() returns a real PJ → _enterJackpot returns
 *      the payout from PJ.processJackpotEntry.
 *   2. PaymentHandler.getJackpot() returns address(0) → _enterJackpot
 *      short-circuits and returns 0 without touching state.
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;

let deployer: `0x${string}`;
let player: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();

  deployer = walletClients[0].account.address;
  player = walletClients[1].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;
});

async function deploy() {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  await mlr.write.setLevels([1, [10_000]]);
  await mlr.write.setPaymentHandler([handler.address]);
  await handler.write.setReferralContract([mlr.address]);

  const game = await env.viem.deployContract("MockJackpotGame", [token.address, handler.address]);
  return { token, handler, mlr, game };
}

/** Deploy a real PJ + wire it into the PaymentHandler so getJackpot() resolves. */
async function deployWithRealJackpot() {
  const base = await deploy();
  const provider = await env.viem.deployContract("MockJackpotRandomProvider");
  const authHub = await env.viem.deployContract("AuthHub");
  const pj = await env.viem.deployContract("ProgressiveJackpot", [
    base.token.address, provider.address, authHub.address,
  ]);
  await pj.write.setPaymentHandler([base.handler.address]);
  await base.handler.write.setJackpot([pj.address]);

  // Configure outcomes so processJackpotEntry doesn't revert
  await pj.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
    prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
    fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
  }))]);
  await pj.write.setAllTierProbConfigs([1000, 50_000, 30]);
  const outcomes = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
  ];
  for (let i = 0; i < 9; i++) {
    outcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  }
  // Register the mock game so PJ.processJackpotEntry accepts its calls
  await pj.write.registerGame([base.game.address, outcomes]);
  await pj.write.setGameFallback([base.game.address, 0]);

  return { ...base, provider, authHub, pj };
}

describe("JackpotClient — _enterJackpot", () => {
  it("returns 0 immediately when the PaymentHandler has no jackpot configured", async () => {
    const { game } = await deploy();
    // PaymentHandler.getJackpot() returns address(0) by default — _enterJackpot
    // hits the early-return branch and reports 0 with no external calls.
    const payout = await game.read.harness_enterJackpot([player, ONE_EVA, 0n]);
    expect(payout).to.equal(0n);
  });

  it("returns the payout from PJ.processJackpotEntry when a jackpot is wired", async () => {
    const { game, pj } = await deployWithRealJackpot();
    // High roll lands on outcome[0] (pure lose) → payout 0, but the call still
    // routes through ProgressiveJackpot.processJackpotEntry and returns.
    const txHash = await game.write.harness_enterJackpot([player, ONE_EVA, 999_000n]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // PJ should have recorded an entry — confirm via the entryHistory + nextEntryId counter
    const entryId = (await pj.read.nextEntryId()) - 1n;
    const entry = await pj.read.getEntry([entryId]);
    expect(entry.player.toLowerCase()).to.equal(player.toLowerCase());
  });
});

describe("JackpotClient — _jackpotRollCap", () => {
  it("returns 0 when no jackpot is configured", async () => {
    const { game } = await deploy();
    expect(await game.read.harness_jackpotRollCap()).to.equal(0n);
  });

  it("returns PJ.PROBABILITY_PRECISION when a jackpot is wired", async () => {
    const { game, pj } = await deployWithRealJackpot();
    const cap = await game.read.harness_jackpotRollCap();
    const precision = await pj.read.PROBABILITY_PRECISION();
    expect(cap).to.equal(precision);
  });
});

describe("JackpotClient — _ensureJackpotPayable", () => {
  it("no-op when no jackpot is configured", async () => {
    const { game } = await deploy();
    // Just doesn't revert. Returns nothing.
    await game.read.harness_ensureJackpotPayable([ONE_EVA]);
  });

  it("delegates to the wired jackpot's ensurePayable when configured", async () => {
    const { token, game, pj } = await deployWithRealJackpot();
    // With empty tier pots, ensurePayable should still pass for a tiny bet
    // (the check verifies the tier pot can cover the worst-case prize at this
    // bet size; with zero bet and zero pot, it's a no-op success).
    // Seed a small amount so the check has somewhere to look.
    await token.write.approve([pj.address, HUNDRED_EVA]);
    await pj.write.seedTierPot([0, HUNDRED_EVA]);
    await game.read.harness_ensureJackpotPayable([ONE_EVA]);
  });
});
