import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { encodeFunctionData, encodePacked, keccak256, toHex, pad, parseEther } from "viem";
import { privateKeyToAddress } from "viem/accounts";

import { ZERO_ADDRESS, ONE_EVA, TEN_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA, MAX_BPS } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

/**
 * HorseRaceBook tests — the "bet on a horse" mode.
 *
 * Every lane is a house horse; players pick a lane and a free amount. A bet
 * pays netStake × laneCount × split[place] (2.4× / 1.2× / 0.4× of the net with
 * 4 lanes and 60/30/10), minus the Revelación skim.
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let deployer: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;

let playerA: `0x${string}`;
let playerB: `0x${string}`;
let playerC: `0x${string}`;
let playerD: `0x${string}`;

const PLAYER_WALLET = { A: 1, B: 6, C: 8, D: 10 } as const;
const SESSION_WALLET = { A: 2, B: 7, C: 9, D: 11 } as const;

const HOUSE_BPS = 150;
const REFERRAL_BPS = 150;
const JACKPOT_BPS = 0;
const NET_BPS = 10_000n - BigInt(HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS); // 9700
const net = (gross: bigint) => (gross * NET_BPS) / MAX_BPS;

const ENGINE_HASH = keccak256(toHex("engine-config-v4"));
const SERVER_SEED = keccak256(toHex("book-server-seed"));
const COMMIT = keccak256(SERVER_SEED);
const CARROT_HASH = keccak256(toHex("house-carrots"));
const LANES = 4;
const SENTINEL = 255;
const ST = { None: 0, Open: 1, Locked: 2, Settled: 3, Refunded: 4, Cancelled: 5 } as const;

/** mult[place] × (1 − revBps) over the net stake, mirroring the contract's integer maths. */
function payout(netStake: bigint, place: number, split = [6000n, 3000n, 1000n], revBps = 300n, lanes = 4n): bigint {
  if (place >= split.length) return 0n;
  return (netStake * lanes * split[place] * (MAX_BPS - revBps)) / (MAX_BPS * MAX_BPS);
}

let roomCounter = 1000;
function freshRoom(): `0x${string}` {
  roomCounter++;
  return pad(toHex(roomCounter), { size: 32 });
}

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();
  deployer = walletClients[0].account.address;
  operator = walletClients[3].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;
  playerA = walletClients[PLAYER_WALLET.A].account.address;
  playerB = walletClients[PLAYER_WALLET.B].account.address;
  playerC = walletClients[PLAYER_WALLET.C].account.address;
  playerD = walletClients[PLAYER_WALLET.D].account.address;
});

async function nowOnChain(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}

interface Ctx {
  token: any;
  handler: any;
  provider: any;
  coordinator: any;
  authHub: any;
  game: any;
}

async function setup(opts: { bankroll?: bigint; revelacion?: [number, number] } = {}): Promise<Ctx> {
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

  const game = await env.viem.deployContract("HorseRaceBook", [
    token.address, handler.address, provider.address, authHub.address, operator, ENGINE_HASH,
  ]);
  await provider.write.setConsumerStatus([game.address, true, 1n]);
  await handler.write.registerGame([game.address, game.address, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([game.address, true]);
  if (opts.revelacion) await game.write.setRevelacion(opts.revelacion);

  for (const idx of Object.values(PLAYER_WALLET)) {
    const addr = walletClients[idx].account.address;
    await token.write.transfer([addr, HUNDRED_EVA]);
    const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, { client: { wallet: walletClients[idx] } });
    await playerToken.write.approve([game.address, ONE_THOUSAND_EVA]);
  }
  const bankroll = opts.bankroll ?? HUNDRED_EVA;
  if (bankroll > 0n) await token.write.transfer([game.address, bankroll]);
  return { token, handler, provider, coordinator, authHub, game };
}

function gameAs(ctx: Ctx, walletIdx: number) {
  return env.viem.getContractAt("HorseRaceBook", ctx.game.address, { client: { wallet: walletClients[walletIdx] } });
}

async function authorizeSession(ctx: Ctx, key: keyof typeof PLAYER_WALLET, spendCap = 0n) {
  const hub = await env.viem.getContractAt("AuthHub", ctx.authHub.address, { client: { wallet: walletClients[PLAYER_WALLET[key]] } });
  await hub.write.authorize([walletClients[SESSION_WALLET[key]].account.address, 0n, spendCap]);
}

async function signBet(
  ctx: Ctx,
  key: keyof typeof PLAYER_WALLET,
  msg: { roomId: `0x${string}`; lane: number; amount: bigint; referrer?: `0x${string}`; nonce?: bigint; deadline?: bigint; signerIdx?: number },
) {
  const player = walletClients[PLAYER_WALLET[key]].account.address;
  const nonce = msg.nonce ?? ((await ctx.game.read.actionNonces([player])) as bigint);
  const deadline = msg.deadline ?? (await nowOnChain()) + 3600n;
  const signer = walletClients[msg.signerIdx ?? SESSION_WALLET[key]];
  const signature = await signer.signTypedData({
    domain: { name: "HorseRaceBook", version: "1", chainId, verifyingContract: ctx.game.address },
    types: {
      LaneBet: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "roomId", type: "bytes32" },
        { name: "lane", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "LaneBet",
    message: {
      game: ctx.game.address, player, roomId: msg.roomId, lane: msg.lane, amount: msg.amount,
      potentialReferrer: msg.referrer ?? ZERO_ADDRESS, nonce, deadline,
    },
  });
  return { player, lane: msg.lane, amount: msg.amount, nonce, deadline, signature };
}

type BetSpec = { key: keyof typeof PLAYER_WALLET; lane: number; amount: bigint };

/** createRace + direct bets + (optionally) lockRace, as the operator. */
async function openRace(ctx: Ctx, bets: BetSpec[], opts: { lock?: boolean } = {}) {
  const roomId = freshRoom();
  const opGame = await gameAs(ctx, 3);
  await opGame.write.createRace([roomId, COMMIT]);
  const raceId = (await ctx.game.read.getRaceIdByRoom([roomId])) as bigint;
  for (const b of bets) {
    const pGame = await gameAs(ctx, PLAYER_WALLET[b.key]);
    await pGame.write.placeBet([roomId, b.lane, b.amount, ZERO_ADDRESS]);
  }
  if (opts.lock !== false) await opGame.write.lockRace([roomId]);
  return { raceId, roomId, opGame };
}

async function fulfillVRF(ctx: Ctx, raceId: bigint, word = 0xdeadbeefn) {
  const race = (await ctx.game.read.getRace([raceId])) as any;
  await ctx.coordinator.write.fulfill([ctx.provider.address, race.vrfRequestId, [word]]);
}

async function impersonatedProviderGame(ctx: Ctx) {
  await env.networkHelpers.impersonateAccount(ctx.provider.address);
  await env.networkHelpers.setBalance(ctx.provider.address, 10n ** 18n);
  const providerWallet = await env.viem.getWalletClient(ctx.provider.address);
  return env.viem.getContractAt("HorseRaceBook", ctx.game.address, { client: { wallet: providerWallet } });
}

/** The Revelación roll the contract makes, to pick VRF words that hit or miss. */
function roll(word: bigint, raceId: bigint): bigint {
  return BigInt(keccak256(encodePacked(["uint256", "bytes32", "uint256"], [word, SERVER_SEED, raceId])));
}

// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceBook — construction", () => {
  it("ships with 60/30/10, Revelación 3 % 1-in-20, limits 0.1–2 EVA × 48 bets, 4 lanes", async () => {
    const ctx = await setup();
    expect(await ctx.game.read.getPayoutSplitBps()).to.deep.equal([6000, 3000, 1000]);
    const [pool, bps, odds] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect([pool, bps, odds]).to.deep.equal([0n, 300, 20]);
    const [min, max, cap] = (await ctx.game.read.getBetLimits()) as [bigint, bigint, number];
    expect([min, max, cap]).to.deep.equal([parseEther("0.1"), parseEther("2"), 48]);
    expect(await ctx.game.read.lanes()).to.equal(4);
    expect(await ctx.game.read.currentEngineConfigHash()).to.equal(ENGINE_HASH);
    expect(await ctx.game.read.gameOperators([operator])).to.equal(true);
  });

  it("rejects a zero engine config hash", async () => {
    const ctx = await setup();
    await expectRevert(
      env.viem.deployContract("HorseRaceBook", [ctx.token.address, ctx.handler.address, ctx.provider.address, ctx.authHub.address, operator, pad("0x0", { size: 32 })]),
      "ConfigOutOfBounds",
    );
  });
});

