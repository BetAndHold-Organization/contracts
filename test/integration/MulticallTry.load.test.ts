import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import {
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseEther,
} from "viem";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";

/**
 * MulticallTry load + event verification stress test.
 *
 * Goal: prove that BaseGame.multicallTry holds up across all production games,
 * over many cycles, with every emitted event verified PARAMETER-BY-PARAMETER.
 *
 * Per cycle, for each of {Roulette, Mines, ProgressiveJackpot, Crash}, the
 * operator bundles 10 player-signed *For actions into one multicallTry. Crash
 * gets the extra lifecycle txs (createRound / startRound / fulfill / revealSeed /
 * settleRoundExposure) it requires per round.
 *
 * For every sub-call in every batch we assert:
 *   • the headline game event fires with exact (player, requestId/roundId, wager, …) values
 *   • the IGameEvents envelope BetPlaced fires (Roulette + Mines) with matching params
 *   • PaymentHandler.GameBetProcessed fires with the right slices
 *   • AuthHub.SpendingRecorded fires with the right cumulative spend
 *   • no MulticallSubCallFailed events were emitted
 *
 * Cross-cycle invariants verified at the end:
 *   • each player's per-game action nonce matches expected cycle count
 *   • each player's AuthHub.spent matches sum of all wagers across all 4 games
 */

// ─── Knobs ───────────────────────────────────────────────────────────────────
const CYCLES = 100;
const OPS_PER_CYCLE = 10;
const PLAYERS_COUNT = 10;

// Wagers per game (small so we never hit liquidity ceilings)
const ROULETTE_WAGER = ONE_EVA;             // 1 EVA
const MINES_WAGER = ONE_EVA;                // 1 EVA
const PJ_TIER_COST = ONE_EVA;               // direct-bet tier cost (set on tier ladder)
const CRASH_BET = parseEther("1");          // 1 EVA
const CRASH_AUTO_MULT = 15000;              // 1.5x — keeps per-bet exposure tiny

// Roulette table params
const ROULETTE_MIN_MULT = 200;              // 2.00x
const ROULETTE_MAX_MULT = 250;              // 2.50x (use the same one each call for determinism)
const ROULETTE_CHOICE_MULT = 200n;          // each bet uses min — small exposure

// Mines table
const MINES_COUNT = 3;
const MINES_SECRET = ("0x" + "aa".repeat(32)) as `0x${string}`;

// Splits
const HOUSE_BPS = 200;
const REFERRAL_BPS = 0;                     // 0% → no MLR events firing
const JACKPOT_BPS = 0;                      // 0% → no jackpot-share routing on this test
const NET_BPS = 10_000 - HOUSE_BPS - REFERRAL_BPS - JACKPOT_BPS;

// Generous spend cap per player so SpendingRecorded fires consistently and the
// cap never trips: each player spends roughly CYCLES * 4 * 1 EVA ≈ 400 EVA over the run.
const SPEND_CAP = HUNDRED_EVA * 1000n;      // 100,000 EVA

const VRF_SUB_ID = 1n;
const VRF_KEYHASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

// ─── Env / state ──────────────────────────────────────────────────────────────
let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let deployer: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;

// 10 distinct player wallets + ONE shared session-key wallet that signs for all of them.
// Hardhat default ships 20 accounts; reserving 0..3 for ops roles leaves 16 for players +
// session keys. Using a shared session key keeps us comfortably under that budget.
let players: { playerWallet: typeof walletClients[number] }[] = [];
let sessionWallet: typeof walletClients[number];

// Contracts
let token: any;
let authHub: any;
let mlr: any;
let paymentHandler: any;
let coordinator: any;
let randomProvider: any;
let pj: any;
let roulette: any;
let mines: any;
let crash: any;

// Tracker: cumulative spend per player (matches AuthHub.spent at any time)
const cumulativeSpend = new Map<`0x${string}`, bigint>();

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function nowOnChain(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}

function buildMinesCommit(secret: `0x${string}`, p: `0x${string}`, mc: number, wager: bigint): `0x${string}` {
  return keccak256(
    encodePacked(["bytes32", "address", "uint8", "uint256"], [secret, p, mc, wager]),
  );
}

function bumpSpend(player: `0x${string}`, amount: bigint) {
  cumulativeSpend.set(player, (cumulativeSpend.get(player) ?? 0n) + amount);
}

function expectedSpend(player: `0x${string}`): bigint {
  return cumulativeSpend.get(player) ?? 0n;
}

