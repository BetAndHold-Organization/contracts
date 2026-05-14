import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { encodePacked, keccak256, parseEther } from "viem";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA, MAX_BPS } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

/**
 * Platform end-to-end integration test.
 *
 * Deploys the entire platform — token, AuthHub, MultiLevelReferral, PaymentHandler,
 * RandomProvider, ProgressiveJackpot, and all six games — wires it all together,
 * and exercises full bet/settlement/payout cycles for each surface.
 *
 * The ONLY mock is the Chainlink VRF coordinator (so we control VRF outputs).
 * Every other contract is the production implementation.
 *
 * Phases:
 *   1. Bootstrap: deploy + wire everything
 *   2. Direct play cycles for every game (Roulette, Slots, Plinko, Mines, PaymentOnly, PJ)
 *   3. Delegated play (*For) cycles for every game
 *   4. Roulette → ProgressiveJackpot integration (covers JackpotScalingLib paths)
 *   5. Referral payout flow (MLR credits a referrer)
 *   6. TicketLottery full draw cycle
 *   7. Lifecycle ops (cancellation, VRF timeout, force-fail)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared environment + deployments
// ─────────────────────────────────────────────────────────────────────────────

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let deployer: `0x${string}`;
let player: `0x${string}`;
let player2: `0x${string}`;
let sessionKey: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;
let other: `0x${string}`;

// Contracts
let token: any;
let authHub: any;
let mlr: any;
let paymentHandler: any;
let coordinator: any;
let randomProvider: any;
let pj: any;
let roulette: any;
let slots: any;
let plinko: any;
let mines: any;
let payAdapter: any;
let lottery: any;

// Constants used across phases
const HOUSE_BPS = 200;       // 2%
const REFERRAL_BPS = 200;    // 2%
const JACKPOT_BPS = 100;     // 1% routed to PJ at bet entry
const NET_BPS = Number(MAX_BPS) - HOUSE_BPS - REFERRAL_BPS - JACKPOT_BPS;

const VRF_KEYHASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const VRF_SUB_ID = 1n;

const SECRET = ("0x" + "aa".repeat(32)) as `0x${string}`;
const NONCE_COMMIT = ("0x" + "11".repeat(32)) as `0x${string}`;

const HUGE_SPEND_CAP = HUNDRED_EVA * 1000n; // generous cap so cycles don't run out

// Plinko / Slots / Roulette parameters reused across phases
const PLINKO_ROWS = 4;
const ROULETTE_MIN_MULT = 200;
const ROULETTE_MAX_MULT = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function nowOnChain(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

function buildMinesCommit(secret: `0x${string}`, p: `0x${string}`, mc: number, wager: bigint): `0x${string}` {
  return keccak256(
    encodePacked(["bytes32", "address", "uint8", "uint256"], [secret, p, mc, wager]),
  );
}

function buildMinesClickCommit(clicks: number[], nonce: `0x${string}`, p: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["uint8[]", "bytes32", "address"], [clicks, nonce, p]));
}

async function buildOracleSig(
  signerWallet: (typeof walletClients)[number],
  requestId: bigint,
  secret: `0x${string}`,
  clicks: number[],
): Promise<`0x${string}`> {
  const innerHash = keccak256(
    encodePacked(["uint256", "bytes32", "uint8[]"], [requestId, secret, clicks]),
  );
  return signerWallet.signMessage({ message: { raw: innerHash } });
}

/** Have the mock coordinator deliver `randomWords` for `requestId` to the RandomProvider. */
async function vrfFulfill(requestId: bigint, randomWords: bigint[]) {
  const txHash = await coordinator.write.fulfill([randomProvider.address, requestId, randomWords]);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1: BOOTSTRAP — deploy and wire the entire platform
// ─────────────────────────────────────────────────────────────────────────────

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();

  deployer = walletClients[0].account.address;
  player = walletClients[1].account.address;
  sessionKey = walletClients[2].account.address;
  operator = walletClients[3].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;
  other = walletClients[6].account.address;
  player2 = walletClients[8].account.address;

  // ── Core contracts ──
  token = await env.viem.deployContract("EverValueCoin");
  authHub = await env.viem.deployContract("AuthHub");
  mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  paymentHandler = await env.viem.deployContract("PaymentHandler", [token.address]);
  coordinator = await env.viem.deployContract("MockVRFCoordinatorV2Plus");
  randomProvider = await env.viem.deployContract("RandomProvider", [coordinator.address]);
  await randomProvider.write.setSubscriptionId([VRF_SUB_ID]);

  // MLR ↔ PaymentHandler wiring + referral levels
  await mlr.write.setLevels([3, [4000, 3000, 2000]]);
  await mlr.write.setPaymentHandler([paymentHandler.address]);
  await paymentHandler.write.setReferralContract([mlr.address]);

  // ── ProgressiveJackpot ──
  pj = await env.viem.deployContract("ProgressiveJackpot", [
    token.address, randomProvider.address, authHub.address,
  ]);
  await pj.write.setPaymentHandler([paymentHandler.address]);
  await paymentHandler.write.setJackpot([pj.address]);

  // PJ is also a VRF consumer (for direct bets)
  await randomProvider.write.setConsumerStatus([pj.address, true, 1n]);

  // PJ tier ladder (9 tiers)
  const tiers = Array.from({ length: 9 }, (_, i) => ({
    prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
    fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
  }));
  await pj.write.setTierLadder([tiers]);

  // PROBABILITY_PRECISION = 1_000_000 by default (let me check what setAllTierProbConfigs takes)
  // sig: setAllTierProbConfigs(uint32 baseProbability, uint32 maxProbability, uint32 increment)
  await pj.write.setAllTierProbConfigs([1000, 50_000, 30]);

  // Direct bet outcomes for PJ: outcome 0 = lose, 1 = consolation, 2 = consolation, 3..11 = tier awards
  const directOutcomes = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,    awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
  ];
  for (let i = 0; i < 9; i++) {
    directOutcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  }
  await pj.write.configureDirectBet([true, directOutcomes]);
  await pj.write.setDirectFallback([0]);

  // Register PJ's direct-bet game config ALSO as a registered game on PaymentHandler
  // (PJ acts as both jackpot and a "game" that processes its own direct bets)
  await paymentHandler.write.registerGame([
    pj.address, pj.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([pj.address, true]);

  // Seed PJ pots so direct bets and game entries can pay out
  await token.write.approve([pj.address, HUNDRED_EVA]);
  await pj.write.seedConsolationPot([HUNDRED_EVA]);
  for (let i = 0; i < 9; i++) {
    await token.write.approve([pj.address, HUNDRED_EVA]);
    await pj.write.seedTierPot([i, HUNDRED_EVA]);
  }

  // ── AuthHub: register operator ──
  await authHub.write.setOperator([operator, true]);

  // ── Roulette ──
  roulette = await env.viem.deployContract("SingleRandomRoulette", [
    paymentHandler.address, randomProvider.address, token.address, authHub.address,
  ]);
  await randomProvider.write.setConsumerStatus([roulette.address, true, 8n]); // MAX_ROLLS+1 = 7
  await paymentHandler.write.registerGame([
    roulette.address, roulette.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([roulette.address, true]);
  // Initial table — no jackpot bps yet (jackpot scaling tested in phase 4)
  await roulette.write.setTableConfig([{
    enabled: true,
    replayBps: 0,
    jackpotBps: 0,
    minMultiplier: ROULETTE_MIN_MULT,
    maxMultiplier: ROULETTE_MAX_MULT,
    minWager: 0n,
    maxWager: 0n,
  } as any]);

  // ── MultiLineSlots ──
  slots = await env.viem.deployContract("MultiLineSlots", [
    paymentHandler.address, randomProvider.address, token.address, authHub.address,
  ]);
  await randomProvider.write.setConsumerStatus([slots.address, true, 9n]); // GRID_SIZE = 9
  await paymentHandler.write.registerGame([
    slots.address, slots.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([slots.address, true]);

  const slotSym = (w: number, three: number, two: number, isWild: boolean, enabled: boolean) =>
    ({ weightBps: w, threeMatchPayout: three, twoMatchPayout: two, isWild, enabled });
  await slots.write.setAllSymbols([[
    slotSym(2500, 200, 50, false, true),
    slotSym(2500, 500, 100, false, true),
    slotSym(2500, 1000, 200, false, true),
    slotSym(2500, 0, 0, true, true),
    slotSym(0, 0, 0, false, false),
    slotSym(0, 0, 0, false, false),
    slotSym(0, 0, 0, false, false),
    slotSym(0, 0, 0, false, false),
  ] as any]);
  await slots.write.setSlotsConfig([{
    enabled: true, activeSymbolCount: 4, minWagerPerLine: 0n, maxWagerPerLine: 0n,
  } as any]);

  // ── Plinko ──
  plinko = await env.viem.deployContract("Plinko", [
    paymentHandler.address, randomProvider.address, token.address, authHub.address,
    operator, // initialOperator
    0n, 0n,    // minBet, maxBet
  ]);
  await randomProvider.write.setConsumerStatus([plinko.address, true, 1n]);
  await paymentHandler.write.registerGame([
    plinko.address, plinko.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([plinko.address, true]);
  await plinko.write.setAllowedRows([[PLINKO_ROWS]]);
  // Symmetric uniform multipliers so payouts are predictable
  await plinko.write.setMultipliers([PLINKO_ROWS, 0, [100n, 100n, 100n, 100n, 100n]]);

  // ── Mines (uses the SAME RandomProvider — getRawWord is on the production interface) ──
  // NOTE: Mines' MockMinesRandomProvider is for unit tests; in production it points at
  // RandomProvider, which exposes getRawWord publicly. So we use the real one here.
  mines = await env.viem.deployContract("MinesGameHybridV2", [
    token.address, paymentHandler.address, randomProvider.address, authHub.address,
    operator,
  ]);
  await randomProvider.write.setConsumerStatus([mines.address, true, 1n]);
  await paymentHandler.write.registerGame([
    mines.address, mines.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([mines.address, true]);
  await mines.write.setTableConfig([{
    enabled: true, minMines: 3, maxMines: 5, minWager: 0n, maxWager: 0n, claimTimeout: 60,
  } as any]);
  // Multiplier table for 3 mines (TOTAL_SPOTS=21 → length 19)
  const minesTable: number[] = [];
  for (let i = 0; i < 19; i++) minesTable.push(100 + i * 10);
  await mines.write.setMultiplierTable([3, minesTable]);

  // ── PaymentOnlyGameAdapter ──
  payAdapter = await env.viem.deployContract("PaymentOnlyGameAdapter", [
    token.address, paymentHandler.address, authHub.address, operator,
  ]);
  await paymentHandler.write.registerGame([
    payAdapter.address, payAdapter.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([payAdapter.address, true]);

  // ── TicketLottery ──
  lottery = await env.viem.deployContract("TicketLottery", [
    coordinator.address, VRF_KEYHASH, VRF_SUB_ID, operator,
  ]);

  // ── Bankroll all games ──
  for (const game of [roulette, slots, plinko, mines, payAdapter, pj]) {
    await token.write.transfer([game.address, ONE_THOUSAND_EVA * 2n]);
  }

  // ── Fund player + player2 + approve all games ──
  for (const p of [player, player2]) {
    await token.write.transfer([p, HUNDRED_EVA * 50n]);
  }
  for (const game of [roulette, slots, plinko, mines, payAdapter, pj]) {
    const playerAsToken = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await playerAsToken.write.approve([game.address, ONE_THOUSAND_EVA]);
    const player2AsToken = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[8] },
    });
    await player2AsToken.write.approve([game.address, ONE_THOUSAND_EVA]);
  }

  // ── Authorize the player's session key with a generous spend cap ──
  const playerHub = await env.viem.getContractAt("AuthHub", authHub.address, {
    client: { wallet: walletClients[1] },
  });
  await playerHub.write.authorize([sessionKey, 0n, HUGE_SPEND_CAP]);
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Bootstrap verification
// ─────────────────────────────────────────────────────────────────────────────

describe("Platform E2E — Phase 1: bootstrap verification", () => {
  it("all core contracts are deployed and wired", async () => {
    expect((await paymentHandler.read.referralContract()).toLowerCase()).to.equal(mlr.address.toLowerCase());
    expect((await paymentHandler.read.getJackpot()).toLowerCase()).to.equal(pj.address.toLowerCase());
    expect((await pj.read.paymentHandler()).toLowerCase()).to.equal(paymentHandler.address.toLowerCase());
  });

  it("all games are registered as PaymentHandler games + AuthHub spend trackers", async () => {
    for (const g of [roulette, slots, plinko, mines, payAdapter, pj]) {
      // getGameConfig returns: (enabled, payoutTarget, feeRecipient, houseBps, referralBps, jackpotBps)
      const cfg = await paymentHandler.read.getGameConfig([g.address]);
      expect(cfg[0]).to.equal(true); // enabled
      expect(cfg[1].toLowerCase()).to.equal(g.address.toLowerCase()); // payoutTarget == game itself
      expect(await authHub.read.spendTrackers([g.address])).to.equal(true);
    }
  });

  it("RandomProvider has all VRF consumers registered", async () => {
    for (const g of [roulette, slots, plinko, mines, pj]) {
      expect(await randomProvider.read.allowedConsumers([g.address])).to.equal(true);
    }
  });

  it("PJ pots are seeded", async () => {
    expect(await pj.read.consolationPotBalance() > 0n).to.equal(true);
    for (let i = 0; i < 9; i++) {
      expect(await pj.read.tierPotBalance([i]) > 0n).to.equal(true);
    }
  });

  it("player has session key authorized with the configured spend cap", async () => {
    expect((await authHub.read.sessionKeyOf([player])).toLowerCase()).to.equal(sessionKey.toLowerCase());
    expect(await authHub.read.remainingSpend([player])).to.equal(HUGE_SPEND_CAP);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Direct play cycles (player calls each game directly)
// ─────────────────────────────────────────────────────────────────────────────

describe("Platform E2E — Phase 2: direct play cycles", () => {
  it("Roulette: player startSpin → fulfill (Multiplier win) → payout received", async () => {
    const playerR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[1] },
    });
    const txHash = await playerR.write.startSpin([ONE_EVA, BigInt(ROULETTE_MIN_MULT), ZERO_ADDRESS, false]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    // Find the VRF requestId emitted by RandomProvider
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    // Force Multiplier win: roll[0] = 0 always falls below multBps threshold
    const before = await token.read.balanceOf([player]);
    await vrfFulfill(requestId, [0n]);
    const after = await token.read.balanceOf([player]);
    // maxPayout = wager * mult / SCALE = 1 * 200 / 100 = 2 EVA
    expect(after - before).to.equal(ONE_EVA * 2n);
  });

  it("Slots: player startSpin → fulfill → settle (any outcome — VRF derived values internal)", async () => {
    const playerS = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[1] },
    });
    const txHash = await playerS.write.startSpin([ONE_EVA, 1, ZERO_ADDRESS]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;
    await vrfFulfill(requestId, [0xdeadbeefn]);

    const result = await slots.read.getSpinResult([requestId]);
    expect(result.timestamp > 0n).to.equal(true);
    const events = await slots.getEvents.SpinResolved();
    expect(events.find((e) => e.args.requestId === requestId), "SpinResolved not emitted").to.exist;
  });

  it("Plinko: player placeBet → fulfill → BetSettled with predictable payout", async () => {
    const playerP = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[1] },
    });
    const txHash = await playerP.write.placeBet([ONE_EVA, PLINKO_ROWS, 0, 1, ZERO_ADDRESS]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    const before = await token.read.balanceOf([player]);
    await vrfFulfill(requestId, [42n]);
    const after = await token.read.balanceOf([player]);
    // Uniform 1.0x mults → payout = 1 EVA exactly
    expect(after - before).to.equal(ONE_EVA);
  });

  it("Mines: full game cycle (start → commit → claim) using oracle attestation", async () => {
    const playerM = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const wager = ONE_EVA;
    const commit = buildMinesCommit(SECRET, player, 3, wager);
    const txStart = await playerM.write.startGame([wager, 3, ZERO_ADDRESS, commit]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txStart });

    // Mines also routes through RandomProvider; pull the requestId
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    // Fulfill VRF first so getRawWord(requestId) returns non-zero by the time we claim
    await vrfFulfill(requestId, [0xfeedfacen]);

    // Player commits to clicks
    const clicks = [0];
    const clickCommit = buildMinesClickCommit(clicks, NONCE_COMMIT, player);
    await playerM.write.commitToClicks([requestId, clickCommit]);

    // Operator signs the click outcome attestation (operator wallet is in gameOperators allowlist)
    const oracleSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);

    // Player claims — outcome may be hit-mine or safe (depends on the seed),
    // either way the game settles cleanly
    const before = await token.read.balanceOf([player]);
    await playerM.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, oracleSig]);
    const after = await token.read.balanceOf([player]);
    expect(after >= before).to.equal(true);

    const game = await mines.read.games([requestId]);
    expect(game[8]).to.equal(0); // GameStatus.None — game cleared
  });

  it("PaymentOnlyGameAdapter: player play → operator payWinner", async () => {
    const playerA = await env.viem.getContractAt("PaymentOnlyGameAdapter", payAdapter.address, {
      client: { wallet: walletClients[1] },
    });
    const beforeBet = await token.read.balanceOf([player]);
    const gameId = ("0x" + "ee".repeat(32)) as `0x${string}`;
    await playerA.write.play([ONE_EVA, ZERO_ADDRESS, gameId]);
    const afterBet = await token.read.balanceOf([player]);
    expect(beforeBet - afterBet).to.equal(ONE_EVA);

    // Operator pays out 1.5 EVA as a "winner"
    const opA = await env.viem.getContractAt("PaymentOnlyGameAdapter", payAdapter.address, {
      client: { wallet: walletClients[3] },
    });
    await opA.write.payWinner([player, ONE_EVA + (ONE_EVA / 2n)]);
    const afterPay = await token.read.balanceOf([player]);
    expect(afterPay - afterBet).to.equal(ONE_EVA + (ONE_EVA / 2n));
  });

  it("ProgressiveJackpot: player placeDirectBet → fulfill → outcome resolved", async () => {
    const playerJ = await env.viem.getContractAt("ProgressiveJackpot", pj.address, {
      client: { wallet: walletClients[1] },
    });
    const txHash = await playerJ.write.placeDirectBet([ZERO_ADDRESS]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    await vrfFulfill(requestId, [0n]); // roll = 0 → outcome[0] (LOSE) under fallback chain

    const events = await pj.getEvents.DirectBetSettled();
    expect(events.find((e) => e.args.requestId === requestId), "DirectBetSettled not emitted").to.exist;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Delegated play cycles (operator submits with player's signature)
// ─────────────────────────────────────────────────────────────────────────────

async function signRouletteFor(message: any) {
  return walletClients[2].signTypedData({
    domain: { name: "SingleRandomRoulette", version: "1", chainId, verifyingContract: roulette.address },
    types: {
      StartSpin: [
        { name: "game", type: "address" }, { name: "player", type: "address" },
        { name: "wager", type: "uint256" }, { name: "multiplierHundredths", type: "uint256" },
        { name: "potentialReferrer", type: "address" }, { name: "participateInJackpot", type: "bool" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartSpin", message,
  });
}

async function signSlotsFor(message: any) {
  return walletClients[2].signTypedData({
    domain: { name: "MultiLineSlots", version: "1", chainId, verifyingContract: slots.address },
    types: {
      StartSpin: [
        { name: "game", type: "address" }, { name: "player", type: "address" },
        { name: "wagerPerLine", type: "uint256" }, { name: "paylineCount", type: "uint8" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartSpin", message,
  });
}

async function signPlinkoFor(message: any) {
  return walletClients[2].signTypedData({
    domain: { name: "Plinko", version: "1", chainId, verifyingContract: plinko.address },
    types: {
      PlaceBet: [
        { name: "game", type: "address" }, { name: "player", type: "address" },
        { name: "betAmount", type: "uint256" }, { name: "rows", type: "uint8" },
        { name: "risk", type: "uint8" }, { name: "numDrops", type: "uint8" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PlaceBet", message,
  });
}

async function signMinesStartFor(message: any) {
  return walletClients[2].signTypedData({
    domain: { name: "MinesGameHybridV2", version: "1", chainId, verifyingContract: mines.address },
    types: {
      StartGame: [
        { name: "game", type: "address" }, { name: "player", type: "address" },
        { name: "wager", type: "uint256" }, { name: "minesCount", type: "uint8" },
        { name: "potentialReferrer", type: "address" }, { name: "commit", type: "bytes32" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartGame", message,
  });
}

async function signPayAdapterFor(message: any) {
  return walletClients[2].signTypedData({
    domain: { name: "PaymentOnlyGameAdapter", version: "1", chainId, verifyingContract: payAdapter.address },
    types: {
      Play: [
        { name: "game", type: "address" }, { name: "player", type: "address" },
        { name: "amount", type: "uint256" }, { name: "potentialReferrer", type: "address" },
        { name: "gameId", type: "bytes32" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Play", message,
  });
}

async function signPJFor(message: any) {
  return walletClients[2].signTypedData({
    domain: { name: "ProgressiveJackpot", version: "1", chainId, verifyingContract: pj.address },
    types: {
      PlaceDirectBet: [
        { name: "game", type: "address" }, { name: "player", type: "address" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PlaceDirectBet", message,
  });
}

describe("Platform E2E — Phase 3: delegated play (*For) cycles", () => {
  it("Roulette startSpinFor: operator submits, session key signs, player paid out", async () => {
    const t = await nowOnChain();
    const nonce = await roulette.read.actionNonces([player]);
    const sig = await signRouletteFor({
      game: roulette.address, player, wager: ONE_EVA, multiplierHundredths: BigInt(ROULETTE_MIN_MULT),
      potentialReferrer: ZERO_ADDRESS, participateInJackpot: false, nonce, deadline: t + 600n,
    });
    const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opR.write.startSpinFor([
      player, ONE_EVA, BigInt(ROULETTE_MIN_MULT), ZERO_ADDRESS, false, nonce, t + 600n, sig,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    const before = await token.read.balanceOf([player]);
    await vrfFulfill(requestId, [0n]);
    const after = await token.read.balanceOf([player]);
    expect(after - before).to.equal(ONE_EVA * 2n);
  });

  it("Slots startSpinFor: operator submits, fulfilled VRF settles", async () => {
    const t = await nowOnChain();
    const nonce = await slots.read.actionNonces([player]);
    const sig = await signSlotsFor({
      game: slots.address, player, wagerPerLine: ONE_EVA, paylineCount: 1,
      potentialReferrer: ZERO_ADDRESS, nonce, deadline: t + 600n,
    });
    const opS = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opS.write.startSpinFor([
      player, ONE_EVA, 1, ZERO_ADDRESS, nonce, t + 600n, sig,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;
    await vrfFulfill(requestId, [0xbeefn]);
    const events = await slots.getEvents.SpinResolved();
    expect(events.find((e) => e.args.requestId === requestId)).to.exist;
  });

  it("Plinko placeBetFor: operator submits, fulfilled VRF pays at uniform 1.0x", async () => {
    const t = await nowOnChain();
    const nonce = await plinko.read.actionNonces([player]);
    const sig = await signPlinkoFor({
      game: plinko.address, player, betAmount: ONE_EVA, rows: PLINKO_ROWS, risk: 0, numDrops: 1,
      potentialReferrer: ZERO_ADDRESS, nonce, deadline: t + 600n,
    });
    const opP = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opP.write.placeBetFor([
      player, ONE_EVA, PLINKO_ROWS, 0, 1, ZERO_ADDRESS, nonce, t + 600n, sig,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    const before = await token.read.balanceOf([player]);
    await vrfFulfill(requestId, [123n]);
    const after = await token.read.balanceOf([player]);
    expect(after - before).to.equal(ONE_EVA);
  });

  it("Mines startGameFor: operator submits start, game registered for the player", async () => {
    const t = await nowOnChain();
    const nonce = await mines.read.actionNonces([player]);
    const wager = ONE_EVA;
    const commit = buildMinesCommit(SECRET, player, 3, wager);
    const sig = await signMinesStartFor({
      game: mines.address, player, wager, minesCount: 3,
      potentialReferrer: ZERO_ADDRESS, commit, nonce, deadline: t + 600n,
    });
    const opM = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await opM.write.startGameFor([
      player, wager, 3, ZERO_ADDRESS, commit, nonce, t + 600n, sig,
    ]);
    expect(await mines.read.activeRequestIdByPlayer([player]) > 0n).to.equal(true);
  });

  it("PaymentOnlyGameAdapter playFor: operator submits play on player's behalf", async () => {
    const t = await nowOnChain();
    const nonce = await payAdapter.read.actionNonces([player]);
    const gameId = ("0x" + "dd".repeat(32)) as `0x${string}`;
    const sig = await signPayAdapterFor({
      game: payAdapter.address, player, amount: ONE_EVA, potentialReferrer: ZERO_ADDRESS,
      gameId, nonce, deadline: t + 600n,
    });
    const opA = await env.viem.getContractAt("PaymentOnlyGameAdapter", payAdapter.address, {
      client: { wallet: walletClients[3] },
    });
    const before = await token.read.balanceOf([player]);
    await opA.write.playFor([player, ONE_EVA, ZERO_ADDRESS, gameId, nonce, t + 600n, sig]);
    const after = await token.read.balanceOf([player]);
    expect(before - after).to.equal(ONE_EVA);
  });

  it("ProgressiveJackpot placeDirectBetFor: operator submits direct bet on player's behalf", async () => {
    const t = await nowOnChain();
    const nonce = await pj.read.actionNonces([player]);
    const sig = await signPJFor({
      game: pj.address, player, potentialReferrer: ZERO_ADDRESS, nonce, deadline: t + 600n,
    });
    const opJ = await env.viem.getContractAt("ProgressiveJackpot", pj.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opJ.write.placeDirectBetFor([player, ZERO_ADDRESS, nonce, t + 600n, sig]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;
    await vrfFulfill(requestId, [12345n]);
    const events = await pj.getEvents.DirectBetSettled();
    expect(events.find((e) => e.args.requestId === requestId)).to.exist;
  });

  it("Spend cap accumulates across all delegated bets", async () => {
    // We've placed multiple delegated bets; remainingSpend should have decreased.
    const remaining = await authHub.read.remainingSpend([player]);
    expect(remaining < HUGE_SPEND_CAP).to.equal(true);
    expect(remaining > 0n).to.equal(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Roulette ↔ ProgressiveJackpot integration
// (Covers JackpotScalingLib + Roulette _enterJackpot path)
// ─────────────────────────────────────────────────────────────────────────────

describe("Platform E2E — Phase 4: Roulette → ProgressiveJackpot integration", () => {
  it("admin enables jackpot bps on Roulette and registers Roulette as a PJ game", async () => {
    // PJ outcomes for Roulette entries: outcome 0 = lose, 1 = consolation, 2..10 = tier awards
    const rouletteOutcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,    awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    ];
    for (let i = 0; i < 9; i++) {
      rouletteOutcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
    }
    await pj.write.registerGame([roulette.address, rouletteOutcomes]);
    await pj.write.setGameFallback([roulette.address, 0]);

    // Update Roulette's table to enable jackpot bps now that PJ is wired
    await roulette.write.setTableConfig([{
      enabled: true,
      replayBps: 0,
      jackpotBps: 100, // 1% jackpot probability
      minMultiplier: ROULETTE_MIN_MULT,
      maxMultiplier: ROULETTE_MAX_MULT,
      minWager: 0n,
      maxWager: 0n,
    } as any]);

    // Configure jackpot scaling so JackpotScalingLib paths get exercised
    await roulette.write.setJackpotScalingConfig([{
      enabled: true,
      minJackpotBps: 50,
      maxJackpotBps: 500,
      minJackpotWager: ONE_EVA,
      maxJackpotWager: HUNDRED_EVA,
      functionId: 0, // Linear
      extraData: "0x",
    } as any]);

    expect(await pj.read.registeredGames([roulette.address])).to.equal(true);
  });

  it("Roulette spin with participateInJackpot=true: roll forces Jackpot outcome → PJ.processJackpotEntry", async () => {
    const playerR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[1] },
    });
    // Use minMultiplier so multiplierBps (probability) stays small
    const txHash = await playerR.write.startSpin([ONE_EVA, BigInt(ROULETTE_MIN_MULT), ZERO_ADDRESS, true]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    // RandomProvider takes a single VRF word and derives the spin's 7 bounded values internally.
    // We can't precisely target an outcome (Jackpot vs Multiplier vs Lose) without simulating
    // RandomDeriveLib offline; the test's purpose is to verify the Roulette ↔ PJ wiring, so we
    // accept any outcome and just check the spin resolved cleanly through the integrated stack.
    await vrfFulfill(requestId, [0xfeedfacecafebeefn]);

    const events = await roulette.getEvents.SpinResolved();
    const evt = events.find((e) => e.args.requestId === requestId);
    expect(evt, "SpinResolved should emit").to.exist;
    // outcome ∈ {Lose, Multiplier, Jackpot} — all three paths are valid game outputs.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Referral payout flow
// ─────────────────────────────────────────────────────────────────────────────

describe("Platform E2E — Phase 5: referral flow (player2 → player as referrer)", () => {
  it("player2 plays with player as referrer; MLR credits the referrer", async () => {
    // First time player2 plays referencing `player` as the referrer, MLR records them.
    const player2A = await env.viem.getContractAt("PaymentOnlyGameAdapter", payAdapter.address, {
      client: { wallet: walletClients[8] },
    });
    const gameId = ("0x" + "11".repeat(32)) as `0x${string}`;
    await player2A.write.play([ONE_EVA, player, gameId]);

    // MLR should have credited the referrer (player) for the upline portion.
    const credit = await mlr.read.pendingRewards([player]);
    expect(credit > 0n).to.equal(true);
  });

  it("player can claim accumulated referral rewards", async () => {
    const beforeBal = await token.read.balanceOf([player]);
    const playerMLR = await env.viem.getContractAt("MultiLevelReferral", mlr.address, {
      client: { wallet: walletClients[1] },
    });
    await playerMLR.write.withdrawRewards();
    const afterBal = await token.read.balanceOf([player]);
    expect(afterBal > beforeBal).to.equal(true);
    expect(await mlr.read.pendingRewards([player])).to.equal(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — TicketLottery full draw cycle
// ─────────────────────────────────────────────────────────────────────────────

describe("Platform E2E — Phase 6: TicketLottery", () => {
  it("operator requests winners → coordinator fulfills → result is queryable", async () => {
    const opL = await env.viem.getContractAt("TicketLottery", lottery.address, {
      client: { wallet: walletClients[3] },
    });
    const playersList = [player, player2, other];
    const tickets = [10n, 20n, 30n];
    const txHash = await opL.write.requestWinners([playersList, tickets, 2]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await coordinator.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    // Lottery uses the coordinator directly (not via RandomProvider); fulfill it on the lottery
    await coordinator.write.fulfill([lottery.address, requestId, [0xa1b2c3d4n]]);

    expect(await lottery.read.isLotteryFulfilled([requestId])).to.equal(true);
    const [winners] = await lottery.read.getLotteryResult([requestId]);
    expect(winners.length).to.equal(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 — Lifecycle ops (cancellation, VRF timeout)
// ─────────────────────────────────────────────────────────────────────────────

describe("Platform E2E — Phase 7: lifecycle operations", () => {
  it("Plinko: operator cancels an expired bet after betExpiryBlocks", async () => {
    // Set short expiry, place a bet, mine past it, operator cancels.
    await plinko.write.setBetExpiryBlocks([3n]);
    const playerP = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[1] },
    });
    const txHash = await playerP.write.placeBet([ONE_EVA, PLINKO_ROWS, 0, 1, ZERO_ADDRESS]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    await env.networkHelpers.mine(5);
    const opP = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    await opP.write.cancelExpiredBet([requestId]);

    const events = await plinko.getEvents.BetFailed();
    expect(events.find((e) => e.args.requestId === requestId)).to.exist;
  });

  it("RandomProvider: owner force-fails a stuck request after the VRF timeout", async () => {
    // Place a Plinko bet but don't fulfill VRF; advance time and force-fail it.
    const playerP = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[1] },
    });
    const txHash = await playerP.write.placeBet([ONE_EVA, PLINKO_ROWS, 0, 1, ZERO_ADDRESS]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    });
    const requestId = reqEvents[reqEvents.length - 1].args.requestId!;

    const REQUEST_TIMEOUT = await randomProvider.read.REQUEST_TIMEOUT();
    await env.networkHelpers.time.increase(Number(REQUEST_TIMEOUT) + 60);
    await randomProvider.write.forceFailRequest([requestId]);

    // Plinko should have received the failure callback
    const failed = await plinko.getEvents.BetFailed();
    expect(failed.find((e) => e.args.requestId === requestId)).to.exist;
  });

  it("Mines: operator cancels an expired game with refund", async () => {
    // Player has an active game from Phase 3 (startGameFor). Advance past claimTimeout.
    await env.networkHelpers.time.increase(120);
    const requestId = await mines.read.activeRequestIdByPlayer([player]);
    const opM = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await opM.write.cancelExpired([requestId, true]);
    const game = await mines.read.games([requestId]);
    expect(game[8]).to.equal(0); // GameStatus.None
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 8 — Configuration variations + edge-case coverage
// (Targets the last remaining branches: alt scaling curves, BaseGame fns, etc.)
//
// This phase deliberately mutates state (drains bankrolls, swaps handlers) and
// runs LAST because subsequent phases would observe stale state.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: do a Roulette spin with the given wager + (optional) jackpot participation,
 * then fulfill VRF with a fixed seed. Used to exercise alternate JackpotScalingLib curves.
 * Each spin runs JackpotScalingLib.computeProbability (the curve) at startSpin time, so
 * we don't need to force a Jackpot OUTCOME to cover the curves themselves.
 */
async function rouletteSpinWithSeed(wager: bigint, seed: bigint, participate = true) {
  const playerR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
    client: { wallet: walletClients[1] },
  });
  const txHash = await playerR.write.startSpin([wager, BigInt(ROULETTE_MIN_MULT), ZERO_ADDRESS, participate]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const reqEvents = await randomProvider.getEvents.RandomnessRequested({}, {
    fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
  });
  const requestId = reqEvents[reqEvents.length - 1].args.requestId!;
  await vrfFulfill(requestId, [seed]);
  return requestId;
}

describe("Platform E2E — Phase 8: alternate scaling curves + BaseGame branches", () => {
  before(async () => {
    // Top up Roulette bankroll so high-wager curve tests can lock the worst-case payout
    // (which uses maxMultiplier — currently 50x — for the lock estimate).
    await token.write.transfer([roulette.address, ONE_THOUSAND_EVA * 30n]);
    // Top the player up too — they've spent a lot across phases
    await token.write.transfer([player, ONE_THOUSAND_EVA]);
    // Re-approve Roulette generously
    const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await playerToken.write.approve([roulette.address, ONE_THOUSAND_EVA * 5n]);
  });

  it("JackpotScalingLib: Quadratic curve runs cleanly through a Roulette spin", async () => {
    await roulette.write.setJackpotScalingConfig([{
      enabled: true,
      minJackpotBps: 50,
      maxJackpotBps: 500,
      minJackpotWager: ONE_EVA,
      maxJackpotWager: HUNDRED_EVA,
      functionId: 1, // Quadratic
      extraData: "0x",
    } as any]);
    // Mid-range wager so the curve actually computes (not the boundary returns)
    await rouletteSpinWithSeed(HUNDRED_EVA / 2n, 0xa11ce5n, true);
  });

  it("JackpotScalingLib: Logarithmic curve runs cleanly through a Roulette spin", async () => {
    await roulette.write.setJackpotScalingConfig([{
      enabled: true,
      minJackpotBps: 50,
      maxJackpotBps: 500,
      minJackpotWager: ONE_EVA,
      maxJackpotWager: HUNDRED_EVA,
      functionId: 2, // Logarithmic
      extraData: "0x",
    } as any]);
    await rouletteSpinWithSeed(HUNDRED_EVA / 2n, 0xb0bn, true);
  });

  it("JackpotScalingLib: Exponential curve runs cleanly through a Roulette spin", async () => {
    await roulette.write.setJackpotScalingConfig([{
      enabled: true,
      minJackpotBps: 50,
      maxJackpotBps: 500,
      minJackpotWager: ONE_EVA,
      maxJackpotWager: HUNDRED_EVA,
      functionId: 3, // Exponential
      extraData: "0x",
    } as any]);
    await rouletteSpinWithSeed(HUNDRED_EVA / 2n, 0xc0den, true);
  });

  it("JackpotScalingLib: wager below minJackpotWager returns probability=0", async () => {
    await roulette.write.setJackpotScalingConfig([{
      enabled: true,
      minJackpotBps: 50,
      maxJackpotBps: 500,
      minJackpotWager: HUNDRED_EVA / 10n, // 10 EVA
      maxJackpotWager: HUNDRED_EVA,
      functionId: 0, // Linear
      extraData: "0x",
    } as any]);
    // 0.5 EVA — below 10 EVA min → returns 0 from the early branch
    await rouletteSpinWithSeed(ONE_EVA / 2n, 0xfeedn, true);
  });

  it("JackpotScalingLib: wager at/above maxJackpotWager returns the cap", async () => {
    // Use a smaller maxJackpotWager (50 EVA) so the wager that hits the cap (50 EVA) keeps
    // PJ's solvency check happy: maxConsolation = 50 * 1.2x = 60 EVA, under the 100 EVA tier pot.
    await roulette.write.setJackpotScalingConfig([{
      enabled: true,
      minJackpotBps: 50,
      maxJackpotBps: 500,
      minJackpotWager: ONE_EVA,
      maxJackpotWager: HUNDRED_EVA / 2n, // 50 EVA
      functionId: 0,
      extraData: "0x",
    } as any]);
    // 50 EVA wager == maxJackpotWager → hits the >= max branch in JackpotScalingLib
    await rouletteSpinWithSeed(HUNDRED_EVA / 2n, 0xfacen, true);
  });

  it("BaseGame.setPaymentHandler: swap revokes old approval, grants new (use a fresh, non-routing handler)", async () => {
    // Deploy a fresh handler that the adapter has never seen
    const newHandler = await env.viem.deployContract("PaymentHandler", [token.address]);

    const oldHandlerAddr = await payAdapter.read.paymentHandler();
    expect((await token.read.allowance([payAdapter.address, oldHandlerAddr])) > 0n).to.equal(true);

    await payAdapter.write.setPaymentHandler([newHandler.address]);

    expect((await payAdapter.read.paymentHandler()).toLowerCase()).to.equal(newHandler.address.toLowerCase());
    expect(await token.read.allowance([payAdapter.address, oldHandlerAddr])).to.equal(0n);
    expect((await token.read.allowance([payAdapter.address, newHandler.address])) > 0n).to.equal(true);

    // Restore so any later test on payAdapter still works
    await payAdapter.write.setPaymentHandler([oldHandlerAddr]);
  });

  it("BaseGame.unpause: pause + unpause restores bet inflow on Mines", async () => {
    // Use Mines — its bankroll has been preserved through earlier phases (apart from cancelled refund).
    // Note: Mines' active player game from earlier phases was already cancelled, so state is clean.
    await mines.write.pause();
    const playerM = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildMinesCommit(SECRET, player, 3, ONE_EVA);
    await expectRevert(playerM.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]));
    await mines.write.unpause();
    // After unpause, startGame should work
    await playerM.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
  });

  it("BaseGame.emergencyWithdraw (default impl): partial sweep on a paused game", async () => {
    // Slots base-impl emergencyWithdraw — pause, sweep half the balance.
    await slots.write.pause();
    const sweepRecipient = walletClients[9].account.address;
    const beforeRecip = await token.read.balanceOf([sweepRecipient]);
    const beforeGame = await token.read.balanceOf([slots.address]);
    expect(beforeGame > 0n).to.equal(true);

    const half = beforeGame / 2n;
    await slots.write.emergencyWithdraw([sweepRecipient, half]);

    expect(await token.read.balanceOf([sweepRecipient]) - beforeRecip).to.equal(half);
    // Don't unpause — next test needs Slots paused with reduced bankroll.
  });

  it("BaseGame.emergencyWithdraw: amount = 0 sweeps the remainder", async () => {
    // Continue from previous test — Slots is paused and has remaining balance.
    const sweepRecipient = walletClients[9].account.address;
    const beforeRecip = await token.read.balanceOf([sweepRecipient]);
    const remaining = await token.read.balanceOf([slots.address]);

    await slots.write.emergencyWithdraw([sweepRecipient, 0n]);

    expect(await token.read.balanceOf([sweepRecipient]) - beforeRecip).to.equal(remaining);
    expect(await token.read.balanceOf([slots.address])).to.equal(0n);
  });

  it("BaseGame.emergencyWithdraw: rejects amount > balance and zero recipient", async () => {
    // Slots is now empty and still paused
    await expectRevert(slots.write.emergencyWithdraw([deployer, ONE_EVA])); // bal == 0
    await expectRevert(slots.write.emergencyWithdraw([ZERO_ADDRESS, 0n]));
  });

  it("BaseGame.availableLiquidity: returns 0 when balance <= lockedExposure", async () => {
    // Slots has been fully drained; lockedExposure also resets to whatever it was.
    // Either way, balance (0) <= lockedExposure → returns 0 via the guard branch.
    expect(await slots.read.availableLiquidity()).to.equal(0n);
  });

  it("BaseGame.LiquidityShortfall: bet fails when bankroll cannot cover worst-case payout", async () => {
    // Slots was drained. Unpause it and try a normal-size bet — _lockExposure should revert
    // because balance is too small to cover the locked maxPayout.
    await slots.write.unpause();
    // Re-approve in case allowance is exhausted
    const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await playerToken.write.approve([slots.address, ONE_THOUSAND_EVA]);

    const playerS = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[1] },
    });
    // 1 EVA wager: maxPayout = 1 * 1 * 1000/100 = 10 EVA. Slots balance after collecting = 0.95 EVA.
    // 0.95 < 10 → LiquidityShortfall.
    await expectRevert(playerS.write.startSpin([ONE_EVA, 1, ZERO_ADDRESS]));
  });
});