describe("HorseRaceBook — createRace", () => {
  it("opens a race with the lane count snapshotted and the commit stored", async () => {
    const ctx = await setup();
    const { raceId, roomId } = await openRace(ctx, [], { lock: false });
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Open);
    expect(race.laneCount).to.equal(LANES);
    expect(race.winnerLane).to.equal(SENTINEL);
    expect(race.commitHash).to.equal(COMMIT);
    expect(race.roomId).to.equal(roomId);
    const ev = await ctx.game.getEvents.RaceCreated();
    expect(ev[0].args.raceId).to.equal(raceId);
    // a later setLanes does not touch it
    await ctx.game.write.setLanes([6]);
    expect(((await ctx.game.read.getRace([raceId])) as any).laneCount).to.equal(LANES);
    const next = await openRace(ctx, [], { lock: false });
    expect(((await ctx.game.read.getRace([next.raceId])) as any).laneCount).to.equal(6);
  });

  it("rejects a zero commit, a reused room, a non-operator and a paused game", async () => {
    const ctx = await setup();
    const opGame = await gameAs(ctx, 3);
    const roomId = freshRoom();
    await expectRevert(opGame.write.createRace([roomId, pad("0x0", { size: 32 })]), "InvalidCommitHash");
    await opGame.write.createRace([roomId, COMMIT]);
    await expectRevert(opGame.write.createRace([roomId, COMMIT]), "RoomAlreadyUsed");
    const stranger = await gameAs(ctx, 12);
    await expectRevert(stranger.write.createRace([freshRoom(), COMMIT]), "NotGameOperator");
    await ctx.game.write.pause();
    await expectRevert(opGame.write.createRace([freshRoom(), COMMIT]), "Pausable: paused");
  });
});