// EIP-712 signers ─────────────────────────────────────────────────────────────
async function signRoulette(
  sw: typeof walletClients[number],
  rouletteAddr: `0x${string}`,
  player: `0x${string}`,
  wager: bigint,
  multiplier: bigint,
  nonce: bigint,
  deadline: bigint,
) {
  return sw.signTypedData({
    domain: { name: "SingleRandomRoulette", version: "1", chainId, verifyingContract: rouletteAddr },
    types: {
      StartSpin: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "wager", type: "uint256" },
        { name: "multiplierHundredths", type: "uint256" },
        { name: "potentialReferrer", type: "address" },
        { name: "participateInJackpot", type: "bool" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartSpin",
    message: {
      game: rouletteAddr, player, wager, multiplierHundredths: multiplier,
      potentialReferrer: ZERO_ADDRESS as `0x${string}`,
      participateInJackpot: false, nonce, deadline,
    },
  });
}

async function signMines(
  sw: typeof walletClients[number],
  minesAddr: `0x${string}`,
  player: `0x${string}`,
  wager: bigint,
  minesCount: number,
  commit: `0x${string}`,
  nonce: bigint,
  deadline: bigint,
) {
  return sw.signTypedData({
    domain: { name: "MinesGameHybridV2", version: "1", chainId, verifyingContract: minesAddr },
    types: {
      StartGame: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "wager", type: "uint256" },
        { name: "minesCount", type: "uint8" },
        { name: "potentialReferrer", type: "address" },
        { name: "commit", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartGame",
    message: {
      game: minesAddr, player, wager, minesCount,
      potentialReferrer: ZERO_ADDRESS as `0x${string}`,
      commit, nonce, deadline,
    },
  });
}

async function signJackpot(
  sw: typeof walletClients[number],
  pjAddr: `0x${string}`,
  player: `0x${string}`,
  nonce: bigint,
  deadline: bigint,
) {
  return sw.signTypedData({
    domain: { name: "ProgressiveJackpot", version: "1", chainId, verifyingContract: pjAddr },
    types: {
      PlaceDirectBet: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PlaceDirectBet",
    message: {
      game: pjAddr, player,
      potentialReferrer: ZERO_ADDRESS as `0x${string}`,
      nonce, deadline,
    },
  });
}

async function signCrash(
  sw: typeof walletClients[number],
  crashAddr: `0x${string}`,
  player: `0x${string}`,
  amount: bigint,
  autoMult: number,
  nonce: bigint,
  deadline: bigint,
) {
  return sw.signTypedData({
    domain: { name: "CrashGame", version: "1", chainId, verifyingContract: crashAddr },
    types: {
      PlaceBet: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "autoCashoutMultiplier", type: "uint32" },
        { name: "referrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PlaceBet",
    message: {
      game: crashAddr, player, amount,
      autoCashoutMultiplier: autoMult,
      referrer: ZERO_ADDRESS as `0x${string}`,
      nonce, deadline,
    },
  });
}

// ABIs for calldata encoding ──────────────────────────────────────────────────
const rouletteAbi = parseAbi([
  "function startSpinFor(address player, uint256 wager, uint256 multiplierHundredths, address potentialReferrer, bool participateInJackpot, uint256 nonce, uint256 deadline, bytes signature)",
]);
const minesAbi = parseAbi([
  "function startGameFor(address player, uint256 wager, uint8 minesCount, address potentialReferrer, bytes32 commit, uint256 nonce, uint256 deadline, bytes signature)",
]);
const pjAbi = parseAbi([
  "function placeDirectBetFor(address player, address potentialReferrer, uint256 nonce, uint256 deadline, bytes signature)",
]);
const crashAbi = parseAbi([
  "function placeBetFor(address player, uint256 amount, uint32 autoCashoutMultiplier, address referrer, uint256 nonce, uint256 deadline, bytes signature)",
]);

// Event ABIs for receipt parsing ──────────────────────────────────────────────
const eventAbis = {
  spinStarted: parseAbi([
    "event SpinStarted(uint256 indexed requestId, address indexed player, uint256 wager, uint256 netStake, uint256 multiplierHundredths, uint256 maxPayout, uint32 configIndex, bool participateInJackpot)",
  ]),
  betPlacedEnvelope: parseAbi([
    "event BetPlaced(uint256 indexed requestId, address indexed player, uint256 amount, bytes data)",
  ]),
  gameStarted: parseAbi([
    "event GameStarted(uint256 indexed requestId, address indexed player, uint256 wager, uint256 netStake, uint8 minesCount, bytes32 commit, uint256 lockedAmount)",
  ]),
  gameCanceled: parseAbi([
    "event GameCanceled(uint256 indexed requestId, address indexed player, uint256 refundAmount)",
  ]),
  directBetRequested: parseAbi([
    "event DirectBetRequested(uint256 indexed requestId, address indexed player, uint256 amount, uint8 tierIndex)",
  ]),
  crashBetPlaced: parseAbi([
    "event BetPlaced(uint256 indexed roundId, address indexed player, uint256 betId, uint256 amount, uint256 netAmount, uint8 mode, uint32 autoCashoutMultiplier)",
  ]),
  gameBetProcessed: parseAbi([
    "event GameBetProcessed(address indexed game, address indexed bettor, address indexed assignedReferrer, uint256 baseCost, uint256 houseFee, uint256 referralFee, uint256 jackpotShare, uint256 netAmount)",
  ]),
  spendingRecorded: parseAbi([
    "event SpendingRecorded(address indexed player, address indexed game, uint256 amount, uint128 newSpent)",
  ]),
  multicallSubCallFailed: parseAbi([
    "event MulticallSubCallFailed(uint256 indexed index, bytes returnData)",
  ]),
};

// Filter logs by emitting address (case-insensitive) + decode through given abi
function decodeLogsFrom<T extends readonly any[]>(
  receipt: { logs: { address: `0x${string}`; topics: string[]; data: string }[] },
  abi: T,
  fromAddress: `0x${string}`,
): any[] {
  const matching = receipt.logs.filter(
    (l) => l.address.toLowerCase() === fromAddress.toLowerCase(),
  );
  return parseEventLogs({ abi, logs: matching as any });
}

function expectNoFailures(receipt: any) {
  const failed = parseEventLogs({ abi: eventAbis.multicallSubCallFailed, logs: receipt.logs });
  if (failed.length > 0) {
    const reasons = failed.map((f: any) => `idx=${f.args.index} data=${f.args.returnData}`).join(", ");
    throw new Error(`Unexpected MulticallSubCallFailed events: ${reasons}`);
  }
}

// Compute fee splits (mirrors PaymentHandler)
function feeSplit(base: bigint) {
  const house = (base * BigInt(HOUSE_BPS)) / 10_000n;
  const ref = (base * BigInt(REFERRAL_BPS)) / 10_000n;
  const jack = (base * BigInt(JACKPOT_BPS)) / 10_000n;
  const net = base - house - ref - jack;
  return { house, ref, jack, net };
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();

  deployer = walletClients[0].account.address;
  operator = walletClients[1].account.address;
  feeRecipient = walletClients[2].account.address;
  defaultRcv = walletClients[3].account.address;

  // 10 players: walletClients[4..13]; one shared session key wallet at walletClients[14]
  players = [];
  for (let i = 0; i < PLAYERS_COUNT; i++) {
    players.push({ playerWallet: walletClients[4 + i] });
  }
  sessionWallet = walletClients[4 + PLAYERS_COUNT];

  // ── Core ──
  token = await env.viem.deployContract("EverValueCoin");
  authHub = await env.viem.deployContract("AuthHub");
  mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  paymentHandler = await env.viem.deployContract("PaymentHandler", [token.address]);
  coordinator = await env.viem.deployContract("MockVRFCoordinatorV2Plus");
  randomProvider = await env.viem.deployContract("RandomProvider", [coordinator.address]);
  await randomProvider.write.setSubscriptionId([VRF_SUB_ID]);

  // MLR ↔ PaymentHandler wiring (no referrals used in this test, but the wiring still has to exist)
  await mlr.write.setLevels([1, [10_000]]);
  await mlr.write.setPaymentHandler([paymentHandler.address]);
  await paymentHandler.write.setReferralContract([mlr.address]);

  // ── Operator + spend trackers ──
  await authHub.write.setOperator([operator, true]);

  // ── ProgressiveJackpot ──
  pj = await env.viem.deployContract("ProgressiveJackpot", [
    token.address, randomProvider.address, authHub.address,
  ]);
  await pj.write.setPaymentHandler([paymentHandler.address]);
  await paymentHandler.write.setJackpot([pj.address]);
  await randomProvider.write.setConsumerStatus([pj.address, true, 1n]);

  // 9-tier ladder, fixed cost = PJ_TIER_COST per direct bet
  const tiers = Array.from({ length: 9 }, (_, i) => ({
    prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
    fixedBetCost: PJ_TIER_COST, useDynamicCost: false, costBps: 0,
  }));
  await pj.write.setTierLadder([tiers]);
  await pj.write.setAllTierProbConfigs([1000, 50_000, 30]);

  const directOutcomes = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
  ];
  for (let i = 0; i < 9; i++) {
    directOutcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  }
  await pj.write.configureDirectBet([true, directOutcomes]);
  await pj.write.setDirectFallback([0]);

  await paymentHandler.write.registerGame([
    pj.address, pj.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([pj.address, true]);

  // Seed PJ pots heavily — 10000 EVA each so payouts during cycles don't drain
  const POT_SEED = ONE_THOUSAND_EVA * 10n;
  await token.write.approve([pj.address, POT_SEED]);
  await pj.write.seedConsolationPot([POT_SEED]);
  for (let i = 0; i < 9; i++) {
    await token.write.approve([pj.address, POT_SEED]);
    await pj.write.seedTierPot([i, POT_SEED]);
  }

  // ── Roulette ──
  roulette = await env.viem.deployContract("SingleRandomRoulette", [
    paymentHandler.address, randomProvider.address, token.address, authHub.address,
  ]);
  await randomProvider.write.setConsumerStatus([roulette.address, true, 8n]);
  await paymentHandler.write.registerGame([
    roulette.address, roulette.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([roulette.address, true]);
  await roulette.write.setTableConfig([{
    enabled: true, replayBps: 0, jackpotBps: 0,
    minMultiplier: ROULETTE_MIN_MULT, maxMultiplier: ROULETTE_MAX_MULT,
    minWager: 0n, maxWager: 0n,
  } as any]);

  // ── Mines ──
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
    enabled: true, minMines: 3, maxMines: 5,
    minWager: 0n, maxWager: 0n, claimTimeout: 60,
  } as any]);
  const minesTable: number[] = [];
  for (let i = 0; i < 19; i++) minesTable.push(100 + i * 10);
  await mines.write.setMultiplierTable([MINES_COUNT, minesTable]);

  // ── CrashGame ──
  crash = await env.viem.deployContract("CrashGame", [
    token.address, paymentHandler.address, randomProvider.address,
    deployer,                                    // admin (so we can flip config)
    authHub.address,
    operator,                                    // initial game operator
  ]);
  await randomProvider.write.setConsumerStatus([crash.address, true, 1n]);
  await paymentHandler.write.registerGame([
    crash.address, crash.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([crash.address, true]);

  // Configure Crash for the load test: tiny min bet, large betting window. Operator bond
  // stays at the default 1000 EVA (setOperatorBondAmount(0) is blocked); we deposit it below.
  await crash.write.setBetLimits([parseEther("0.01"), parseEther("1000")]);
  await crash.write.setMaxBetsPerRound([0]);                  // 0 = unlimited
  await crash.write.setBettingWindow([300]);                  // 5 minutes — plenty for 10 sub-calls

  // Fund operator wallet with the bond and deposit it
  const OPERATOR_BOND = parseEther("1000");
  await token.write.transfer([operator, OPERATOR_BOND]);
  const opToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await opToken.write.approve([crash.address, OPERATOR_BOND]);
  const opCrashBondCtx = await env.viem.getContractAt("CrashGame", crash.address, {
    client: { wallet: walletClients[1] },
  });
  await opCrashBondCtx.write.depositBond([OPERATOR_BOND]);

  // ── Fund + approve + authorize session keys for every player ──
  const PER_PLAYER_FUND = ONE_THOUSAND_EVA;
  for (const { playerWallet } of players) {
    const p = playerWallet.account.address;
    await token.write.transfer([p, PER_PLAYER_FUND]);

    // Approve every game
    const tk = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: playerWallet },
    });
    await tk.write.approve([roulette.address, PER_PLAYER_FUND]);
    await tk.write.approve([mines.address, PER_PLAYER_FUND]);
    await tk.write.approve([pj.address, PER_PLAYER_FUND]);
    await tk.write.approve([crash.address, PER_PLAYER_FUND]);

    // Authorize their session key with a big-but-finite cap so SpendingRecorded fires
    const hub = await env.viem.getContractAt("AuthHub", authHub.address, {
      client: { wallet: playerWallet },
    });
    await hub.write.authorize([sessionWallet.account.address, 0n, SPEND_CAP]);
  }

  // Bankroll every game
  const BANKROLL = ONE_THOUSAND_EVA * 100n;       // 100k EVA each
  await token.write.transfer([roulette.address, BANKROLL]);
  await token.write.transfer([mines.address, BANKROLL]);
  await token.write.transfer([crash.address, BANKROLL]);
  // PJ already holds the seeded pots; no extra needed.
});

// ─── Per-game cycle runners ──────────────────────────────────────────────────

/**
 * Roulette: 10 players each place one spin via multicallTry; verify every event fires
 * with exact parameter values.
 */
async function runRouletteCycle(cycle: number) {
  const deadline = (await nowOnChain()) + 600n;
  const calls: `0x${string}`[] = [];
  const expected: { player: `0x${string}`; wager: bigint; multiplier: bigint }[] = [];

  for (const { playerWallet } of players) {
    const player = playerWallet.account.address;
    const sig = await signRoulette(
      sessionWallet, roulette.address, player,
      ROULETTE_WAGER, ROULETTE_CHOICE_MULT,
      BigInt(cycle), deadline,
    );
    calls.push(encodeFunctionData({
      abi: rouletteAbi, functionName: "startSpinFor",
      args: [player, ROULETTE_WAGER, ROULETTE_CHOICE_MULT, ZERO_ADDRESS as `0x${string}`, false, BigInt(cycle), deadline, sig],
    }));
    expected.push({ player, wager: ROULETTE_WAGER, multiplier: ROULETTE_CHOICE_MULT });
    bumpSpend(player, ROULETTE_WAGER);
  }

  const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
    client: { wallet: walletClients[1] },
  });
  const txHash = await opR.write.multicallTry([calls], { gas: 30_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  expectNoFailures(receipt);
  verifyRouletteReceipt(receipt, expected);
}

function verifyRouletteReceipt(
  receipt: any,
  expected: { player: `0x${string}`; wager: bigint; multiplier: bigint }[],
) {
  const spinEvents = decodeLogsFrom(receipt, eventAbis.spinStarted, roulette.address);
  const envelopeEvents = decodeLogsFrom(receipt, eventAbis.betPlacedEnvelope, roulette.address);
  const processedEvents = decodeLogsFrom(receipt, eventAbis.gameBetProcessed, paymentHandler.address);
  const spendEvents = decodeLogsFrom(receipt, eventAbis.spendingRecorded, authHub.address);

  expect(spinEvents.length, "SpinStarted count").to.equal(expected.length);
  expect(envelopeEvents.length, "envelope BetPlaced count").to.equal(expected.length);
  expect(processedEvents.length, "GameBetProcessed count").to.equal(expected.length);
  expect(spendEvents.length, "SpendingRecorded count").to.equal(expected.length);

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const { net } = feeSplit(exp.wager);
    // Roulette's maxPayout is computed from RAW wager, not netStake:
    //   maxPayout = wager * multiplierHundredths / MULTIPLIER_SCALE (= 100)
    const expectedMaxPayout = (exp.wager * exp.multiplier) / 100n;

    const spin: any = spinEvents[i];
    expect(spin.args.player.toLowerCase(), `Roulette[${i}] SpinStarted.player`).to.equal(exp.player.toLowerCase());
    expect(spin.args.wager, `Roulette[${i}] SpinStarted.wager`).to.equal(exp.wager);
    expect(spin.args.netStake, `Roulette[${i}] SpinStarted.netStake`).to.equal(net);
    expect(spin.args.multiplierHundredths, `Roulette[${i}] SpinStarted.multiplier`).to.equal(exp.multiplier);
    expect(spin.args.maxPayout, `Roulette[${i}] SpinStarted.maxPayout`).to.equal(expectedMaxPayout);
    expect(spin.args.participateInJackpot, `Roulette[${i}] SpinStarted.participateInJackpot`).to.equal(false);

    const env: any = envelopeEvents[i];
    expect(env.args.player.toLowerCase(), `Roulette[${i}] envelope.player`).to.equal(exp.player.toLowerCase());
    expect(env.args.requestId, `Roulette[${i}] envelope.requestId matches SpinStarted`).to.equal(spin.args.requestId);
    expect(env.args.amount, `Roulette[${i}] envelope.amount`).to.equal(exp.wager);

    const proc: any = processedEvents[i];
    expect(proc.args.bettor.toLowerCase(), `Roulette[${i}] processed.bettor`).to.equal(exp.player.toLowerCase());
    expect(proc.args.baseCost, `Roulette[${i}] processed.baseCost`).to.equal(exp.wager);
    expect(proc.args.houseFee, `Roulette[${i}] processed.houseFee`).to.equal((exp.wager * BigInt(HOUSE_BPS)) / 10_000n);
    expect(proc.args.netAmount, `Roulette[${i}] processed.netAmount`).to.equal(net);

    const spend: any = spendEvents[i];
    expect(spend.args.player.toLowerCase(), `Roulette[${i}] spend.player`).to.equal(exp.player.toLowerCase());
    expect(spend.args.game.toLowerCase(), `Roulette[${i}] spend.game`).to.equal(roulette.address.toLowerCase());
    expect(spend.args.amount, `Roulette[${i}] spend.amount`).to.equal(exp.wager);
    expect(spend.args.newSpent, `Roulette[${i}] spend.newSpent`).to.equal(expectedSpend(exp.player));
  }
}

/**
 * Mines: each cycle uses a fresh commit per player. From cycle 1 onwards, each
 * new startGameFor cancels the player's previous game → GameCanceled also fires.
 * Per-sub-call cumulativeSpend was bumped during build, so we recompute the
 * expected post-spend per event by tracking deltas inside the verifier.
 */
async function runMinesCycle(cycle: number) {
  const deadline = (await nowOnChain()) + 600n;
  const calls: `0x${string}`[] = [];
  const expected: { player: `0x${string}`; wager: bigint; commit: `0x${string}` }[] = [];

  for (const { playerWallet } of players) {
    const player = playerWallet.account.address;
    // Use a per-cycle, per-player unique secret so commits differ
    const secret = keccak256(
      encodePacked(["bytes32", "uint256", "address"], [MINES_SECRET, BigInt(cycle), player]),
    );
    const commit = buildMinesCommit(secret, player, MINES_COUNT, MINES_WAGER);
    const sig = await signMines(
      sessionWallet, mines.address, player,
      MINES_WAGER, MINES_COUNT, commit,
      BigInt(cycle), deadline,
    );
    calls.push(encodeFunctionData({
      abi: minesAbi, functionName: "startGameFor",
      args: [player, MINES_WAGER, MINES_COUNT, ZERO_ADDRESS as `0x${string}`, commit, BigInt(cycle), deadline, sig],
    }));
    expected.push({ player, wager: MINES_WAGER, commit });
    bumpSpend(player, MINES_WAGER);
  }

  const opM = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
    client: { wallet: walletClients[1] },
  });
  const txHash = await opM.write.multicallTry([calls], { gas: 30_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  expectNoFailures(receipt);
  verifyMinesReceipt(receipt, expected, cycle);
}

function verifyMinesReceipt(
  receipt: any,
  expected: { player: `0x${string}`; wager: bigint; commit: `0x${string}` }[],
  cycle: number,
) {
  const startedEvents = decodeLogsFrom(receipt, eventAbis.gameStarted, mines.address);
  const canceledEvents = decodeLogsFrom(receipt, eventAbis.gameCanceled, mines.address);
  const envelopeEvents = decodeLogsFrom(receipt, eventAbis.betPlacedEnvelope, mines.address);
  const processedEvents = decodeLogsFrom(receipt, eventAbis.gameBetProcessed, paymentHandler.address);
  const spendEvents = decodeLogsFrom(receipt, eventAbis.spendingRecorded, authHub.address);

  expect(startedEvents.length, "GameStarted count").to.equal(expected.length);
  expect(envelopeEvents.length, "envelope BetPlaced count").to.equal(expected.length);
  expect(processedEvents.length, "GameBetProcessed count").to.equal(expected.length);
  expect(spendEvents.length, "SpendingRecorded count").to.equal(expected.length);

  // Cancellation events: cycle 0 has none; cycles ≥1 have one per player
  const expectedCancels = cycle === 0 ? 0 : expected.length;
  expect(canceledEvents.length, `GameCanceled count (cycle ${cycle})`).to.equal(expectedCancels);

  // For cycle ≥1, each canceled event should reference one of the players' prior requestId
  if (cycle > 0) {
    const playersSet = new Set(expected.map((e) => e.player.toLowerCase()));
    for (const c of canceledEvents as any[]) {
      expect(playersSet.has(c.args.player.toLowerCase()), "canceled.player is one of the cycle's players").to.equal(true);
    }
  }

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const { net } = feeSplit(exp.wager);

    const started: any = startedEvents[i];
    expect(started.args.player.toLowerCase(), `Mines[${i}] GameStarted.player`).to.equal(exp.player.toLowerCase());
    expect(started.args.wager, `Mines[${i}] GameStarted.wager`).to.equal(exp.wager);
    expect(started.args.netStake, `Mines[${i}] GameStarted.netStake`).to.equal(net);
    expect(started.args.minesCount, `Mines[${i}] GameStarted.minesCount`).to.equal(MINES_COUNT);
    expect(started.args.commit, `Mines[${i}] GameStarted.commit`).to.equal(exp.commit);

    const env: any = envelopeEvents[i];
    expect(env.args.player.toLowerCase(), `Mines[${i}] envelope.player`).to.equal(exp.player.toLowerCase());
    expect(env.args.requestId, `Mines[${i}] envelope.requestId`).to.equal(started.args.requestId);
    expect(env.args.amount, `Mines[${i}] envelope.amount`).to.equal(exp.wager);

    const proc: any = processedEvents[i];
    expect(proc.args.bettor.toLowerCase(), `Mines[${i}] processed.bettor`).to.equal(exp.player.toLowerCase());
    expect(proc.args.baseCost, `Mines[${i}] processed.baseCost`).to.equal(exp.wager);
    expect(proc.args.netAmount, `Mines[${i}] processed.netAmount`).to.equal(net);

    const spend: any = spendEvents[i];
    expect(spend.args.player.toLowerCase(), `Mines[${i}] spend.player`).to.equal(exp.player.toLowerCase());
    expect(spend.args.game.toLowerCase(), `Mines[${i}] spend.game`).to.equal(mines.address.toLowerCase());
    expect(spend.args.amount, `Mines[${i}] spend.amount`).to.equal(exp.wager);
    expect(spend.args.newSpent, `Mines[${i}] spend.newSpent`).to.equal(expectedSpend(exp.player));
  }
}

