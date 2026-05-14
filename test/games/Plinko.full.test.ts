import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

/**
 * Plinko full-coverage tests: admin setters, validation paths, fulfillRandomness,
 * handleRandomFailure, cancelExpiredBet success path, emergencyWithdraw, view fns.
 *
 * Companion file Plinko.test.ts covers the auth + lifecycle surface only.
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;

let deployer: `0x${string}`;
let player: `0x${string}`;
let player2: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;
let other: `0x${string}`;

const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 0;

const RiskLow = 0;
const RiskMedium = 1;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();

  deployer = walletClients[0].account.address;
  player = walletClients[1].account.address;
  player2 = walletClients[2].account.address;
  operator = walletClients[3].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;
  other = walletClients[6].account.address;
});

/** Build a symmetric multiplier table — required by setMultipliers. */
function symmetricMults(rows: number, value: number = 100): bigint[] {
  return Array.from({ length: rows + 1 }, () => BigInt(value));
}

async function setup(opts: { initialOperator?: `0x${string}` } = {}) {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  await mlr.write.setLevels([1, [10000]]);
  await mlr.write.setPaymentHandler([handler.address]);
  await handler.write.setReferralContract([mlr.address]);

  const coordinator = await env.viem.deployContract("MockVRFCoordinatorV2Plus");
  const provider = await env.viem.deployContract("RandomProvider", [coordinator.address]);
  await provider.write.setSubscriptionId([1n]);

  const authHub = await env.viem.deployContract("AuthHub");

  const plinko = await env.viem.deployContract("Plinko", [
    handler.address, provider.address, token.address, authHub.address,
    opts.initialOperator ?? ZERO_ADDRESS,
    0n, 0n, // minBet, maxBet
  ]);

  await provider.write.setConsumerStatus([plinko.address, true, 1n]);
  await handler.write.registerGame([
    plinko.address, plinko.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);

  // Default game config: allow 4 rows, uniform 1.0x mults so payout == betAmount * numDrops
  await plinko.write.setAllowedRows([[4]]);
  await plinko.write.setMultipliers([4, RiskLow, symmetricMults(4, 100)]);

  // Fund player + approve
  await token.write.transfer([player, HUNDRED_EVA * 5n]);
  const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerToken.write.approve([plinko.address, ONE_THOUSAND_EVA]);

  // Bankroll
  await token.write.transfer([plinko.address, ONE_THOUSAND_EVA * 5n]);

  return { token, handler, provider, coordinator, authHub, plinko };
}

async function placeBetAsPlayer(plinko: any, betAmount: bigint, rows: number, risk: number, numDrops: number) {
  const playerPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
    client: { wallet: walletClients[1] },
  });
  return playerPlinko.write.placeBet([betAmount, rows, risk, numDrops, ZERO_ADDRESS]);
}