describe("HorseRaceBook — placeBet (direct)", () => {
  it("takes the stake through the handler, records the bet on its lane and emits both events", async () => {
    const ctx = await setup();
    const before = await ctx.token.read.balanceOf([playerA]);
    const { raceId, roomId } = await openRace(ctx, [{ key: "A", lane: 2, amount: ONE_EVA }], { lock: false });
    expect(before - (await ctx.token.read.balanceOf([playerA]))).to.equal(ONE_EVA);

    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.betCount).to.equal(1);
    expect(race.totalNetCollected).to.equal(net(ONE_EVA));
    expect(race.totalGrossCollected).to.equal(ONE_EVA);
    const bets = (await ctx.game.read.getBets([raceId])) as any[];
    expect(bets.length).to.equal(1);
    expect(bets[0].player.toLowerCase()).to.equal(playerA.toLowerCase());
    expect(bets[0].lane).to.equal(2);
    expect(bets[0].betId).to.equal(1n);
    expect(bets[0].grossStake).to.equal(ONE_EVA);
    expect(bets[0].netStake).to.equal(net(ONE_EVA));
    expect(await ctx.game.read.getLaneTotals([raceId])).to.deep.equal([0n, 0n, net(ONE_EVA), 0n]);
    expect(await ctx.game.read.hasBet([raceId, playerA])).to.equal(true);

    const placed = await ctx.game.getEvents.LaneBetPlaced();
    expect(placed[0].args.lane).to.equal(2);
    expect(placed[0].args.netStake).to.equal(net(ONE_EVA));
    const envelope = await ctx.game.getEvents.BetPlaced();
    expect(envelope[0].args.requestId).to.equal(1n);
    expect(envelope[0].args.amount).to.equal(ONE_EVA);
    void roomId;
  });

  it("enforces the bet limits, the lane range, one bet per player, the cap, bans and the race state", async () => {
    const ctx = await setup();
    const { roomId } = await openRace(ctx, [], { lock: false });
    const a = await gameAs(ctx, PLAYER_WALLET.A);
    await expectRevert(a.write.placeBet([roomId, 0, parseEther("0.05"), ZERO_ADDRESS]), "BetOutOfRange");
    await expectRevert(a.write.placeBet([roomId, 0, parseEther("2.5"), ZERO_ADDRESS]), "BetOutOfRange");
    await expectRevert(a.write.placeBet([roomId, 4, ONE_EVA, ZERO_ADDRESS]), "InvalidLane");
    await expectRevert(a.write.placeBet([freshRoom(), 0, ONE_EVA, ZERO_ADDRESS]), "RaceNotFound");
    await a.write.placeBet([roomId, 0, ONE_EVA, ZERO_ADDRESS]);
    await expectRevert(a.write.placeBet([roomId, 1, ONE_EVA, ZERO_ADDRESS]), "AlreadyBet");

    await ctx.game.write.setPlayerBanned([playerB, true]);
    const b = await gameAs(ctx, PLAYER_WALLET.B);
    await expectRevert(b.write.placeBet([roomId, 0, ONE_EVA, ZERO_ADDRESS]), "PlayerIsBanned");
    await ctx.game.write.setPlayerBanned([playerB, false]);

    await ctx.game.write.setBetLimits([parseEther("0.1"), parseEther("2"), 1]); // cap already reached
    await expectRevert(b.write.placeBet([roomId, 0, ONE_EVA, ZERO_ADDRESS]), "RaceFull");
    await ctx.game.write.setBetLimits([parseEther("0.1"), parseEther("2"), 48]);

    const opGame = await gameAs(ctx, 3);
    await opGame.write.lockRace([roomId]);
    await expectRevert(b.write.placeBet([roomId, 0, ONE_EVA, ZERO_ADDRESS]), "InvalidRaceState");

    const open = await openRace(ctx, [], { lock: false });
    await ctx.game.write.pause();
    await expectRevert(b.write.placeBet([open.roomId, 0, ONE_EVA, ZERO_ADDRESS]), "Pausable: paused");
  });
});

describe("HorseRaceBook — placeBetFor (relayed)", () => {
  it("relays a session-key signed bet, consumes the nonce and charges the spend cap", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A", TEN_EVA);
    const { raceId, roomId } = await openRace(ctx, [], { lock: false });
    const s = await signBet(ctx, "A", { roomId, lane: 1, amount: ONE_EVA });
    const opGame = await gameAs(ctx, 3);
    await opGame.write.placeBetFor([s.player, roomId, s.lane, s.amount, ZERO_ADDRESS, s.nonce, s.deadline, s.signature]);
    expect(await ctx.game.read.actionNonces([playerA])).to.equal(1n);
    expect(await ctx.game.read.getLaneTotals([raceId])).to.deep.equal([0n, net(ONE_EVA), 0n, 0n]);
    const placed = await ctx.game.getEvents.LaneBetPlaced();
    expect(placed[0].args.player.toLowerCase()).to.equal(playerA.toLowerCase()); // the player, not the relayer
    // spend cap: a second race's bet over the remaining cap is refused
    const other = await openRace(ctx, [], { lock: false });
    const big = await signBet(ctx, "A", { roomId: other.roomId, lane: 0, amount: parseEther("2") });
    await ctx.game.write.setBetLimits([parseEther("0.1"), parseEther("20"), 48]);
    const tooBig = await signBet(ctx, "A", { roomId: other.roomId, lane: 0, amount: parseEther("10") });
    await expectRevert(
      opGame.write.placeBetFor([tooBig.player, other.roomId, 0, tooBig.amount, ZERO_ADDRESS, tooBig.nonce, tooBig.deadline, tooBig.signature]),
      "SpendCapExceeded",
    );
    void big;
  });

  it("rejects a non-operator relayer, a wrong signer, a stale nonce and an expired deadline", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A");
    const { roomId } = await openRace(ctx, [], { lock: false });
    const opGame = await gameAs(ctx, 3);
    const stranger = await gameAs(ctx, 12);
    const ok = await signBet(ctx, "A", { roomId, lane: 0, amount: ONE_EVA });
    await expectRevert(stranger.write.placeBetFor([ok.player, roomId, 0, ok.amount, ZERO_ADDRESS, ok.nonce, ok.deadline, ok.signature]), "0x7c214f04"); // selector de NotOperator()
    const badSigner = await signBet(ctx, "A", { roomId, lane: 0, amount: ONE_EVA, signerIdx: SESSION_WALLET.B });
    await expectRevert(opGame.write.placeBetFor([badSigner.player, roomId, 0, ONE_EVA, ZERO_ADDRESS, badSigner.nonce, badSigner.deadline, badSigner.signature]), "InvalidSignature");
    const stale = await signBet(ctx, "A", { roomId, lane: 0, amount: ONE_EVA, nonce: 5n });
    await expectRevert(opGame.write.placeBetFor([stale.player, roomId, 0, ONE_EVA, ZERO_ADDRESS, stale.nonce, stale.deadline, stale.signature]), "InvalidNonce");
    const expired = await signBet(ctx, "A", { roomId, lane: 0, amount: ONE_EVA, deadline: 1n });
    await expectRevert(opGame.write.placeBetFor([expired.player, roomId, 0, ONE_EVA, ZERO_ADDRESS, expired.nonce, expired.deadline, expired.signature]), "ExpiredDeadline");
    // tampering with the lane after signing breaks the signature
    await expectRevert(opGame.write.placeBetFor([ok.player, roomId, 1, ok.amount, ZERO_ADDRESS, ok.nonce, ok.deadline, ok.signature]), "InvalidSignature");
    // no session key
    const noKey = await signBet(ctx, "B", { roomId, lane: 0, amount: ONE_EVA });
    await expectRevert(opGame.write.placeBetFor([noKey.player, roomId, 0, ONE_EVA, ZERO_ADDRESS, noKey.nonce, noKey.deadline, noKey.signature]), "NoSessionKey");
  });
});

