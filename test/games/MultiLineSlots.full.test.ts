import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { parseEther } from "viem";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

/**
 * MultiLineSlots full-coverage tests: admin setters, fulfillment math (via impersonated
 * RandomProvider), handleRandomFailure, view functions, payline evaluation including wild logic.
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;

let deployer: `0x${string}`;
let player: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;
let other: `0x${string}`;

const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 0;

const GRID_SIZE = 9;
const MAX_SYMBOLS = 8;
const MULTIPLIER_SCALE = 100n;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();

  deployer = walletClients[0].account.address;
  player = walletClients[1].account.address;
  operator = walletClients[3].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;
  other = walletClients[6].account.address;
});

const sym = (w: number, three: number, two: number, isWild: boolean, enabled: boolean) => ({
  weightBps: w, threeMatchPayout: three, twoMatchPayout: two, isWild, enabled,
});

/** 4 enabled symbols (S0..S3) + S3 = wild. */
function defaultSymbolSet() {
  return [
    sym(2500, 200, 50, false, true),  // S0: 2.0x triple, 0.5x double
    sym(2500, 500, 100, false, true), // S1: 5.0x triple, 1.0x double
    sym(2500, 1000, 200, false, true), // S2: 10x triple, 2.0x double
    sym(2500, 0, 0, true, true),       // S3: WILD
    sym(0, 0, 0, false, false),
    sym(0, 0, 0, false, false),
    sym(0, 0, 0, false, false),
    sym(0, 0, 0, false, false),
  ];
}