/**
 * ProgressiveJackpot direct bets.
 */
async function runJackpotCycle(cycle: number) {
  const deadline = (await nowOnChain()) + 600n;
  const calls: `0x${string}`[] = [];
  const expected: { player: `0x${string}` }[] = [];

  for (const { playerWallet } of players) {
    const player = playerWallet.account.address;
    const sig = await signJackpot(
      sessionWallet, pj.address, player,
      BigInt(cycle), deadline,
    );
    calls.push(encodeFunctionData({
      abi: pjAbi, functionName: "placeDirectBetFor",
      args: [player, ZERO_ADDRESS as `0x${string}`, BigInt(cycle), deadline, sig],
    }));
    expected.push({ player });
    bumpSpend(player, PJ_TIER_COST);
  }

  const opPJ = await env.viem.getContractAt("ProgressiveJackpot", pj.address, {
    client: { wallet: walletClients[1] },
  });
  const txHash = await opPJ.write.multicallTry([calls], { gas: 30_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  expectNoFailures(receipt);
  verifyJackpotReceipt(receipt, expected);
}

function verifyJackpotReceipt(receipt: any, expected: { player: `0x${string}` }[]) {
  const requestedEvents = decodeLogsFrom(receipt, eventAbis.directBetRequested, pj.address);
  const processedEvents = decodeLogsFrom(receipt, eventAbis.gameBetProcessed, paymentHandler.address);
  const spendEvents = decodeLogsFrom(receipt, eventAbis.spendingRecorded, authHub.address);

  expect(requestedEvents.length, "DirectBetRequested count").to.equal(expected.length);
  expect(processedEvents.length, "GameBetProcessed count").to.equal(expected.length);
  expect(spendEvents.length, "SpendingRecorded count").to.equal(expected.length);

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const { net } = feeSplit(PJ_TIER_COST);

    const req: any = requestedEvents[i];
    expect(req.args.player.toLowerCase(), `Jackpot[${i}] requested.player`).to.equal(exp.player.toLowerCase());
    // DirectBetRequested.amount is the NET amount after PaymentHandler fees, not the raw tier cost.
    expect(req.args.amount, `Jackpot[${i}] requested.amount (net)`).to.equal(net);

    const proc: any = processedEvents[i];
    expect(proc.args.bettor.toLowerCase(), `Jackpot[${i}] processed.bettor`).to.equal(exp.player.toLowerCase());
    expect(proc.args.baseCost, `Jackpot[${i}] processed.baseCost`).to.equal(PJ_TIER_COST);
    expect(proc.args.netAmount, `Jackpot[${i}] processed.netAmount`).to.equal(net);

    const spend: any = spendEvents[i];
    expect(spend.args.player.toLowerCase(), `Jackpot[${i}] spend.player`).to.equal(exp.player.toLowerCase());
    expect(spend.args.game.toLowerCase(), `Jackpot[${i}] spend.game`).to.equal(pj.address.toLowerCase());
    expect(spend.args.amount, `Jackpot[${i}] spend.amount`).to.equal(PJ_TIER_COST);
    expect(spend.args.newSpent, `Jackpot[${i}] spend.newSpent`).to.equal(expectedSpend(exp.player));
  }
}

/**
 * Crash: cycles the round lifecycle around the multicallTry batch.
 *
 *   1. createRound(commitHash)
 *   2. multicallTry([placeBetFor × 10]) within the betting window
 *   3. startRound()
 *   4. coordinator.fulfill(...) — VRF callback transitions Crashed
 *   5. revealSeed(roundId, serverSeed)
 *   6. settleRoundExposure(roundId, 0)  — release the round-level exposure
 */
async function runCrashCycle(cycle: number) {
  // 1. createRound
  const serverSeed = keccak256(
    encodePacked(["uint256", "address"], [BigInt(cycle), crash.address as `0x${string}`]),
  );
  const commitHash = keccak256(encodePacked(["bytes32"], [serverSeed]));
  const opCrash = await env.viem.getContractAt("CrashGame", crash.address, {
    client: { wallet: walletClients[1] },
  });
  await opCrash.write.createRound([commitHash]);
  const currentRoundId = (await crash.read.currentRoundId()) as bigint;

  // 2. batch placeBetFor
  const deadline = (await nowOnChain()) + 600n;
  const calls: `0x${string}`[] = [];
  const expected: { player: `0x${string}`; amount: bigint }[] = [];

  for (const { playerWallet } of players) {
    const player = playerWallet.account.address;
    const sig = await signCrash(
      sessionWallet, crash.address, player,
      CRASH_BET, CRASH_AUTO_MULT,
      BigInt(cycle), deadline,
    );
    calls.push(encodeFunctionData({
      abi: crashAbi, functionName: "placeBetFor",
      args: [player, CRASH_BET, CRASH_AUTO_MULT, ZERO_ADDRESS as `0x${string}`, BigInt(cycle), deadline, sig],
    }));
    expected.push({ player, amount: CRASH_BET });
    bumpSpend(player, CRASH_BET);
  }

  const txHash = await opCrash.write.multicallTry([calls], { gas: 30_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  expectNoFailures(receipt);
  verifyCrashReceipt(receipt, expected, currentRoundId);

  // 3-6. round teardown so next cycle can createRound
  // crash.read.rounds(...) returns a tuple; vrfRequestId is index 4 in the Round struct
  // (roundId, state, commitHash, serverSeed, vrfRequestId, ...).
  const roundData = await crash.read.rounds([currentRoundId]) as readonly any[];
  const vrfReqId = roundData[4] as bigint;

  await opCrash.write.startRound();
  await coordinator.write.fulfill([randomProvider.address, vrfReqId, [12345n + BigInt(cycle)]]);
  const revealTx = await opCrash.write.revealSeed([currentRoundId, serverSeed]);
  const revealReceipt = await publicClient.waitForTransactionReceipt({ hash: revealTx });
  const settleTx = await opCrash.write.settleRoundExposure([currentRoundId, 0n]);
  const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleTx });

  // Spot-check the new lifecycle events on cycle 0 only — the load test runs the
  // teardown 100x and we don't want to re-decode per cycle.
  if (cycle === 0) {
    const revealAbi = parseAbi([
      "event RoundRevealed(uint256 indexed roundId, bytes32 serverSeed, uint32 crashPoint)",
    ]);
    const settleAbi = parseAbi([
      "event RoundSettled(uint256 indexed roundId, uint32 crashPoint, uint256 totalBetAmount, uint256 totalPayout)",
    ]);
    const reveals = parseEventLogs({ abi: revealAbi, logs: revealReceipt.logs as any });
    expect(reveals.length, "RoundRevealed count").to.equal(1);
    const r: any = reveals[0];
    expect(r.args.roundId).to.equal(currentRoundId);
    expect(r.args.serverSeed).to.equal(serverSeed);
    expect((r.args.crashPoint as number) > 0).to.equal(true);  // deterministic > 0

    const settles = parseEventLogs({ abi: settleAbi, logs: settleReceipt.logs as any });
    expect(settles.length, "RoundSettled count").to.equal(1);
    const s: any = settles[0];
    expect(s.args.roundId).to.equal(currentRoundId);
    expect(s.args.crashPoint).to.equal(r.args.crashPoint);
    expect(s.args.totalPayout).to.equal(0n);  // we passed 0 to settleRoundExposure
    // totalBetAmount must match what placeBetFor accumulated on the Round struct.
    // Round.totalBetAmount is index 12 in the Round struct.
    const finalRound = await crash.read.rounds([currentRoundId]) as readonly any[];
    expect(s.args.totalBetAmount).to.equal(finalRound[12]);
  }
}

function verifyCrashReceipt(
  receipt: any,
  expected: { player: `0x${string}`; amount: bigint }[],
  roundId: bigint,
) {
  const betEvents = decodeLogsFrom(receipt, eventAbis.crashBetPlaced, crash.address);
  const processedEvents = decodeLogsFrom(receipt, eventAbis.gameBetProcessed, paymentHandler.address);
  const spendEvents = decodeLogsFrom(receipt, eventAbis.spendingRecorded, authHub.address);

  expect(betEvents.length, "Crash BetPlaced count").to.equal(expected.length);
  expect(processedEvents.length, "GameBetProcessed count").to.equal(expected.length);
  expect(spendEvents.length, "SpendingRecorded count").to.equal(expected.length);

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const { net } = feeSplit(exp.amount);

    const b: any = betEvents[i];
    expect(b.args.player.toLowerCase(), `Crash[${i}] BetPlaced.player`).to.equal(exp.player.toLowerCase());
    expect(b.args.roundId, `Crash[${i}] BetPlaced.roundId`).to.equal(roundId);
    expect(b.args.amount, `Crash[${i}] BetPlaced.amount`).to.equal(exp.amount);
    expect(b.args.netAmount, `Crash[${i}] BetPlaced.netAmount`).to.equal(net);
    expect(b.args.autoCashoutMultiplier, `Crash[${i}] BetPlaced.autoMult`).to.equal(CRASH_AUTO_MULT);

    const proc: any = processedEvents[i];
    expect(proc.args.bettor.toLowerCase(), `Crash[${i}] processed.bettor`).to.equal(exp.player.toLowerCase());
    expect(proc.args.baseCost, `Crash[${i}] processed.baseCost`).to.equal(exp.amount);
    expect(proc.args.netAmount, `Crash[${i}] processed.netAmount`).to.equal(net);

    const spend: any = spendEvents[i];
    expect(spend.args.player.toLowerCase(), `Crash[${i}] spend.player`).to.equal(exp.player.toLowerCase());
    expect(spend.args.game.toLowerCase(), `Crash[${i}] spend.game`).to.equal(crash.address.toLowerCase());
    expect(spend.args.amount, `Crash[${i}] spend.amount`).to.equal(exp.amount);
    expect(spend.args.newSpent, `Crash[${i}] spend.newSpent`).to.equal(expectedSpend(exp.player));
  }
}