describe("HorseRaceBook — lockRace", () => {
  it("with zero bets the race is Cancelled, not locked (no revert, batch-friendly)", async () => {
    const ctx = await setup();
    const { raceId } = await openRace(ctx, []);
    expect(((await ctx.game.read.getRace([raceId])) as any).state).to.equal(ST.Cancelled);
    expect((await ctx.game.getEvents.RaceCancelled()).length).to.equal(1);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
  });

  it("locks the worst-case payout premium (largest lane total on the largest multiplier) and requests VRF", async () => {
    const ctx = await setup();
    // A 1 EVA on lane 0, B 2 EVA on lane 1 → totals 0.97 / 1.94 → worst = 1.94×2.4 + 0.97×1.2 = 5.82
    const { raceId } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }, { key: "B", lane: 1, amount: 2n * ONE_EVA }]);
    const totalNet = net(ONE_EVA) + net(2n * ONE_EVA);
    const worst = (net(2n * ONE_EVA) * 4n * 6000n) / MAX_BPS + (net(ONE_EVA) * 4n * 3000n) / MAX_BPS;
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Locked);
    expect(race.exposureLocked).to.equal(worst - totalNet);
    expect(await ctx.game.read.lockedExposure()).to.equal(worst - totalNet);
    expect(race.engineConfigHash).to.equal(ENGINE_HASH);
    expect(race.settleBy).to.equal(race.lockedAt + 900n);
    expect(race.vrfRequestId).to.not.equal(0n);
    expect(await ctx.game.read.vrfRequestToRace([race.vrfRequestId])).to.equal(raceId);
    const locked = await ctx.game.getEvents.RaceLocked();
    expect(locked[0].args.betCount).to.equal(2);
    expect(locked[0].args.totalNet).to.equal(totalNet);
    expect(locked[0].args.exposure).to.equal(worst - totalNet);
  });

  it("when the refund premium exceeds the payout premium it is the one locked", async () => {
    const ctx = await setup();
    await ctx.game.write.setPayoutSplitBps([[1000]]); // winner pays 0.4× the net: never more than collected
    const { raceId } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.exposureLocked).to.equal(ONE_EVA - net(ONE_EVA)); // gross refund − net held
  });

  it("reverts with LiquidityShortfall when the bankroll cannot cover the exposure", async () => {
    const ctx = await setup({ bankroll: 0n });
    const { roomId } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }], { lock: false });
    const opGame = await gameAs(ctx, 3);
    await expectRevert(opGame.write.lockRace([roomId]), "LiquidityShortfall");
  });

  it("rejects an unknown room, a non-Open race and a non-operator", async () => {
    const ctx = await setup();
    const opGame = await gameAs(ctx, 3);
    await expectRevert(opGame.write.lockRace([freshRoom()]), "RaceNotFound");
    const { roomId } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    await expectRevert(opGame.write.lockRace([roomId]), "InvalidRaceState");
    const stranger = await gameAs(ctx, 12);
    await expectRevert(stranger.write.lockRace([roomId]), "NotGameOperator");
  });
});

describe("HorseRaceBook — VRF callbacks", () => {
  it("stores the word for a Locked race; ignores unknown requests and late fulfillments", async () => {
    const ctx = await setup();
    const { raceId } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    await fulfillVRF(ctx, raceId, 77n);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.vrfFulfilled).to.equal(true);
    expect(race.vrfRandomWord).to.equal(77n);
    expect((await ctx.game.getEvents.RaceRandomnessFulfilled())[0].args.randomWord).to.equal(77n);

    const asProvider = await impersonatedProviderGame(ctx);
    await asProvider.write.fulfillRandomness([999_999n, 1n, []]); // unknown → no-op
    const refunded = await openRace(ctx, [{ key: "B", lane: 1, amount: ONE_EVA }]);
    const r = (await ctx.game.read.getRace([refunded.raceId])) as any;
    await asProvider.write.handleRandomFailure([r.vrfRequestId, toHex("VRF_FAILED", { size: 32 }), "0x"]);
    await asProvider.write.fulfillRandomness([r.vrfRequestId, 5n, []]); // late → ignored
    expect(((await ctx.game.read.getRace([refunded.raceId])) as any).vrfFulfilled).to.equal(false);
    await asProvider.write.handleRandomFailure([r.vrfRequestId, toHex("VRF_FAILED", { size: 32 }), "0x"]); // twice → no-op
    await asProvider.write.handleRandomFailure([999_999n, toHex("X", { size: 32 }), "0x"]); // unknown → no-op
  });

  it("handleRandomFailure refunds every bet in full (gross) and unlocks the exposure", async () => {
    const ctx = await setup();
    const balA = await ctx.token.read.balanceOf([playerA]);
    const balB = await ctx.token.read.balanceOf([playerB]);
    const { raceId } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }, { key: "B", lane: 0, amount: 2n * ONE_EVA }]);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    const asProvider = await impersonatedProviderGame(ctx);
    await asProvider.write.handleRandomFailure([race.vrfRequestId, toHex("VRF_FAILED", { size: 32 }), "0x"]);
    expect(((await ctx.game.read.getRace([raceId])) as any).state).to.equal(ST.Refunded);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    expect(await ctx.token.read.balanceOf([playerA])).to.equal(balA);
    expect(await ctx.token.read.balanceOf([playerB])).to.equal(balB);
    const failed = await ctx.game.getEvents.BetFailed();
    expect(failed.length).to.equal(2);
    expect((await ctx.game.getEvents.RaceRefunded()).length).to.equal(1);
  });

  it("only the RandomProvider may call the callbacks", async () => {
    const ctx = await setup();
    const stranger = await gameAs(ctx, 12);
    await expectRevert(stranger.write.fulfillRandomness([1n, 1n, []]), "0x5c427cd9"); // selector de UnauthorizedCaller()
    await expectRevert(stranger.write.handleRandomFailure([1n, toHex("X", { size: 32 }), "0x"]), "0x5c427cd9"); // selector de UnauthorizedCaller()
  });
});