async function setup(opts: { symbols?: ReturnType<typeof defaultSymbolSet>; configEnabled?: boolean } = {}) {
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

  const slots = await env.viem.deployContract("MultiLineSlots", [
    handler.address, provider.address, token.address, authHub.address,
  ]);

  await provider.write.setConsumerStatus([slots.address, true, BigInt(GRID_SIZE)]);
  await handler.write.registerGame([
    slots.address, slots.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);

  const symbols = opts.symbols ?? defaultSymbolSet();
  await slots.write.setAllSymbols([symbols as any]);

  await slots.write.setSlotsConfig([{
    enabled: opts.configEnabled ?? true,
    activeSymbolCount: 4,
    minWagerPerLine: 0n,
    maxWagerPerLine: 0n,
  } as any]);

  await token.write.transfer([player, HUNDRED_EVA * 10n]);
  const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerToken.write.approve([slots.address, ONE_THOUSAND_EVA]);

  await token.write.transfer([slots.address, ONE_THOUSAND_EVA * 5n]);

  return { token, handler, provider, coordinator, authHub, slots };
}

async function placeSpinAsPlayer(slots: any, wagerPerLine: bigint, paylines: number) {
  const playerSlots = await env.viem.getContractAt("MultiLineSlots", slots.address, {
    client: { wallet: walletClients[1] },
  });
  return playerSlots.write.startSpin([wagerPerLine, paylines, ZERO_ADDRESS]);
}

/**
 * Impersonate the RandomProvider and call fulfillRandomness directly with crafted derived values.
 * derivedValues[i] is the roll for cell i; the contract maps roll → symbol via cumulative weights.
 *
 * For our default symbol set (each weight 2500, total 10000):
 *   roll < 2500       → S0
 *   2500..4999        → S1
 *   5000..7499        → S2
 *   7500..9999        → S3 (wild)
 */
async function asProvider(provider: any, slots: any) {
  await env.networkHelpers.impersonateAccount(provider.address);
  await env.networkHelpers.setBalance(provider.address, parseEther("1"));
  const wc = await env.viem.getWalletClient(provider.address);
  return env.viem.getContractAt("MultiLineSlots", slots.address, { client: { wallet: wc } });
}

async function fulfillWithGrid(provider: any, slots: any, requestId: bigint, gridSymbols: number[]) {
  const rollPerSymbol = [1000n, 3000n, 6000n, 8000n]; // mid-bucket values
  const derivedValues = gridSymbols.map((s) => rollPerSymbol[s]);
  const slotsAsProvider = await asProvider(provider, slots);
  await slotsAsProvider.write.fulfillRandomness([requestId, 0n, derivedValues]);
  await env.networkHelpers.stopImpersonatingAccount(provider.address);
}

async function failWithReason(provider: any, slots: any, requestId: bigint, reason: `0x${string}`) {
  const slotsAsProvider = await asProvider(provider, slots);
  await slotsAsProvider.write.handleRandomFailure([requestId, reason, "0x"]);
  await env.networkHelpers.stopImpersonatingAccount(provider.address);
}

// ─────────────────────────────────────────────────────────────────────────────
// setSlotsConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — setSlotsConfig", () => {
  it("rejects max < min when both non-zero", async () => {
    const { slots } = await setup();
    await expectRevert(slots.write.setSlotsConfig([{
      enabled: true, activeSymbolCount: 4, minWagerPerLine: 100n, maxWagerPerLine: 50n,
    } as any]));
  });

  it("rejects activeSymbolCount > MAX_SYMBOLS", async () => {
    const { slots } = await setup();
    await expectRevert(slots.write.setSlotsConfig([{
      enabled: true, activeSymbolCount: 9, minWagerPerLine: 0n, maxWagerPerLine: 0n,
    } as any]));
  });

  it("happy path: pushes new config, advances currentConfigIndex, emits event", async () => {
    const { slots } = await setup();
    const idxBefore = await slots.read.currentConfigIndex();
    await slots.write.setSlotsConfig([{
      enabled: true, activeSymbolCount: 4, minWagerPerLine: 1n, maxWagerPerLine: 100n,
    } as any]);
    expect(await slots.read.currentConfigIndex()).to.equal(idxBefore + 1);
    const events = await slots.getEvents.SlotsConfigUpdated();
    expect(events.length > 0).to.equal(true);
  });

  it("rejects non-owner", async () => {
    const { slots } = await setup();
    const asOther = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setSlotsConfig([{
      enabled: true, activeSymbolCount: 4, minWagerPerLine: 0n, maxWagerPerLine: 0n,
    } as any]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setSymbolConfig (single)
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — setSymbolConfig", () => {
  it("rejects symbolId >= MAX_SYMBOLS", async () => {
    const { slots } = await setup();
    await expectRevert(slots.write.setSymbolConfig([
      8,
      sym(1000, 100, 0, false, true) as any,
    ]));
  });

  it("updates a single symbol and recomputes totalSymbolWeight", async () => {
    const { slots } = await setup();
    const weightBefore = await slots.read.totalSymbolWeight();
    // S0 was 2500, change to 5000 (delta +2500)
    await slots.write.setSymbolConfig([0, sym(5000, 200, 50, false, true) as any]);
    expect(await slots.read.totalSymbolWeight()).to.equal(weightBefore + 2500);
    const stored = await slots.read.getSymbol([0]);
    expect(stored.weightBps).to.equal(5000);
  });

  it("disabling a symbol removes its weight from totalSymbolWeight", async () => {
    const { slots } = await setup();
    const weightBefore = await slots.read.totalSymbolWeight();
    await slots.write.setSymbolConfig([0, sym(2500, 200, 50, false, false) as any]);
    expect(await slots.read.totalSymbolWeight()).to.equal(weightBefore - 2500);
  });

  it("rejects non-owner", async () => {
    const { slots } = await setup();
    const asOther = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setSymbolConfig([0, sym(1000, 100, 0, false, true) as any]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setAllSymbols (batch)
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — setAllSymbols", () => {
  it("replaces all 8 symbols and rebuilds totalSymbolWeight from scratch", async () => {
    const { slots } = await setup();
    const fresh = [
      sym(1000, 100, 25, false, true),
      sym(2000, 200, 50, false, true),
      sym(3000, 300, 75, false, true),
      sym(0, 0, 0, false, false),
      sym(0, 0, 0, false, false),
      sym(0, 0, 0, false, false),
      sym(0, 0, 0, false, false),
      sym(0, 0, 0, false, false),
    ];
    await slots.write.setAllSymbols([fresh as any]);
    expect(await slots.read.totalSymbolWeight()).to.equal(6000); // 1000 + 2000 + 3000
    const all = await slots.read.getAllSymbols();
    expect(all[0].weightBps).to.equal(1000);
    expect(all[3].enabled).to.equal(false);
  });

  it("rejects non-owner", async () => {
    const { slots } = await setup();
    const asOther = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setAllSymbols([defaultSymbolSet() as any]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startSpin — validation
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — startSpin validation", () => {
  it("rejects when config is disabled", async () => {
    const { slots } = await setup({ configEnabled: false });
    await expectRevert(placeSpinAsPlayer(slots, ONE_EVA, 1));
  });

  it("rejects payline counts other than 1, 3, 5", async () => {
    const { slots } = await setup();
    await expectRevert(placeSpinAsPlayer(slots, ONE_EVA, 2));
    await expectRevert(placeSpinAsPlayer(slots, ONE_EVA, 4));
  });

  it("rejects wager below minWagerPerLine", async () => {
    const { slots } = await setup();
    await slots.write.setSlotsConfig([{
      enabled: true, activeSymbolCount: 4, minWagerPerLine: ONE_EVA, maxWagerPerLine: 0n,
    } as any]);
    await expectRevert(placeSpinAsPlayer(slots, ONE_EVA / 2n, 1));
  });

  it("rejects wager above maxWagerPerLine", async () => {
    const { slots } = await setup();
    await slots.write.setSlotsConfig([{
      enabled: true, activeSymbolCount: 4, minWagerPerLine: 0n, maxWagerPerLine: ONE_EVA,
    } as any]);
    await expectRevert(placeSpinAsPlayer(slots, ONE_EVA * 2n, 1));
  });

  it("rejects when totalSymbolWeight is 0", async () => {
    const { slots } = await setup();
    // Disable all symbols
    const empty = Array.from({ length: 8 }, () => sym(0, 0, 0, false, false));
    await slots.write.setAllSymbols([empty as any]);
    await expectRevert(placeSpinAsPlayer(slots, ONE_EVA, 1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fulfillRandomness — payline outcomes (via impersonated provider)
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — fulfillRandomness payline outcomes", () => {
  it("rejects when caller is not the RandomProvider", async () => {
    const { slots } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1);
    // deployer is not the RandomProvider
    await expectRevert(slots.write.fulfillRandomness([1n, 0n, [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]]));
  });

  it("rejects when derivedValues.length < GRID_SIZE", async () => {
    const { slots, provider } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1);
    const asProv = await asProvider(provider, slots);
    await expectRevert(asProv.write.fulfillRandomness([1n, 0n, [0n]]));
    await env.networkHelpers.stopImpersonatingAccount(provider.address);
  });

  it("rejects unknown requestId", async () => {
    const { slots, provider } = await setup();
    const asProv = await asProvider(provider, slots);
    await expectRevert(asProv.write.fulfillRandomness([
      999n, 0n, Array.from({ length: GRID_SIZE }, () => 0n),
    ]));
    await env.networkHelpers.stopImpersonatingAccount(provider.address);
  });

  it("3-match horizontal: pays threeMatchPayout for the matching symbol", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1); // 1 payline (cells 0,1,2)
    const beforeBal = await token.read.balanceOf([player]);
    // Force S2 (10x payout) on cells 0, 1, 2; rest don't matter for payline 1
    await fulfillWithGrid(provider, slots, 1n, [2, 2, 2, 0, 0, 0, 0, 0, 0]);
    const afterBal = await token.read.balanceOf([player]);
    // Payout = wagerPerLine * S2.threeMatchPayout / SCALE = 1 EVA * 1000 / 100 = 10 EVA
    expect(afterBal - beforeBal).to.equal(ONE_EVA * 10n);

    const result = await slots.read.getSpinResult([1n]);
    expect(result.totalPayout).to.equal(ONE_EVA * 10n);
    expect(result.lineWins[0]).to.equal(true);
  });

  it("no win: leaves payout = 0 and emits SpinResolved with 0 winning lines", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1);
    const beforeBal = await token.read.balanceOf([player]);
    // All 3 cells different (S0, S1, S2) — no match, no wild
    await fulfillWithGrid(provider, slots, 1n, [0, 1, 2, 0, 0, 0, 0, 0, 0]);
    const afterBal = await token.read.balanceOf([player]);
    expect(afterBal - beforeBal).to.equal(0n);

    const events = await slots.getEvents.SpinResolved();
    const evt = events.find((e) => e.args.requestId === 1n);
    expect(evt?.args.winningLineCount).to.equal(0);
    expect(evt?.args.totalPayout).to.equal(0n);
  });

  it("2-match: pays twoMatchPayout when symbol has it, only on matching pair", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1);
    const beforeBal = await token.read.balanceOf([player]);
    // S2, S2, S0 → 2-match S2 (twoMatchPayout = 200 = 2.0x)
    await fulfillWithGrid(provider, slots, 1n, [2, 2, 0, 0, 0, 0, 0, 0, 0]);
    const afterBal = await token.read.balanceOf([player]);
    expect(afterBal - beforeBal).to.equal(ONE_EVA * 2n);
  });

  it("wild substitutes for any non-wild on 3-match (1 wild + 2 same)", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1);
    const beforeBal = await token.read.balanceOf([player]);
    // S2, WILD(S3), S2 → 3-match counted as S2 (10x)
    await fulfillWithGrid(provider, slots, 1n, [2, 3, 2, 0, 0, 0, 0, 0, 0]);
    const afterBal = await token.read.balanceOf([player]);
    expect(afterBal - beforeBal).to.equal(ONE_EVA * 10n);
  });

  it("two wilds force a 3-match using whichever non-wild is present", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1);
    const beforeBal = await token.read.balanceOf([player]);
    // WILD, WILD, S1 → 3-match counted as S1 (5x)
    await fulfillWithGrid(provider, slots, 1n, [3, 3, 1, 0, 0, 0, 0, 0, 0]);
    const afterBal = await token.read.balanceOf([player]);
    expect(afterBal - beforeBal).to.equal(ONE_EVA * 5n);
  });

  it("three wilds is treated as 3-match using the first cell's symbol id (wild itself)", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1);
    const beforeBal = await token.read.balanceOf([player]);
    // WILD, WILD, WILD → 3-match using S3, but S3.threeMatchPayout = 0
    await fulfillWithGrid(provider, slots, 1n, [3, 3, 3, 0, 0, 0, 0, 0, 0]);
    const afterBal = await token.read.balanceOf([player]);
    // Payout = wagerPerLine * 0 / SCALE = 0
    expect(afterBal - beforeBal).to.equal(0n);
  });

  it("multiple paylines: 3-match horizontal row 1 and row 2 both win independently", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 3); // 3 paylines (rows 0, 1, 2)
    const beforeBal = await token.read.balanceOf([player]);
    // Row 0: S2, S2, S2 (10x)
    // Row 1: S1, S1, S1 (5x)
    // Row 2: S0, S0, S0 (2x)
    await fulfillWithGrid(provider, slots, 1n, [2, 2, 2, 1, 1, 1, 0, 0, 0]);
    const afterBal = await token.read.balanceOf([player]);
    // Total = 10 + 5 + 2 = 17 EVA
    expect(afterBal - beforeBal).to.equal(ONE_EVA * 17n);

    const result = await slots.read.getSpinResult([1n]);
    expect(result.lineWins[0]).to.equal(true);
    expect(result.lineWins[1]).to.equal(true);
    expect(result.lineWins[2]).to.equal(true);
  });

  it("diagonal payline (5 paylines covers them too)", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 5); // 5 paylines (rows + diagonals)
    const beforeBal = await token.read.balanceOf([player]);
    // Diagonal payline 4 is cells 2, 4, 6 — set those to S2 (10x). Other paylines arranged as no-match.
    // Cells: [0]=S0, [1]=S1, [2]=S2, [3]=S0, [4]=S2, [5]=S1, [6]=S2, [7]=S0, [8]=S1
    // Row 0 (0,1,2): S0,S1,S2 → no match
    // Row 1 (3,4,5): S0,S2,S1 → no match
    // Row 2 (6,7,8): S2,S0,S1 → no match
    // Diag 3 (0,4,8): S0,S2,S1 → no match
    // Diag 4 (2,4,6): S2,S2,S2 → 3-match S2 (10x)
    await fulfillWithGrid(provider, slots, 1n, [0, 1, 2, 0, 2, 1, 2, 0, 1]);
    const afterBal = await token.read.balanceOf([player]);
    expect(afterBal - beforeBal).to.equal(ONE_EVA * 10n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleRandomFailure
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — handleRandomFailure", () => {
  it("rejects non-RandomProvider caller", async () => {
    const { slots } = await setup();
    await expectRevert(slots.write.handleRandomFailure([1n, ("0x" + "00".repeat(32)) as `0x${string}`, "0x"]));
  });

  it("refunds netStake to the player and emits SpinFailed", async () => {
    const { slots, provider, token } = await setup();
    await placeSpinAsPlayer(slots, ONE_EVA, 1);
    const reason = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const beforeBal = await token.read.balanceOf([player]);
    await failWithReason(provider, slots, 1n, reason);
    const afterBal = await token.read.balanceOf([player]);
    // Net stake = wager - house - referral - jackpot = 1 EVA * 9600 / 10000 = 0.96 EVA
    expect(afterBal - beforeBal).to.equal((ONE_EVA * 9600n) / 10000n);

    const events = await slots.getEvents.SpinFailed();
    const evt = events.find((e) => e.args.requestId === 1n);
    expect(evt, "SpinFailed not emitted").to.exist;
    // refundAmount in the event matches what was actually transferred (the netStake).
    expect(evt!.args.refundAmount).to.equal((ONE_EVA * 9600n) / 10000n);
    expect(evt!.args.reason).to.equal(reason);
  });

  it("silently returns for unknown requestId (no revert)", async () => {
    const { slots, provider } = await setup();
    const reason = ("0x" + "00".repeat(32)) as `0x${string}`;
    // Should not revert
    await failWithReason(provider, slots, 999n, reason);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// View functions
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — view functions", () => {
  it("getSlotsConfig() returns the current config (no-arg overload)", async () => {
    const { slots } = await setup();
    const cfg = await slots.read.getSlotsConfig();
    expect(cfg.enabled).to.equal(true);
    expect(cfg.activeSymbolCount).to.equal(4);
  });

  it("getSlotsConfig(index) returns the requested config or reverts on out-of-bounds", async () => {
    const { slots } = await setup();
    const cfg = await slots.read.getSlotsConfig([1n]); // index 1 (fresh config from setup)
    expect(cfg.enabled).to.equal(true);
    await expectRevert(slots.read.getSlotsConfig([99n]), "config index");
  });

  it("getSymbol(id) returns a single symbol or reverts on out-of-bounds", async () => {
    const { slots } = await setup();
    const s = await slots.read.getSymbol([0]);
    expect(s.weightBps).to.equal(2500);
    await expectRevert(slots.read.getSymbol([8]), "symbol index");
  });

  it("getAllSymbols returns 8-tuple of configs", async () => {
    const { slots } = await setup();
    const all = await slots.read.getAllSymbols();
    expect(all.length).to.equal(8);
    expect(all[0].enabled).to.equal(true);
    expect(all[7].enabled).to.equal(false);
  });

  it("getPaylines returns the 5 paylines", async () => {
    const { slots } = await setup();
    const lines = await slots.read.getPaylines();
    expect(lines.length).to.equal(5);
    expect(lines[0]).to.deep.equal([0, 1, 2]);
    expect(lines[3]).to.deep.equal([0, 4, 8]);
    expect(lines[4]).to.deep.equal([2, 4, 6]);
  });

  it("previewSpin: estimates totalWager, maxPayout, and netStake correctly", async () => {
    const { slots } = await setup();
    const [totalWager, maxPayout, netStake] = await slots.read.previewSpin([ONE_EVA, 3]);
    expect(totalWager).to.equal(ONE_EVA * 3n);
    // maxPayout = wagerPerLine * paylineCount * maxThreeMatch / SCALE = 1 * 3 * 1000 / 100 = 30 EVA
    expect(maxPayout).to.equal(ONE_EVA * 30n);
    // netStake = totalWager * 9600/10000
    expect(netStake).to.equal((ONE_EVA * 3n * 9600n) / 10000n);
  });

  it("getSpinResult returns empty struct for unknown requestId", async () => {
    const { slots } = await setup();
    const result = await slots.read.getSpinResult([999n]);
    expect(result.totalPayout).to.equal(0n);
  });
});