// ─────────────────────────────────────────────────────────────────────────────
// setMultipliers — validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — setMultipliers validation", () => {
  it("rejects rows below MIN_ROWS", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setMultipliers([3, RiskLow, symmetricMults(3, 100)]));
  });

  it("rejects rows above MAX_ROWS", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setMultipliers([33, RiskLow, symmetricMults(33, 100)]));
  });

  it("rejects wrong-length multiplier array", async () => {
    const { plinko } = await setup();
    // rows=4 → expected length 5; provide 4
    await expectRevert(plinko.write.setMultipliers([4, RiskLow, [100n, 100n, 100n, 100n]]));
  });

  it("rejects non-symmetric multipliers", async () => {
    const { plinko } = await setup();
    // mults[0] != mults[4]
    await expectRevert(plinko.write.setMultipliers([4, RiskLow, [100n, 200n, 300n, 200n, 999n]]));
  });

  it("rejects zero multiplier entry", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setMultipliers([4, RiskLow, [100n, 0n, 100n, 0n, 100n]]));
  });

  it("rejects non-owner", async () => {
    const { plinko } = await setup();
    const asOther = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setMultipliers([4, RiskLow, symmetricMults(4, 100)]));
  });

  it("happy path: stores mults, caches max, emits MultipliersUpdated", async () => {
    const { plinko } = await setup();
    const mults = [100n, 200n, 500n, 200n, 100n];
    const txHash = await plinko.write.setMultipliers([4, RiskMedium, mults]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const stored = await plinko.read.getMultipliers([4, RiskMedium]);
    expect(stored.length).to.equal(5);
    expect(await plinko.read.maxMultipliers([4, RiskMedium])).to.equal(500n);

    const events = await plinko.getEvents.MultipliersUpdated();
    expect(events.find((e) => e.args.rows === 4 && e.args.risk === RiskMedium)).to.exist;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setAllowedRows
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — setAllowedRows", () => {
  it("rejects empty array (use pause() instead)", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setAllowedRows([[]]));
  });

  it("rejects rows outside [MIN_ROWS, MAX_ROWS]", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setAllowedRows([[3]]));
    await expectRevert(plinko.write.setAllowedRows([[33]]));
  });

  it("clears old allowed rows on each call", async () => {
    const { plinko } = await setup();
    await plinko.write.setAllowedRows([[8, 12]]);
    expect(await plinko.read.allowedRows([8])).to.equal(true);
    expect(await plinko.read.allowedRows([12])).to.equal(true);
    expect(await plinko.read.allowedRows([4])).to.equal(false);

    await plinko.write.setAllowedRows([[16]]);
    expect(await plinko.read.allowedRows([8])).to.equal(false);
    expect(await plinko.read.allowedRows([12])).to.equal(false);
    expect(await plinko.read.allowedRows([16])).to.equal(true);

    const list = await plinko.read.getAllowedRows();
    expect(list.length).to.equal(1);
    expect(list[0]).to.equal(16);
  });

  it("deduplicates the input array", async () => {
    const { plinko } = await setup();
    await plinko.write.setAllowedRows([[8, 8, 8, 12]]);
    const list = await plinko.read.getAllowedRows();
    expect(list.length).to.equal(2);
  });

  it("rejects non-owner", async () => {
    const { plinko } = await setup();
    const asOther = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setAllowedRows([[8]]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setBetLimits
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — setBetLimits", () => {
  it("rejects min > max when both non-zero", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setBetLimits([100n, 50n]));
  });

  it("accepts min=0 (no lower bound)", async () => {
    const { plinko } = await setup();
    await plinko.write.setBetLimits([0n, 1000n]);
    expect(await plinko.read.minBet()).to.equal(0n);
    expect(await plinko.read.maxBet()).to.equal(1000n);
  });

  it("accepts max=0 (no upper bound)", async () => {
    const { plinko } = await setup();
    await plinko.write.setBetLimits([10n, 0n]);
    expect(await plinko.read.minBet()).to.equal(10n);
    expect(await plinko.read.maxBet()).to.equal(0n);
  });

  it("emits BetLimitsUpdated", async () => {
    const { plinko } = await setup();
    const txHash = await plinko.write.setBetLimits([50n, 500n]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const events = await plinko.getEvents.BetLimitsUpdated();
    expect(events.find((e) => e.args.minBet === 50n && e.args.maxBet === 500n)).to.exist;
  });

  it("rejects non-owner", async () => {
    const { plinko } = await setup();
    const asOther = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setBetLimits([10n, 100n]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setMaxDropsPerBet, setBetExpiryBlocks, setMaxPendingBetsPerPlayer, setMaxTotalPendingBets
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — small admin setters", () => {
  it("setMaxDropsPerBet: rejects 0 and >MAX_DROPS, accepts valid", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setMaxDropsPerBet([0]));
    await expectRevert(plinko.write.setMaxDropsPerBet([101]));
    await plinko.write.setMaxDropsPerBet([20]);
    expect(await plinko.read.maxDropsPerBet()).to.equal(20);
  });

  it("setBetExpiryBlocks: rejects 0, accepts valid", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setBetExpiryBlocks([0n]));
    await plinko.write.setBetExpiryBlocks([100n]);
    expect(await plinko.read.betExpiryBlocks()).to.equal(100n);
  });

  it("setMaxPendingBetsPerPlayer: rejects 0 and >CAP, accepts valid", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setMaxPendingBetsPerPlayer([0]));
    await expectRevert(plinko.write.setMaxPendingBetsPerPlayer([11]));
    await plinko.write.setMaxPendingBetsPerPlayer([3]);
    expect(await plinko.read.maxPendingBetsPerPlayer()).to.equal(3);
  });

  it("setMaxTotalPendingBets: rejects 0, accepts valid", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.setMaxTotalPendingBets([0n]));
    await plinko.write.setMaxTotalPendingBets([100n]);
    expect(await plinko.read.maxTotalPendingBets()).to.equal(100n);
  });

  it("each rejects non-owner", async () => {
    const { plinko } = await setup();
    const asOther = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setMaxDropsPerBet([5]));
    await expectRevert(asOther.write.setBetExpiryBlocks([100n]));
    await expectRevert(asOther.write.setMaxPendingBetsPerPlayer([3]));
    await expectRevert(asOther.write.setMaxTotalPendingBets([50n]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// placeBet — validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — placeBet validation", () => {
  it("rejects rows that are not in the allowlist", async () => {
    const { plinko } = await setup();
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA, 8, RiskLow, 1));
  });

  it("rejects numDrops = 0", async () => {
    const { plinko } = await setup();
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 0));
  });

  it("rejects numDrops > maxDropsPerBet", async () => {
    const { plinko } = await setup();
    await plinko.write.setMaxDropsPerBet([5]);
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 6));
  });

  it("rejects when the multiplier table for (rows, risk) is unset", async () => {
    const { plinko } = await setup();
    // Allowed rows include 4 (default) but no mults set for RiskMedium
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA, 4, RiskMedium, 1));
  });

  it("rejects when totalWager < minBet", async () => {
    const { plinko } = await setup();
    await plinko.write.setBetLimits([HUNDRED_EVA, 0n]);
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1));
  });

  it("rejects when totalWager > maxBet", async () => {
    const { plinko } = await setup();
    await plinko.write.setBetLimits([0n, ONE_EVA]);
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA * 2n, 4, RiskLow, 1));
  });

  it("rejects when player already at maxPendingBetsPerPlayer", async () => {
    const { plinko } = await setup();
    await plinko.write.setMaxPendingBetsPerPlayer([2]);
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1);
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1);
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1));
  });

  it("rejects when totalPendingBets cap is reached", async () => {
    const { plinko } = await setup();
    await plinko.write.setMaxTotalPendingBets([1n]);
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1);
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1));
  });

  it("rejects when contract is paused", async () => {
    const { plinko } = await setup();
    await plinko.write.pause();
    await expectRevert(placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fulfillRandomness — happy settlement
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — fulfillRandomness", () => {
  it("settles a bet, pays the player at uniform 1.0x, clears state, emits BetSettled", async () => {
    const { plinko, coordinator, provider, token } = await setup();
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 2);
    const requestId = 1n;

    const beforeBal = await token.read.balanceOf([player]);

    // Fulfill via the coordinator → provider → plinko chain
    const txHash = await coordinator.write.fulfill([provider.address, requestId, [0xdeadbeefn]]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Pending state cleared
    expect(await plinko.read.pendingBetCount([player])).to.equal(0n);
    expect(await plinko.read.totalPendingBets()).to.equal(0n);
    const bet = await plinko.read.pendingBets([requestId]);
    // Tuple order: player, rows, risk, numDrops, exists, placedAtBlock, betAmount, totalWager, maxPayout, netStake
    expect(bet[4]).to.equal(false); // exists = false after delete

    // With uniform 1.0x mults: payout = betAmount * MULTIPLIER_SCALE / SCALE * numDrops = ONE_EVA * 2
    const afterBal = await token.read.balanceOf([player]);
    expect(afterBal - beforeBal).to.equal(ONE_EVA * 2n);

    const settled = await plinko.getEvents.BetSettled();
    const evt = settled.find((e) => e.args.requestId === requestId);
    expect(evt, "BetSettled not emitted").to.exist;
    expect(evt!.args.totalPayout).to.equal(ONE_EVA * 2n);
    expect(evt!.args.numDrops).to.equal(2);
    expect(evt!.args.randomWord).to.equal(0xdeadbeefn);
    expect(evt!.args.slots?.length).to.equal(2);
  });

  it("zero-payout case (mults can't be zero, so this path always pays > 0 with uniform mults)", async () => {
    // With Plinko's invariant (no zero mults), payout cannot be zero — this confirms
    // the contract honours that invariant after settlement.
    const { plinko, coordinator, provider, token } = await setup();
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1);
    const beforeBal = await token.read.balanceOf([player]);
    await coordinator.write.fulfill([provider.address, 1n, [42n]]);
    const afterBal = await token.read.balanceOf([player]);
    expect(afterBal - beforeBal > 0n).to.equal(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleRandomFailure
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — handleRandomFailure (via RandomProvider timeout)", () => {
  it("emits BetFailed, unlocks exposure, decrements counters when VRF times out", async () => {
    const { plinko, provider } = await setup();
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1);
    const requestId = 1n;

    expect(await plinko.read.pendingBetCount([player])).to.equal(1n);
    expect(await plinko.read.totalPendingBets()).to.equal(1n);

    // Fast-forward past the request timeout (1 day)
    const REQUEST_TIMEOUT = await provider.read.REQUEST_TIMEOUT();
    await env.networkHelpers.time.increase(Number(REQUEST_TIMEOUT) + 60);

    // forceFailRequest is owner-gated and only works after the timeout has elapsed.
    await provider.write.forceFailRequest([requestId]);

    expect(await plinko.read.pendingBetCount([player])).to.equal(0n);
    expect(await plinko.read.totalPendingBets()).to.equal(0n);

    const failed = await plinko.getEvents.BetFailed();
    expect(failed.find((e) => e.args.requestId === requestId)).to.exist;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelExpiredBet — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — cancelExpiredBet success", () => {
  it("operator can cancel after betExpiryBlocks elapses; counters cleaned up", async () => {
    const { plinko } = await setup({ initialOperator: operator });
    // Use a tiny expiry so the test runs fast
    await plinko.write.setBetExpiryBlocks([5n]);
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1);
    const requestId = 1n;

    // Mine 6 blocks to get past expiry
    await env.networkHelpers.mine(6);

    const opPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    await opPlinko.write.cancelExpiredBet([requestId]);

    expect(await plinko.read.pendingBetCount([player])).to.equal(0n);
    expect(await plinko.read.totalPendingBets()).to.equal(0n);
    const bet = await plinko.read.pendingBets([requestId]);
    expect(bet[4]).to.equal(false); // exists = false after delete

    const failed = await plinko.getEvents.BetFailed();
    const evt = failed.find((e) => e.args.requestId === requestId);
    expect(evt, "BetFailed not emitted").to.exist;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emergencyWithdraw
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — emergencyWithdraw", () => {
  it("rejects when contract is not paused", async () => {
    const { plinko } = await setup();
    await expectRevert(plinko.write.emergencyWithdraw([deployer, 0n]));
  });

  it("rejects zero recipient", async () => {
    const { plinko } = await setup();
    await plinko.write.pause();
    await expectRevert(plinko.write.emergencyWithdraw([ZERO_ADDRESS, 0n]));
  });

  it("rejects amount > balance", async () => {
    const { plinko, token } = await setup();
    const bal = await token.read.balanceOf([plinko.address]);
    await plinko.write.pause();
    await expectRevert(plinko.write.emergencyWithdraw([deployer, bal + 1n]));
  });

  it("amount = 0 sweeps full balance and resets lockedExposure", async () => {
    const { plinko, token } = await setup();
    // Place a bet so lockedExposure > 0
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1);
    expect(await plinko.read.lockedExposure() > 0n).to.equal(true);

    await plinko.write.pause();
    const recipient = walletClients[8].account.address;
    const bal = await token.read.balanceOf([plinko.address]);

    const txHash = await plinko.write.emergencyWithdraw([recipient, 0n]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    expect(await token.read.balanceOf([plinko.address])).to.equal(0n);
    expect(await token.read.balanceOf([recipient])).to.equal(bal);
    expect(await plinko.read.lockedExposure()).to.equal(0n);

    const events = await plinko.getEvents.EmergencyWithdraw();
    expect(events.find((e) => e.args.amount === bal)).to.exist;
  });

  it("partial amount ALSO resets lockedExposure to 0 (platform invariant)", async () => {
    // Per the BaseGame hardening: emergencyWithdraw ALWAYS zeros lockedExposure
    // regardless of the amount withdrawn. The contract is exiting normal operation;
    // the owner takes responsibility for any pending bets out-of-band.
    const { plinko, token } = await setup();
    await placeBetAsPlayer(plinko, ONE_EVA, 4, RiskLow, 1);
    expect(await plinko.read.lockedExposure() > 0n).to.equal(true);

    await plinko.write.pause();
    const recipient = walletClients[8].account.address;
    await plinko.write.emergencyWithdraw([recipient, ONE_EVA]);

    expect(await token.read.balanceOf([recipient])).to.equal(ONE_EVA);
    expect(await plinko.read.lockedExposure()).to.equal(0n);
  });

  it("rejects non-owner", async () => {
    const { plinko } = await setup();
    await plinko.write.pause();
    const asOther = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.emergencyWithdraw([other, 0n]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// View functions
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — view functions", () => {
  it("getMultipliers returns the stored array; empty for unset (rows, risk)", async () => {
    const { plinko } = await setup();
    const set = await plinko.read.getMultipliers([4, RiskLow]);
    expect(set.length).to.equal(5);
    const unset = await plinko.read.getMultipliers([4, RiskMedium]);
    expect(unset.length).to.equal(0);
  });

  it("getAllowedRows reflects setAllowedRows state", async () => {
    const { plinko } = await setup();
    expect(await plinko.read.getAllowedRows()).to.deep.equal([4]);
    await plinko.write.setAllowedRows([[8, 12, 16]]);
    const list = await plinko.read.getAllowedRows();
    expect(list.length).to.equal(3);
  });
});