describe("HorseRaceBook — settleRace", () => {
  it("pays 2.4× / 1.2× / 0.4× of the net (minus the 3 % skim) by finishing place, 4th pays 0, and feeds the pool", async () => {
    const ctx = await setup();
    const bets: BetSpec[] = [
      { key: "A", lane: 0, amount: ONE_EVA },
      { key: "B", lane: 1, amount: 2n * ONE_EVA },
      { key: "C", lane: 2, amount: parseEther("0.5") },
      { key: "D", lane: 3, amount: ONE_EVA },
    ];
    const before = await Promise.all([playerA, playerB, playerC, playerD].map((p) => ctx.token.read.balanceOf([p])));
    const { raceId, opGame } = await openRace(ctx, bets);
    await fulfillVRF(ctx, raceId);
    const ranking = [1, 0, 2, 3]; // B wins, A 2nd, C 3rd, D last
    await opGame.write.settleRace([raceId, SERVER_SEED, ranking, CARROT_HASH]);

    const after = await Promise.all([playerA, playerB, playerC, playerD].map((p) => ctx.token.read.balanceOf([p])));
    const exp = [
      payout(net(ONE_EVA), 1),
      payout(net(2n * ONE_EVA), 0),
      payout(net(parseEther("0.5")), 2),
      0n,
    ];
    bets.forEach((b, i) => expect(after[i] - before[i]).to.equal(exp[i] - b.amount));

    const totalNet = bets.reduce((s, b) => s + net(b.amount), 0n);
    const contrib = (totalNet * 300n) / MAX_BPS;
    const [pool] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect(pool).to.equal(contrib);
    expect(await ctx.game.read.lockedExposure()).to.equal(contrib); // the pool is reserved
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Settled);
    expect(race.winnerLane).to.equal(1);
    expect(race.serverSeed).to.equal(SERVER_SEED);
    expect(race.carrotDataHash).to.equal(CARROT_HASH);

    const settled = await ctx.game.getEvents.BetSettled();
    expect(settled.map((e: any) => e.args.payout)).to.deep.equal(exp);
    const podium = await ctx.game.getEvents.RacePodium();
    expect(podium[0].args.ranking).to.deep.equal(ranking);
    expect(podium[0].args.laneTotals).to.deep.equal(bets.map((b) => net(b.amount)));
    const rs = await ctx.game.getEvents.RaceSettled();
    expect(rs[0].args.totalNet).to.equal(totalNet);
    expect(rs[0].args.totalPaid).to.equal(exp.reduce((s, p) => s + p, 0n));
    expect((await ctx.game.getEvents.RevelacionContributed())[0].args.amount).to.equal(contrib);
    expect((await ctx.game.getEvents.RevelacionWon()).length).to.equal(0); // 1-in-20 by default; see the draw tests
  });

  it("a race nobody bet on the winner: the lane totals stay with the house and nothing is paid", async () => {
    const ctx = await setup();
    const { raceId, opGame } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    await fulfillVRF(ctx, raceId);
    const gameBefore = await ctx.token.read.balanceOf([ctx.game.address]);
    await opGame.write.settleRace([raceId, SERVER_SEED, [3, 2, 1, 0], CARROT_HASH]); // lane 0 last
    expect(await ctx.token.read.balanceOf([ctx.game.address])).to.equal(gameBefore);
    expect((await ctx.game.getEvents.RaceSettled())[0].args.totalPaid).to.equal(0n);
  });

  it("with no Revelación (bps 0) the multipliers pay in full and nothing is skimmed", async () => {
    const ctx = await setup({ revelacion: [0, 0] });
    const before = await ctx.token.read.balanceOf([playerA]);
    const { raceId, opGame } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    await fulfillVRF(ctx, raceId);
    await opGame.write.settleRace([raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]);
    expect((await ctx.token.read.balanceOf([playerA])) - before).to.equal(payout(net(ONE_EVA), 0, undefined, 0n) - ONE_EVA);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    expect((await ctx.game.getEvents.RevelacionContributed()).length).to.equal(0);
  });

  it("a winner-takes-all split pays 4× the net to the winning lane only", async () => {
    const ctx = await setup({ revelacion: [0, 0] });
    await ctx.game.write.setPayoutSplitBps([[10_000]]);
    const before = await ctx.token.read.balanceOf([playerA]);
    const { raceId, opGame } = await openRace(ctx, [{ key: "A", lane: 2, amount: ONE_EVA }, { key: "B", lane: 1, amount: ONE_EVA }]);
    await fulfillVRF(ctx, raceId);
    await opGame.write.settleRace([raceId, SERVER_SEED, [2, 1, 0, 3], CARROT_HASH]);
    expect((await ctx.token.read.balanceOf([playerA])) - before).to.equal(4n * net(ONE_EVA) - ONE_EVA);
    const settled = await ctx.game.getEvents.BetSettled();
    expect(settled[1].args.payout).to.equal(0n); // B second: no place paid
  });

  it("rejects a non-Locked race, an unfulfilled VRF, a wrong seed, a bad ranking and a non-operator", async () => {
    const ctx = await setup();
    const open = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }], { lock: false });
    const opGame = open.opGame;
    await expectRevert(opGame.write.settleRace([open.raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]), "InvalidRaceState");
    const { raceId } = await openRace(ctx, [{ key: "B", lane: 0, amount: ONE_EVA }]);
    await expectRevert(opGame.write.settleRace([raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]), "VRFNotFulfilled");
    await fulfillVRF(ctx, raceId);
    await expectRevert(opGame.write.settleRace([raceId, keccak256(toHex("wrong")), [0, 1, 2, 3], CARROT_HASH]), "InvalidServerSeed");
    await expectRevert(opGame.write.settleRace([raceId, SERVER_SEED, [0, 1, 2], CARROT_HASH]), "InvalidRanking");
    await expectRevert(opGame.write.settleRace([raceId, SERVER_SEED, [0, 1, 2, 2], CARROT_HASH]), "InvalidRanking");
    await expectRevert(opGame.write.settleRace([raceId, SERVER_SEED, [0, 1, 2, 9], CARROT_HASH]), "InvalidLane");
    const stranger = await gameAs(ctx, 12);
    await expectRevert(stranger.write.settleRace([raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]), "3bc1fd98");
    await opGame.write.settleRace([raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]);
    await expectRevert(opGame.write.settleRace([raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]), "InvalidRaceState");
  });
});