// ─── The test ────────────────────────────────────────────────────────────────
describe("BaseGame.multicallTry — load test (4 games × 10 ops × 100 cycles)", () => {
  it(`${CYCLES} cycles, ${OPS_PER_CYCLE} ops/game/cycle, full per-event parameter verification`, async () => {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      await runRouletteCycle(cycle);
      await runMinesCycle(cycle);
      await runJackpotCycle(cycle);
      await runCrashCycle(cycle);
    }

    // ── Final cross-cycle invariants ────────────────────────────────────────
    for (const { playerWallet } of players) {
      const p = playerWallet.account.address;
      // Per-game action nonces all advanced exactly CYCLES times
      expect(await roulette.read.actionNonces([p]), `roulette nonce for ${p}`).to.equal(BigInt(CYCLES));
      expect(await mines.read.actionNonces([p]),    `mines nonce for ${p}`).to.equal(BigInt(CYCLES));
      expect(await pj.read.actionNonces([p]),       `pj nonce for ${p}`).to.equal(BigInt(CYCLES));
      expect(await crash.read.actionNonces([p]),    `crash nonce for ${p}`).to.equal(BigInt(CYCLES));

      // AuthHub spend matches what we predicted
      const expectedTotal = expectedSpend(p);
      const remaining = await authHub.read.remainingSpend([p]) as bigint;
      expect(SPEND_CAP - remaining, `total spend for ${p}`).to.equal(expectedTotal);
    }
  });
});