describe("HorseRaceBook — Revelación draw", () => {
  it("odds 1: the pool is split pro-rata over the winning lane's bets, the last one takes the dust", async () => {
    const ctx = await setup({ revelacion: [300, 1] });
    // seed the pool with a race nobody wins
    const seed = await openRace(ctx, [{ key: "D", lane: 3, amount: ONE_EVA }]);
    await fulfillVRF(ctx, seed.raceId);
    await seed.opGame.write.settleRace([seed.raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]);
    const [poolBefore] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect(poolBefore).to.equal((net(ONE_EVA) * 300n) / MAX_BPS);

    const bets: BetSpec[] = [
      { key: "A", lane: 0, amount: ONE_EVA },
      { key: "B", lane: 0, amount: 2n * ONE_EVA },
      { key: "C", lane: 1, amount: ONE_EVA },
    ];
    const before = await Promise.all([playerA, playerB, playerC].map((p) => ctx.token.read.balanceOf([p])));
    const { raceId, opGame } = await openRace(ctx, bets);
    await fulfillVRF(ctx, raceId);
    await opGame.write.settleRace([raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]);

    const totalNet = bets.reduce((s, b) => s + net(b.amount), 0n);
    const pool = poolBefore + (totalNet * 300n) / MAX_BPS;
    const winnerNet = net(ONE_EVA) + net(2n * ONE_EVA);
    const shareA = (pool * net(ONE_EVA)) / winnerNet;
    const shareB = pool - shareA; // dust goes to the last winning bet
    const after = await Promise.all([playerA, playerB, playerC].map((p) => ctx.token.read.balanceOf([p])));
    expect(after[0] - before[0]).to.equal(payout(net(ONE_EVA), 0) + shareA - ONE_EVA);
    expect(after[1] - before[1]).to.equal(payout(net(2n * ONE_EVA), 0) + shareB - 2n * ONE_EVA);
    expect(after[2] - before[2]).to.equal(payout(net(ONE_EVA), 1) - ONE_EVA);

    const [poolAfter] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect(poolAfter).to.equal(0n);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    const won = await ctx.game.getEvents.RevelacionWon();
    expect(won.length).to.equal(1);
    expect(won[0].args.winnerLane).to.equal(0);
    expect(won[0].args.amount).to.equal(pool);
    const shares = await ctx.game.getEvents.RevelacionShare();
    expect(shares.map((s: any) => s.args.amount)).to.deep.equal([shareA, shareB]);
    // the envelope payout includes the share
    const settled = await ctx.game.getEvents.BetSettled();
    expect(settled[0].args.payout).to.equal(payout(net(ONE_EVA), 0) + shareA);
  });

  it("the roll comes from keccak(vrfWord, serverSeed, raceId): a losing word keeps the pool, a winning word pays it", async () => {
    const ctx = await setup({ revelacion: [300, 2] });
    const first = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    let word = 1n;
    while (roll(word, first.raceId) % 2n === 0n) word++;
    await fulfillVRF(ctx, first.raceId, word);
    await first.opGame.write.settleRace([first.raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]);
    const [pool1] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect(pool1 > 0n).to.equal(true);
    expect((await ctx.game.getEvents.RevelacionWon()).length).to.equal(0);

    const second = await openRace(ctx, [{ key: "B", lane: 2, amount: ONE_EVA }]);
    word = 1n;
    while (roll(word, second.raceId) % 2n !== 0n) word++;
    await fulfillVRF(ctx, second.raceId, word);
    await second.opGame.write.settleRace([second.raceId, SERVER_SEED, [2, 0, 1, 3], CARROT_HASH]);
    const [pool2] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect(pool2).to.equal(0n);
    expect((await ctx.game.getEvents.RevelacionWon()).length).to.equal(1);
  });

  it("odds 0 never pays; a winning lane without bets leaves the pool for the next race", async () => {
    const ctx = await setup({ revelacion: [300, 0] });
    const a = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    await fulfillVRF(ctx, a.raceId);
    await a.opGame.write.settleRace([a.raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]);
    expect((await ctx.game.getEvents.RevelacionWon()).length).to.equal(0);
    await ctx.game.write.setRevelacion([300, 1]);
    const b = await openRace(ctx, [{ key: "B", lane: 1, amount: ONE_EVA }]);
    await fulfillVRF(ctx, b.raceId);
    await b.opGame.write.settleRace([b.raceId, SERVER_SEED, [0, 1, 2, 3], CARROT_HASH]); // lane 0 wins, nobody there
    expect((await ctx.game.getEvents.RevelacionWon()).length).to.equal(0);
    const [pool] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect(pool).to.equal((2n * net(ONE_EVA) * 300n) / MAX_BPS);
    expect(await ctx.game.read.lockedExposure()).to.equal(pool);
  });

  it("the pool is reserved: a lock that needs it reverts with LiquidityShortfall", async () => {
    const ctx = await setup({ bankroll: parseEther("1.5"), revelacion: [2000, 0] });
    // one bet of 1 EVA on a lane: exposure 2.328−0.97 = 1.358 ≤ 1.5+0.97 bankroll+net ✓
    const a = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    await fulfillVRF(ctx, a.raceId);
    await a.opGame.write.settleRace([a.raceId, SERVER_SEED, [3, 2, 1, 0], CARROT_HASH]); // house keeps 0.97, pool +0.194
    // balance now 1.5 + 0.97 = 2.47, pool 0.194 locked. A 2 EVA bet needs 2.328×2−1.94 = 2.716 > 2.47+1.94−0.194? no → fits.
    // Make it tight: three 2 EVA bets on one lane → exposure 5.82×... just assert the pool counts.
    await ctx.game.write.setBetLimits([parseEther("0.1"), parseEther("20"), 48]);
    const need = await openRace(ctx, [{ key: "B", lane: 0, amount: parseEther("4") }], { lock: false });
    // worst 4×0.97×2.4 = 9.312, net 3.88 → premium 5.432; balance 2.47+3.88 = 6.35; locked pool 0.194 → 6.35 < 5.432+0.194? no (6.35 ≥ 5.626) → fits
    await need.opGame.write.lockRace([need.roomId]);
    const tight = await openRace(ctx, [{ key: "C", lane: 0, amount: parseEther("1") }], { lock: false });
    // balance 6.35+0.97 = 7.32; locked 5.626; this needs 1.358 → 6.984 ≤ 7.32 fits; with 0.5 more it would not
    await tight.opGame.write.lockRace([tight.roomId]);
    const over = await openRace(ctx, [{ key: "D", lane: 0, amount: parseEther("1") }], { lock: false });
    await expectRevert(over.opGame.write.lockRace([over.roomId]), "LiquidityShortfall");
  });
});

describe("HorseRaceBook — cancelRace / emergencyRefundRace", () => {
  it("cancelRace refunds the gross stakes of an Open race and rejects other states", async () => {
    const ctx = await setup();
    const balA = await ctx.token.read.balanceOf([playerA]);
    const { raceId, opGame } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }], { lock: false });
    await opGame.write.cancelRace([raceId]);
    expect(((await ctx.game.read.getRace([raceId])) as any).state).to.equal(ST.Cancelled);
    expect(await ctx.token.read.balanceOf([playerA])).to.equal(balA);
    const failed = await ctx.game.getEvents.BetFailed();
    expect(failed[0].args.reason).to.equal(pad(toHex("CANCELLED"), { size: 32, dir: "right" }));
    await expectRevert(opGame.write.cancelRace([raceId]), "InvalidRaceState");
    const stranger = await gameAs(ctx, 12);
    await expectRevert(stranger.write.cancelRace([raceId]), "NotGameOperator");
  });

  it("emergencyRefundRace: anyone may refund after settleBy + grace; refundBps applies over the gross", async () => {
    const ctx = await setup();
    await ctx.game.write.setRefundBps([5000]);
    const balA = await ctx.token.read.balanceOf([playerA]);
    const { raceId } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }]);
    const stranger = await gameAs(ctx, 12);
    await expectRevert(stranger.write.emergencyRefundRace([raceId]), "SettleDeadlineNotPassed");
    await env.networkHelpers.time.increase(900 + 31);
    await stranger.write.emergencyRefundRace([raceId]);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Refunded);
    expect(await ctx.token.read.balanceOf([playerA])).to.equal(balA - ONE_EVA / 2n);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    await expectRevert(stranger.write.emergencyRefundRace([raceId]), "InvalidRaceState");
  });

  it("refundBps 0: refunds move no tokens but still emit BetFailed", async () => {
    const ctx = await setup();
    await ctx.game.write.setRefundBps([0]);
    const { raceId, opGame } = await openRace(ctx, [{ key: "A", lane: 0, amount: ONE_EVA }], { lock: false });
    const bal = await ctx.token.read.balanceOf([playerA]);
    await opGame.write.cancelRace([raceId]);
    expect(await ctx.token.read.balanceOf([playerA])).to.equal(bal);
    expect((await ctx.game.getEvents.BetFailed()).length).to.equal(1);
  });
});

describe("HorseRaceBook — multicallTry batch (QuickBet relay)", () => {
  const encodeCreate = (roomId: `0x${string}`) =>
    encodeFunctionData({
      abi: [{ type: "function", name: "createRace", stateMutability: "nonpayable", inputs: [{ name: "roomId", type: "bytes32" }, { name: "commitHash", type: "bytes32" }], outputs: [{ name: "raceId", type: "uint256" }] }],
      functionName: "createRace",
      args: [roomId, COMMIT],
    });
  const encodeBetFor = (roomId: `0x${string}`, s: Awaited<ReturnType<typeof signBet>>) =>
    encodeFunctionData({
      abi: [{
        type: "function", name: "placeBetFor", stateMutability: "nonpayable",
        inputs: [
          { name: "player", type: "address" }, { name: "roomId", type: "bytes32" }, { name: "lane", type: "uint8" }, { name: "amount", type: "uint256" },
          { name: "potentialReferrer", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" },
        ],
        outputs: [{ name: "betId", type: "uint256" }],
      }],
      functionName: "placeBetFor",
      args: [s.player, roomId, s.lane, s.amount, ZERO_ADDRESS, s.nonce, s.deadline, s.signature],
    });

  it("a bad sub-call (stale nonce) reverts in isolation; the other bet lands", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A");
    await authorizeSession(ctx, "B");
    const roomId = freshRoom();
    const opGame = await gameAs(ctx, 3);
    await opGame.write.createRace([roomId, COMMIT]);
    const a = await signBet(ctx, "A", { roomId, lane: 0, amount: ONE_EVA });
    const bBad = await signBet(ctx, "B", { roomId, lane: 1, amount: ONE_EVA, nonce: 9n });
    const tx = await opGame.write.multicallTry([[encodeBetFor(roomId, a), encodeBetFor(roomId, bBad)]], { gas: 4_000_000n });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    const raceId = (await ctx.game.read.getRaceIdByRoom([roomId])) as bigint;
    expect(((await ctx.game.read.getRace([raceId])) as any).betCount).to.equal(1);
    const subFails = await ctx.game.getEvents.MulticallSubCallFailed();
    expect(subFails.length).to.equal(1);
    expect(subFails[0].args.index).to.equal(1n);
    expect(await ctx.token.read.balanceOf([playerB])).to.equal(HUNDRED_EVA);
    void encodeCreate;
  });
});

describe("HorseRaceBook — admin", () => {
  it("setBetLimits / setSettleDeadlineSeconds / setRefundBps / setEngineConfigHash / setLanes enforce their bounds", async () => {
    const ctx = await setup();
    await ctx.game.write.setBetLimits([parseEther("0.2"), parseEther("5"), 10]);
    expect(await ctx.game.read.getBetLimits()).to.deep.equal([parseEther("0.2"), parseEther("5"), 10]);
    expect((await ctx.game.getEvents.BetLimitsUpdated())[0].args.maxBetsPerRace).to.equal(10);
    await expectRevert(ctx.game.write.setBetLimits([0n, parseEther("5"), 10]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setBetLimits([parseEther("6"), parseEther("5"), 10]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setBetLimits([parseEther("1"), parseEther("5"), 0]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setBetLimits([parseEther("1"), parseEther("5"), 101]), "ConfigOutOfBounds");

    await ctx.game.write.setSettleDeadlineSeconds([120]);
    expect(await ctx.game.read.settleDeadlineSeconds()).to.equal(120);
    await expectRevert(ctx.game.write.setSettleDeadlineSeconds([59]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setSettleDeadlineSeconds([86_401]), "ConfigOutOfBounds");

    await ctx.game.write.setRefundBps([9000]);
    expect(await ctx.game.read.refundBps()).to.equal(9000);
    await expectRevert(ctx.game.write.setRefundBps([10_001]), "ConfigOutOfBounds");

    const h = keccak256(toHex("v5"));
    await ctx.game.write.setEngineConfigHash([h]);
    expect(await ctx.game.read.currentEngineConfigHash()).to.equal(h);
    await expectRevert(ctx.game.write.setEngineConfigHash([pad("0x0", { size: 32 })]), "ConfigOutOfBounds");

    await ctx.game.write.setLanes([8]);
    expect(await ctx.game.read.lanes()).to.equal(8);
    await expectRevert(ctx.game.write.setLanes([1]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setLanes([9]), "ConfigOutOfBounds");

    await ctx.game.write.setPlayerBanned([playerA, true]);
    expect(await ctx.game.read.bannedPlayers([playerA])).to.equal(true);
  });

  it("setPayoutSplitBps / setRevelacion validate and emit; everything is onlyOwner", async () => {
    const ctx = await setup();
    await ctx.game.write.setPayoutSplitBps([[5000, 3000, 2000]]);
    expect(await ctx.game.read.getPayoutSplitBps()).to.deep.equal([5000, 3000, 2000]);
    await expectRevert(ctx.game.write.setPayoutSplitBps([[]]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setPayoutSplitBps([[1, 1, 1, 1, 1, 1, 1, 1, 1]]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setPayoutSplitBps([[0, 0]]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setPayoutSplitBps([[6000, 5000]]), "ConfigOutOfBounds");

    await ctx.game.write.setRevelacion([500, 50]);
    const [, bps, odds] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect([bps, odds]).to.deep.equal([500, 50]);
    await expectRevert(ctx.game.write.setRevelacion([2001, 50]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setRevelacion([500, 10_001]), "ConfigOutOfBounds");

    const stranger = await gameAs(ctx, 12);
    await expectRevert(stranger.write.setBetLimits([ONE_EVA, ONE_EVA, 1]), "Ownable: caller is not the owner");
    await expectRevert(stranger.write.setRevelacion([0, 0]), "Ownable: caller is not the owner");
    await expectRevert(stranger.write.setPayoutSplitBps([[10_000]]), "Ownable: caller is not the owner");
    await expectRevert(stranger.write.setLanes([4]), "Ownable: caller is not the owner");
  });

  it("quotePayout mirrors the settle maths and returns 0 past the paid places", async () => {
    const ctx = await setup();
    expect(await ctx.game.read.quotePayout([4, net(ONE_EVA), 0])).to.equal(payout(net(ONE_EVA), 0));
    expect(await ctx.game.read.quotePayout([4, net(ONE_EVA), 2])).to.equal(payout(net(ONE_EVA), 2));
    expect(await ctx.game.read.quotePayout([4, net(ONE_EVA), 3])).to.equal(0n);
    expect(await ctx.game.read.quotePayout([6, net(ONE_EVA), 0])).to.equal(payout(net(ONE_EVA), 0, undefined, 300n, 6n));
  });
});

describe("HorseRaceBook — a full book (48 bets)", () => {
  it("settles 48 bets in one tx within a sane gas budget and refuses the 49th", async () => {
    const ctx = await setup({ bankroll: ONE_THOUSAND_EVA, revelacion: [300, 1] });
    const opGame = await gameAs(ctx, 3);
    const roomId = freshRoom();
    await opGame.write.createRace([roomId, COMMIT]);
    const raceId = (await ctx.game.read.getRaceIdByRoom([roomId])) as bigint;
    const punters: `0x${string}`[] = [];
    for (let i = 0; i < 49; i++) {
      const addr = privateKeyToAddress(pad(toHex(0xb00c + i), { size: 32 }));
      punters.push(addr);
      await env.networkHelpers.impersonateAccount(addr);
      await env.networkHelpers.setBalance(addr, 10n ** 18n);
      await ctx.token.write.transfer([addr, TEN_EVA]);
      const w = await env.viem.getWalletClient(addr);
      const t = await env.viem.getContractAt("EverValueCoin", ctx.token.address, { client: { wallet: w } });
      await t.write.approve([ctx.game.address, TEN_EVA]);
      const g = await env.viem.getContractAt("HorseRaceBook", ctx.game.address, { client: { wallet: w } });
      const amount = parseEther(String(0.1 + (i % 5) * 0.3));
      if (i < 48) await g.write.placeBet([roomId, i % 4, amount, ZERO_ADDRESS]);
      else await expectRevert(g.write.placeBet([roomId, i % 4, amount, ZERO_ADDRESS]), "RaceFull");
    }
    await opGame.write.lockRace([roomId]);
    await fulfillVRF(ctx, raceId);
    const tx = await opGame.write.settleRace([raceId, SERVER_SEED, [2, 0, 3, 1], CARROT_HASH]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");
    expect(receipt.gasUsed < 4_000_000n, `gas ${receipt.gasUsed}`).to.equal(true);
    const settled = await ctx.game.getEvents.BetSettled();
    expect(settled.length).to.equal(48);
    const [pool] = (await ctx.game.read.getRevelacion()) as [bigint, number, number];
    expect(pool).to.equal(0n); // odds 1 → the 12 bets on lane 2 shared it
    expect((await ctx.game.getEvents.RevelacionShare()).length).to.equal(12);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
  });
});
