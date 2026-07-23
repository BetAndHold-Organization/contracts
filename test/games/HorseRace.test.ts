import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { encodeFunctionData, keccak256, toHex, pad } from "viem";

import { ZERO_ADDRESS, ONE_EVA, TEN_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA, MAX_BPS } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

/**
 * HorseRaceGame tests.
 *
 * Canonical operator flow under test: multicallTry([createRace, joinRaceFor×k,
 * lockRace]) — seats and money move atomically, a bad sub-call reverts in
 * isolation and the house covers that lane.
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let deployer: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;
let other: `0x${string}`;

// players and their session keys
let playerA: `0x${string}`;
let playerB: `0x${string}`;
let playerC: `0x${string}`;
let playerD: `0x${string}`;

const PLAYER_WALLET = { A: 1, B: 6, C: 8, D: 10 } as const;
const SESSION_WALLET = { A: 2, B: 7, C: 9, D: 11 } as const;

// Real platform target: 1.5% house + 1.5% referral + 0% jackpot = 3% total.
const HOUSE_BPS = 150;
const REFERRAL_BPS = 150;
const JACKPOT_BPS = 0;
const NET_BPS = 10_000n - BigInt(HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS); // 9700

const TIER = ONE_EVA;
const NET_PER_SEAT = (TIER * NET_BPS) / MAX_BPS; // 0.97 EVA

const ENGINE_HASH = keccak256(toHex("engine-config-v1"));
const SERVER_SEED = keccak256(toHex("server-seed"));
const COMMIT = keccak256(SERVER_SEED);
const CARROT_HASH = keccak256(toHex("carrot-events"));

const LANES = 4;
const HOUSE_SENTINEL = 255;

// RaceState enum
const ST = { None: 0, Open: 1, Locked: 2, Settled: 3, Refunded: 4, Cancelled: 5 } as const;

let roomCounter = 0;
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
  other = walletClients[12].account.address;
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

async function setup(opts: { bankroll?: bigint; initialOperator?: `0x${string}` } = {}): Promise<Ctx> {
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

  const game = await env.viem.deployContract("HorseRaceGame", [
    token.address,
    handler.address,
    provider.address,
    authHub.address,
    opts.initialOperator ?? operator,
    ENGINE_HASH,
  ]);

  await provider.write.setConsumerStatus([game.address, true, 1n]);
  await handler.write.registerGame([
    game.address,
    game.address,
    feeRecipient,
    HOUSE_BPS,
    REFERRAL_BPS,
    JACKPOT_BPS,
  ]);
  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([game.address, true]);

  await game.write.setBetTier([TIER, true]);

  // Fund players + approve the GAME (BaseGame pulls from the player, then the
  // handler pulls from the game).
  for (const idx of Object.values(PLAYER_WALLET)) {
    const addr = walletClients[idx].account.address;
    await token.write.transfer([addr, HUNDRED_EVA]);
    const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[idx] },
    });
    await playerToken.write.approve([game.address, ONE_THOUSAND_EVA]);
  }

  // Bankroll for house top-ups (caller can override with 0n for shortfall tests).
  const bankroll = opts.bankroll ?? HUNDRED_EVA;
  if (bankroll > 0n) {
    await token.write.transfer([game.address, bankroll]);
  }

  return { token, handler, provider, coordinator, authHub, game };
}

function gameAs(ctx: Ctx, walletIdx: number) {
  return env.viem.getContractAt("HorseRaceGame", ctx.game.address, {
    client: { wallet: walletClients[walletIdx] },
  });
}

async function authorizeSession(ctx: Ctx, playerKey: keyof typeof PLAYER_WALLET, spendCap = 0n) {
  const hub = await env.viem.getContractAt("AuthHub", ctx.authHub.address, {
    client: { wallet: walletClients[PLAYER_WALLET[playerKey]] },
  });
  await hub.write.authorize([walletClients[SESSION_WALLET[playerKey]].account.address, 0n, spendCap]);
}

async function signJoin(
  ctx: Ctx,
  playerKey: keyof typeof PLAYER_WALLET,
  msg: {
    roomId: `0x${string}`;
    betAmount?: bigint;
    referrer?: `0x${string}`;
    nonce?: bigint;
    deadline?: bigint;
    game?: `0x${string}`;
    signerIdx?: number;
  },
) {
  const player = walletClients[PLAYER_WALLET[playerKey]].account.address;
  const nonce = msg.nonce ?? ((await ctx.game.read.actionNonces([player])) as bigint);
  const deadline = msg.deadline ?? (await nowOnChain()) + 3600n;
  const signer = walletClients[msg.signerIdx ?? SESSION_WALLET[playerKey]];
  const signature = await signer.signTypedData({
    domain: {
      name: "HorseRaceGame",
      version: "1",
      chainId,
      verifyingContract: ctx.game.address,
    },
    types: {
      JoinRace: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "roomId", type: "bytes32" },
        { name: "betAmount", type: "uint256" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "JoinRace",
    message: {
      game: msg.game ?? ctx.game.address,
      player,
      roomId: msg.roomId,
      betAmount: msg.betAmount ?? TIER,
      potentialReferrer: msg.referrer ?? ZERO_ADDRESS,
      nonce,
      deadline,
    },
  });
  return { player, nonce, deadline, signature, betAmount: msg.betAmount ?? TIER };
}

/** createRace + k direct joins (A,B,C,D order) + lockRace, as the operator. */
async function openLockRace(
  ctx: Ctx,
  k: number,
  opts: { lock?: boolean } = {},
): Promise<{ raceId: bigint; roomId: `0x${string}` }> {
  const roomId = freshRoom();
  const opGame = await gameAs(ctx, 3);
  await opGame.write.createRace([roomId, TIER, COMMIT]);
  const raceId = (await ctx.game.read.getRaceIdByRoom([roomId])) as bigint;
  const keys: (keyof typeof PLAYER_WALLET)[] = ["A", "B", "C", "D"];
  for (let i = 0; i < k; i++) {
    const pGame = await gameAs(ctx, PLAYER_WALLET[keys[i]]);
    await pGame.write.joinRace([roomId, ZERO_ADDRESS]);
  }
  if (opts.lock !== false) {
    await opGame.write.lockRace([roomId]);
  }
  return { raceId, roomId };
}

async function fulfillVRF(ctx: Ctx, raceId: bigint, word = 0xdeadbeefn) {
  const race = (await ctx.game.read.getRace([raceId])) as any;
  await ctx.coordinator.write.fulfill([ctx.provider.address, race.vrfRequestId, [word]]);
}

async function impersonatedProviderGame(ctx: Ctx) {
  await env.networkHelpers.impersonateAccount(ctx.provider.address);
  await env.networkHelpers.setBalance(ctx.provider.address, 10n ** 18n);
  const providerWallet = await env.viem.getWalletClient(ctx.provider.address);
  return env.viem.getContractAt("HorseRaceGame", ctx.game.address, {
    client: { wallet: providerWallet },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction & wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — construction", () => {
  it("wires platform contracts and seeds the initial game operator", async () => {
    const ctx = await setup();
    expect((await ctx.game.read.evaToken()).toLowerCase()).to.equal(ctx.token.address.toLowerCase());
    expect((await ctx.game.read.paymentHandler()).toLowerCase()).to.equal(ctx.handler.address.toLowerCase());
    expect((await ctx.game.read.randomProvider()).toLowerCase()).to.equal(ctx.provider.address.toLowerCase());
    expect((await ctx.game.read.authHub()).toLowerCase()).to.equal(ctx.authHub.address.toLowerCase());
    expect(await ctx.game.read.gameOperators([operator])).to.equal(true);
    expect(await ctx.game.read.currentEngineConfigHash()).to.equal(ENGINE_HASH);
    expect(await ctx.game.read.settleDeadlineSeconds()).to.equal(900);
    expect(await ctx.game.read.refundBps()).to.equal(10_000);
  });

  it("reverts on zero engine config hash", async () => {
    const token = await env.viem.deployContract("EverValueCoin");
    const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
    const coordinator = await env.viem.deployContract("MockVRFCoordinatorV2Plus");
    const provider = await env.viem.deployContract("RandomProvider", [coordinator.address]);
    const authHub = await env.viem.deployContract("AuthHub");
    await expectRevert(
      env.viem.deployContract("HorseRaceGame", [
        token.address,
        handler.address,
        provider.address,
        authHub.address,
        operator,
        ("0x" + "00".repeat(32)) as `0x${string}`,
      ]),
      "ConfigOutOfBounds",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createRace
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — createRace", () => {
  it("creates an Open race and indexes it by room", async () => {
    const ctx = await setup();
    const roomId = freshRoom();
    const opGame = await gameAs(ctx, 3);
    await opGame.write.createRace([roomId, TIER, COMMIT]);

    const raceId = (await ctx.game.read.getRaceIdByRoom([roomId])) as bigint;
    expect(raceId).to.equal(1n);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Open);
    expect(race.roomId).to.equal(roomId);
    expect(race.betAmount).to.equal(TIER);
    expect(race.commitHash).to.equal(COMMIT);
    expect(race.winnerLane).to.equal(HOUSE_SENTINEL);
    expect(race.playerCount).to.equal(0);

    const events = await ctx.game.getEvents.RaceCreated();
    expect(events.length).to.equal(1);
    expect(events[0].args.raceId).to.equal(1n);
    expect(events[0].args.roomId).to.equal(roomId);
  });

  it("rejects non-gameOperator, zero commit, unknown tier and reused room", async () => {
    const ctx = await setup();
    const roomId = freshRoom();
    const opGame = await gameAs(ctx, 3);
    const strangerGame = await gameAs(ctx, 12);

    await expectRevert(strangerGame.write.createRace([roomId, TIER, COMMIT]), "NotGameOperator");
    await expectRevert(
      opGame.write.createRace([roomId, TIER, ("0x" + "00".repeat(32)) as `0x${string}`]),
      "InvalidCommitHash",
    );
    await expectRevert(opGame.write.createRace([roomId, TIER * 7n, COMMIT]), "BetTierNotAllowed");

    await opGame.write.createRace([roomId, TIER, COMMIT]);
    await expectRevert(opGame.write.createRace([roomId, TIER, COMMIT]), "RoomAlreadyUsed");
  });

  it("rejects when paused", async () => {
    const ctx = await setup();
    await ctx.game.write.pause();
    const opGame = await gameAs(ctx, 3);
    await expectRevert(opGame.write.createRace([freshRoom(), TIER, COMMIT]), "Pausable: paused");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// joinRace (direct)
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — joinRace (direct)", () => {
  it("seats the player, routes fees through the handler and dual-emits", async () => {
    const ctx = await setup();
    const { raceId, roomId } = await openLockRace(ctx, 0, { lock: false });

    const before = await ctx.token.read.balanceOf([playerA]);
    const pGame = await gameAs(ctx, PLAYER_WALLET.A);
    await pGame.write.joinRace([roomId, ZERO_ADDRESS]);
    const after = await ctx.token.read.balanceOf([playerA]);
    expect(before - after).to.equal(TIER);

    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.playerCount).to.equal(1);
    expect(race.totalNetCollected).to.equal(NET_PER_SEAT);

    const seats = (await ctx.game.read.getSeats([raceId])) as any[];
    expect(seats[0].player.toLowerCase()).to.equal(playerA.toLowerCase());
    expect(seats[0].betId).to.equal(1n);
    expect(seats[0].netStake).to.equal(NET_PER_SEAT);
    expect(seats[1].player).to.equal(ZERO_ADDRESS);
    expect(await ctx.game.read.hasJoined([raceId, playerA])).to.equal(true);

    const joined = await ctx.game.getEvents.PlayerJoined();
    expect(joined.length).to.equal(1);
    expect(joined[0].args.lane).to.equal(0);
    const placed = await ctx.game.getEvents.BetPlaced();
    expect(placed.length).to.equal(1);
    expect(placed[0].args.requestId).to.equal(1n);
    expect(placed[0].args.amount).to.equal(TIER);
  });

  it("rejects unknown room, full race, double join, banned player and non-Open state", async () => {
    const ctx = await setup();
    const pGameA = await gameAs(ctx, PLAYER_WALLET.A);

    await expectRevert(pGameA.write.joinRace([freshRoom(), ZERO_ADDRESS]), "RaceNotFound");

    const { roomId } = await openLockRace(ctx, 0, { lock: false });
    await pGameA.write.joinRace([roomId, ZERO_ADDRESS]);
    await expectRevert(pGameA.write.joinRace([roomId, ZERO_ADDRESS]), "AlreadyJoined");

    for (const idx of [PLAYER_WALLET.B, PLAYER_WALLET.C, PLAYER_WALLET.D]) {
      const pg = await gameAs(ctx, idx);
      await pg.write.joinRace([roomId, ZERO_ADDRESS]);
    }
    // 5th distinct player on a full race
    await ctx.token.write.transfer([other, TEN_EVA]);
    const otherToken = await env.viem.getContractAt("EverValueCoin", ctx.token.address, {
      client: { wallet: walletClients[12] },
    });
    await otherToken.write.approve([ctx.game.address, TEN_EVA]);
    const pGameOther = await gameAs(ctx, 12);
    await expectRevert(pGameOther.write.joinRace([roomId, ZERO_ADDRESS]), "RaceFull");

    // banned player on a fresh race
    const { roomId: room2 } = await openLockRace(ctx, 0, { lock: false });
    await ctx.game.write.setPlayerBanned([playerA, true]);
    await expectRevert(pGameA.write.joinRace([room2, ZERO_ADDRESS]), "PlayerIsBanned");
    await ctx.game.write.setPlayerBanned([playerA, false]);

    // locked race is not Open anymore
    const { roomId: room3 } = await openLockRace(ctx, 1);
    await expectRevert(pGameA.write.joinRace([room3, ZERO_ADDRESS]), "InvalidRaceState");
  });

  it("rejects when paused", async () => {
    const ctx = await setup();
    const { roomId } = await openLockRace(ctx, 0, { lock: false });
    await ctx.game.write.pause();
    const pGame = await gameAs(ctx, PLAYER_WALLET.A);
    await expectRevert(pGame.write.joinRace([roomId, ZERO_ADDRESS]), "Pausable: paused");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// joinRaceFor (delegated)
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — joinRaceFor", () => {
  it("happy path: verifies the session-key signature, consumes the nonce, seats the player", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A");
    const { raceId, roomId } = await openLockRace(ctx, 0, { lock: false });

    const join = await signJoin(ctx, "A", { roomId });
    const opGame = await gameAs(ctx, 3);
    await opGame.write.joinRaceFor([
      join.player,
      roomId,
      join.betAmount,
      ZERO_ADDRESS,
      join.nonce,
      join.deadline,
      join.signature,
    ]);

    expect(await ctx.game.read.actionNonces([playerA])).to.equal(join.nonce + 1n);
    const seats = (await ctx.game.read.getSeats([raceId])) as any[];
    expect(seats[0].player.toLowerCase()).to.equal(playerA.toLowerCase());
  });

  it("charges the AuthHub spend cap with the bet amount", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A", TIER * 2n);
    const { roomId } = await openLockRace(ctx, 0, { lock: false });
    const join = await signJoin(ctx, "A", { roomId });
    const opGame = await gameAs(ctx, 3);
    await opGame.write.joinRaceFor([
      join.player, roomId, join.betAmount, ZERO_ADDRESS, join.nonce, join.deadline, join.signature,
    ]);
    const session = (await ctx.authHub.read.keys([playerA])) as any[];
    // keys(player) → (sessionKey, expiresAt, spendCap, spent) — spent must equal the bet
    expect(session[3]).to.equal(TIER);
  });

  it("rejects non-operator relayers", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A");
    const { roomId } = await openLockRace(ctx, 0, { lock: false });
    const join = await signJoin(ctx, "A", { roomId });
    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(
      strangerGame.write.joinRaceFor([
        join.player, roomId, join.betAmount, ZERO_ADDRESS, join.nonce, join.deadline, join.signature,
      ]),
      "0x7c214f04", // selector de NotOperator()
    );
  });

  it("rejects expired deadline, stale nonce, replay, missing session key and wrong signer", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A");
    const { roomId } = await openLockRace(ctx, 0, { lock: false });
    const opGame = await gameAs(ctx, 3);

    // expired deadline
    const expired = await signJoin(ctx, "A", { roomId, deadline: (await nowOnChain()) - 1n });
    await expectRevert(
      opGame.write.joinRaceFor([
        expired.player, roomId, expired.betAmount, ZERO_ADDRESS, expired.nonce, expired.deadline, expired.signature,
      ]),
      "ExpiredDeadline",
    );

    // stale nonce
    const stale = await signJoin(ctx, "A", { roomId, nonce: 99n });
    await expectRevert(
      opGame.write.joinRaceFor([
        stale.player, roomId, stale.betAmount, ZERO_ADDRESS, stale.nonce, stale.deadline, stale.signature,
      ]),
      "InvalidNonce",
    );

    // wrong signer (player B's session key signs for A)
    const wrongSigner = await signJoin(ctx, "A", { roomId, signerIdx: SESSION_WALLET.B });
    await expectRevert(
      opGame.write.joinRaceFor([
        wrongSigner.player, roomId, wrongSigner.betAmount, ZERO_ADDRESS, wrongSigner.nonce, wrongSigner.deadline, wrongSigner.signature,
      ]),
      "InvalidSignature",
    );

    // happy join, then replay the same signature (nonce already consumed)
    const join = await signJoin(ctx, "A", { roomId });
    await opGame.write.joinRaceFor([
      join.player, roomId, join.betAmount, ZERO_ADDRESS, join.nonce, join.deadline, join.signature,
    ]);
    await expectRevert(
      opGame.write.joinRaceFor([
        join.player, roomId, join.betAmount, ZERO_ADDRESS, join.nonce, join.deadline, join.signature,
      ]),
      "InvalidNonce",
    );

    // player without session key
    const noKey = await signJoin(ctx, "B", { roomId });
    await expectRevert(
      opGame.write.joinRaceFor([
        noKey.player, roomId, noKey.betAmount, ZERO_ADDRESS, noKey.nonce, noKey.deadline, noKey.signature,
      ]),
      "NoSessionKey",
    );
  });

  it("rejects a signature produced for a different game contract (cross-game replay)", async () => {
    const ctx = await setup();
    const ctx2 = await setup();
    await authorizeSession(ctx, "A");
    const { roomId } = await openLockRace(ctx, 0, { lock: false });

    // signed with ctx2's address as the game — both domain and payload bind ctx2
    const join = await signJoin(ctx, "A", { roomId, game: ctx2.game.address });
    const opGame = await gameAs(ctx, 3);
    await expectRevert(
      opGame.write.joinRaceFor([
        join.player, roomId, join.betAmount, ZERO_ADDRESS, join.nonce, join.deadline, join.signature,
      ]),
      "InvalidSignature",
    );
  });

  it("rejects a signed betAmount different from the race tier", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A");
    const { roomId } = await openLockRace(ctx, 0, { lock: false });
    const join = await signJoin(ctx, "A", { roomId, betAmount: TIER / 2n });
    const opGame = await gameAs(ctx, 3);
    await expectRevert(
      opGame.write.joinRaceFor([
        join.player, roomId, join.betAmount, ZERO_ADDRESS, join.nonce, join.deadline, join.signature,
      ]),
      "WrongBetAmount",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lockRace
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — lockRace", () => {
  it("k=0 → race Cancelled without revert (clean multicall batches)", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 0);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Cancelled);
    expect(race.vrfRequestId).to.equal(0n);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    const cancelled = await ctx.game.getEvents.RaceCancelled();
    expect(cancelled.length).to.equal(1);
  });

  it("k=1 → houseTopUp = 3×net, exposure = houseTopUp, VRF requested, config snapshot", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 1);
    const race = (await ctx.game.read.getRace([raceId])) as any;

    expect(race.state).to.equal(ST.Locked);
    expect(race.houseTopUp).to.equal(3n * NET_PER_SEAT);
    expect(race.exposureLocked).to.equal(3n * NET_PER_SEAT); // > refund premium (0.03 EVA)
    expect(await ctx.game.read.lockedExposure()).to.equal(3n * NET_PER_SEAT);
    expect(race.vrfRequestId).to.equal(1n);
    expect(race.engineConfigHash).to.equal(ENGINE_HASH);
    expect(race.settleBy > race.lockedAt).to.equal(true);

    const locked = await ctx.game.getEvents.RaceLocked();
    expect(locked.length).to.equal(1);
    expect(locked[0].args.playerCount).to.equal(1);
  });

  it("k=4 → houseTopUp = 0, exposure = refund premium (gross refunds exceed net collected)", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 4);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.houseTopUp).to.equal(0n);
    // refund premium = 4×TIER − 4×NET = 4×TIER×3%
    const premium = 4n * TIER - 4n * NET_PER_SEAT;
    expect(race.exposureLocked).to.equal(premium);
    expect(await ctx.game.read.lockedExposure()).to.equal(premium);
  });

  it("reads fees from the PaymentHandler at lock time (fee changes move the pot)", async () => {
    const ctx = await setup();
    // bump total fees to 5% before locking
    await ctx.handler.write.updateGameConfig([ctx.game.address, ctx.game.address, feeRecipient, 250, 250, 0]);
    const roomId = freshRoom();
    const opGame = await gameAs(ctx, 3);
    await opGame.write.createRace([roomId, TIER, COMMIT]);
    const pGame = await gameAs(ctx, PLAYER_WALLET.A);
    await pGame.write.joinRace([roomId, ZERO_ADDRESS]);
    await opGame.write.lockRace([roomId]);

    const raceId = (await ctx.game.read.getRaceIdByRoom([roomId])) as bigint;
    const race = (await ctx.game.read.getRace([raceId])) as any;
    const netAt5 = (TIER * 9_500n) / MAX_BPS;
    expect(race.houseTopUp).to.equal(3n * netAt5);
    expect(race.totalNetCollected).to.equal(netAt5);
  });

  it("reverts on unknown room, non-Open race, non-gameOperator and paused", async () => {
    const ctx = await setup();
    const opGame = await gameAs(ctx, 3);
    await expectRevert(opGame.write.lockRace([freshRoom()]), "RaceNotFound");

    const { roomId } = await openLockRace(ctx, 1);
    await expectRevert(opGame.write.lockRace([roomId]), "InvalidRaceState");

    const { roomId: room2 } = await openLockRace(ctx, 1, { lock: false });
    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(strangerGame.write.lockRace([room2]), "NotGameOperator");

    await ctx.game.write.pause();
    await expectRevert(opGame.write.lockRace([room2]), "Pausable: paused");
  });

  it("reverts with LiquidityShortfall when the bankroll cannot cover the top-up", async () => {
    const ctx = await setup({ bankroll: 0n });
    const { roomId } = await openLockRace(ctx, 1, { lock: false });
    const opGame = await gameAs(ctx, 3);
    // balance = 1×netStake (just collected), needed exposure = 3×netStake
    await expectRevert(opGame.write.lockRace([roomId]), "LiquidityShortfall");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VRF callbacks
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — fulfillRandomness / handleRandomFailure", () => {
  it("stores the random word for a Locked race", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 1);
    await fulfillVRF(ctx, raceId, 0xabcn);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.vrfFulfilled).to.equal(true);
    expect(race.vrfRandomWord).to.equal(0xabcn);
    const events = await ctx.game.getEvents.RaceRandomnessFulfilled();
    expect(events.length).to.equal(1);
  });

  it("rejects callbacks from anyone but the RandomProvider", async () => {
    const ctx = await setup();
    await expectRevert(
      ctx.game.write.fulfillRandomness([1n, 1n, []]),
      "0x5c427cd9", // selector de UnauthorizedCaller()
    );
    await expectRevert(
      ctx.game.write.handleRandomFailure([1n, ("0x" + "11".repeat(32)) as `0x${string}`, "0x"]),
      "0x5c427cd9", // selector de UnauthorizedCaller()
    );
  });

  it("silently ignores unknown request ids and non-Locked races", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 1);
    const asProvider = await impersonatedProviderGame(ctx);

    // unknown request id → no-op
    await asProvider.write.fulfillRandomness([999n, 5n, []]);
    await asProvider.write.handleRandomFailure([999n, ("0x" + "11".repeat(32)) as `0x${string}`, "0x"]);

    // settle the race, then a late fulfillment must be a no-op
    await fulfillVRF(ctx, raceId);
    const opGame = await gameAs(ctx, 3);
    await opGame.write.settleRace([raceId, SERVER_SEED, 0, CARROT_HASH]);

    const race = (await ctx.game.read.getRace([raceId])) as any;
    await asProvider.write.fulfillRandomness([race.vrfRequestId, 7n, []]);
    await asProvider.write.handleRandomFailure([race.vrfRequestId, ("0x" + "11".repeat(32)) as `0x${string}`, "0x"]);
    const after = (await ctx.game.read.getRace([raceId])) as any;
    expect(after.state).to.equal(ST.Settled);
    expect(after.vrfRandomWord).to.equal(0xdeadbeefn);
    await env.networkHelpers.stopImpersonatingAccount(ctx.provider.address);
  });

  it("VRF failure refunds every seat at gross and unlocks exposure", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 2);
    const before = await ctx.token.read.balanceOf([playerA]);

    const race = (await ctx.game.read.getRace([raceId])) as any;
    const asProvider = await impersonatedProviderGame(ctx);
    const reason = ("0x" + "aa".repeat(32)) as `0x${string}`;
    await asProvider.write.handleRandomFailure([race.vrfRequestId, reason, "0x"]);
    await env.networkHelpers.stopImpersonatingAccount(ctx.provider.address);

    const after = (await ctx.game.read.getRace([raceId])) as any;
    expect(after.state).to.equal(ST.Refunded);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    expect((await ctx.token.read.balanceOf([playerA])) - before).to.equal(TIER);

    const failed = await ctx.game.getEvents.BetFailed();
    expect(failed.length).to.equal(2);
    const refunded = await ctx.game.getEvents.RaceRefunded();
    expect(refunded.length).to.equal(1);
    expect(refunded[0].args.reason).to.equal(reason);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// settleRace
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — settleRace", () => {
  it("k=1, player wins: pays the full net pot and reveals the seed", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 1);
    await fulfillVRF(ctx, raceId);

    const before = await ctx.token.read.balanceOf([playerA]);
    const opGame = await gameAs(ctx, 3);
    await opGame.write.settleRace([raceId, SERVER_SEED, 0, CARROT_HASH]);

    const prize = 4n * NET_PER_SEAT;
    expect((await ctx.token.read.balanceOf([playerA])) - before).to.equal(prize);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);

    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Settled);
    expect(race.serverSeed).to.equal(SERVER_SEED);
    expect(race.winnerLane).to.equal(0);
    expect(race.carrotDataHash).to.equal(CARROT_HASH);

    const settledEnvelope = await ctx.game.getEvents.BetSettled();
    expect(settledEnvelope.length).to.equal(1);
    expect(settledEnvelope[0].args.payout).to.equal(prize);
    const raceSettled = await ctx.game.getEvents.RaceSettled();
    expect(raceSettled.length).to.equal(1);
    expect(raceSettled[0].args.winner.toLowerCase()).to.equal(playerA.toLowerCase());
    expect(raceSettled[0].args.prize).to.equal(prize);
  });

  it("k=1, house lane wins: pot stays in the bankroll, player envelope pays 0", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 1);
    await fulfillVRF(ctx, raceId);

    const gameBalBefore = await ctx.token.read.balanceOf([ctx.game.address]);
    const playerBalBefore = await ctx.token.read.balanceOf([playerA]);
    const opGame = await gameAs(ctx, 3);
    await opGame.write.settleRace([raceId, SERVER_SEED, 3, CARROT_HASH]);

    expect(await ctx.token.read.balanceOf([ctx.game.address])).to.equal(gameBalBefore);
    expect(await ctx.token.read.balanceOf([playerA])).to.equal(playerBalBefore);

    const settled = await ctx.game.getEvents.BetSettled();
    expect(settled.length).to.equal(1);
    expect(settled[0].args.payout).to.equal(0n);
    const raceSettled = await ctx.game.getEvents.RaceSettled();
    expect(raceSettled[0].args.winner).to.equal(ZERO_ADDRESS);
  });

  it("k=4: winner takes the pot, losers settle at 0", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 4);
    await fulfillVRF(ctx, raceId);

    const beforeB = await ctx.token.read.balanceOf([playerB]);
    const opGame = await gameAs(ctx, 3);
    await opGame.write.settleRace([raceId, SERVER_SEED, 1, CARROT_HASH]);

    expect((await ctx.token.read.balanceOf([playerB])) - beforeB).to.equal(4n * NET_PER_SEAT);
    const settled = await ctx.game.getEvents.BetSettled();
    expect(settled.length).to.equal(4);
    const payouts = settled.map((e: any) => e.args.payout);
    expect(payouts.filter((p: bigint) => p === 0n).length).to.equal(3);
  });

  it("works while paused (payouts continue during incident response)", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 1);
    await fulfillVRF(ctx, raceId);
    await ctx.game.write.pause();
    const opGame = await gameAs(ctx, 3);
    await opGame.write.settleRace([raceId, SERVER_SEED, 0, CARROT_HASH]);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Settled);
  });

  it("reverts on bad state, missing VRF, wrong seed, bad lane and non-gameOperator", async () => {
    const ctx = await setup();
    const opGame = await gameAs(ctx, 3);

    await expectRevert(opGame.write.settleRace([42n, SERVER_SEED, 0, CARROT_HASH]), "InvalidRaceState");

    const { raceId } = await openLockRace(ctx, 1);
    await expectRevert(opGame.write.settleRace([raceId, SERVER_SEED, 0, CARROT_HASH]), "VRFNotFulfilled");

    await fulfillVRF(ctx, raceId);
    await expectRevert(
      opGame.write.settleRace([raceId, keccak256(toHex("wrong")), 0, CARROT_HASH]),
      "InvalidServerSeed",
    );
    await expectRevert(opGame.write.settleRace([raceId, SERVER_SEED, 4, CARROT_HASH]), "InvalidWinnerLane");

    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(
      strangerGame.write.settleRace([raceId, SERVER_SEED, 0, CARROT_HASH]),
      "NotGameOperator",
    );

    await opGame.write.settleRace([raceId, SERVER_SEED, 0, CARROT_HASH]);
    await expectRevert(opGame.write.settleRace([raceId, SERVER_SEED, 0, CARROT_HASH]), "InvalidRaceState");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelRace + emergencyRefundRace
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — cancelRace", () => {
  it("refunds joined seats at gross and cancels an Open race", async () => {
    const ctx = await setup();
    const { raceId, roomId } = await openLockRace(ctx, 0, { lock: false });
    const pGame = await gameAs(ctx, PLAYER_WALLET.A);
    await pGame.write.joinRace([roomId, ZERO_ADDRESS]);

    const before = await ctx.token.read.balanceOf([playerA]);
    const opGame = await gameAs(ctx, 3);
    await opGame.write.cancelRace([raceId]);

    expect((await ctx.token.read.balanceOf([playerA])) - before).to.equal(TIER);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Cancelled);
    const failed = await ctx.game.getEvents.BetFailed();
    expect(failed.length).to.equal(1);
  });

  it("reverts on non-Open races and non-gameOperator callers", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 1);
    const opGame = await gameAs(ctx, 3);
    await expectRevert(opGame.write.cancelRace([raceId]), "InvalidRaceState");

    const { raceId: race2 } = await openLockRace(ctx, 0, { lock: false });
    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(strangerGame.write.cancelRace([race2]), "NotGameOperator");
  });
});

describe("HorseRaceGame — emergencyRefundRace", () => {
  it("anyone can refund after settleBy + grace; before that it reverts", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 2);
    await fulfillVRF(ctx, raceId);

    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(strangerGame.write.emergencyRefundRace([raceId]), "SettleDeadlineNotPassed");

    await env.networkHelpers.time.increase(900 + 31);

    const beforeA = await ctx.token.read.balanceOf([playerA]);
    await strangerGame.write.emergencyRefundRace([raceId]);

    expect((await ctx.token.read.balanceOf([playerA])) - beforeA).to.equal(TIER);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Refunded);
    const refunded = await ctx.game.getEvents.RaceRefunded();
    expect(refunded.length).to.equal(1);
  });

  it("reverts for races that are not Locked", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 0);
    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(strangerGame.write.emergencyRefundRace([raceId]), "InvalidRaceState");
  });

  it("a settled race can no longer be emergency-refunded (and vice versa)", async () => {
    const ctx = await setup();
    const { raceId } = await openLockRace(ctx, 1);
    await fulfillVRF(ctx, raceId);
    await env.networkHelpers.time.increase(900 + 31);

    // late settle still possible if nobody pulled the valve
    const opGame = await gameAs(ctx, 3);
    await opGame.write.settleRace([raceId, SERVER_SEED, 0, CARROT_HASH]);
    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(strangerGame.write.emergencyRefundRace([raceId]), "InvalidRaceState");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// multicallTry — the canonical operator batch
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — multicallTry batch", () => {
  function encodeCreate(roomId: `0x${string}`) {
    return encodeFunctionData({
      abi: [{
        type: "function", name: "createRace", stateMutability: "nonpayable",
        inputs: [
          { name: "roomId", type: "bytes32" },
          { name: "betAmount", type: "uint256" },
          { name: "commitHash", type: "bytes32" },
        ],
        outputs: [{ name: "raceId", type: "uint256" }],
      }],
      functionName: "createRace",
      args: [roomId, TIER, COMMIT],
    });
  }

  function encodeJoinFor(roomId: `0x${string}`, j: { player: `0x${string}`; betAmount: bigint; nonce: bigint; deadline: bigint; signature: `0x${string}` }) {
    return encodeFunctionData({
      abi: [{
        type: "function", name: "joinRaceFor", stateMutability: "nonpayable",
        inputs: [
          { name: "player", type: "address" },
          { name: "roomId", type: "bytes32" },
          { name: "betAmount", type: "uint256" },
          { name: "potentialReferrer", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
        outputs: [{ name: "betId", type: "uint256" }],
      }],
      functionName: "joinRaceFor",
      args: [j.player, roomId, j.betAmount, ZERO_ADDRESS, j.nonce, j.deadline, j.signature],
    });
  }

  function encodeLock(roomId: `0x${string}`) {
    return encodeFunctionData({
      abi: [{
        type: "function", name: "lockRace", stateMutability: "nonpayable",
        inputs: [{ name: "roomId", type: "bytes32" }],
        outputs: [{ name: "raceId", type: "uint256" }],
      }],
      functionName: "lockRace",
      args: [roomId],
    });
  }

  it("create + joinFor×2 + lock in one tx: race Locked with 2 players and 2 house lanes", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A");
    await authorizeSession(ctx, "B");
    const roomId = freshRoom();

    const joinA = await signJoin(ctx, "A", { roomId });
    const joinB = await signJoin(ctx, "B", { roomId });

    const opGame = await gameAs(ctx, 3);
    const tx = await opGame.write.multicallTry(
      [[
        encodeCreate(roomId),
        encodeJoinFor(roomId, joinA as any),
        encodeJoinFor(roomId, joinB as any),
        encodeLock(roomId),
      ]],
      { gas: 8_000_000n },
    );
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const raceId = (await ctx.game.read.getRaceIdByRoom([roomId])) as bigint;
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Locked);
    expect(race.playerCount).to.equal(2);
    expect(race.houseTopUp).to.equal(2n * NET_PER_SEAT);

    const subFails = await ctx.game.getEvents.MulticallSubCallFailed();
    expect(subFails.length).to.equal(0);
  });

  it("a stale-nonce join reverts in isolation; the lock still lands and the house covers the lane", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, "A");
    await authorizeSession(ctx, "B");
    const roomId = freshRoom();

    const joinA = await signJoin(ctx, "A", { roomId });
    const joinBBad = await signJoin(ctx, "B", { roomId, nonce: 7n }); // stale nonce

    const opGame = await gameAs(ctx, 3);
    const tx = await opGame.write.multicallTry(
      [[
        encodeCreate(roomId),
        encodeJoinFor(roomId, joinA as any),
        encodeJoinFor(roomId, joinBBad as any),
        encodeLock(roomId),
      ]],
      { gas: 8_000_000n },
    );
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const raceId = (await ctx.game.read.getRaceIdByRoom([roomId])) as bigint;
    const race = (await ctx.game.read.getRace([raceId])) as any;
    expect(race.state).to.equal(ST.Locked);
    expect(race.playerCount).to.equal(1);
    expect(race.houseTopUp).to.equal(3n * NET_PER_SEAT);

    const subFails = await ctx.game.getEvents.MulticallSubCallFailed();
    expect(subFails.length).to.equal(1);
    expect(subFails[0].args.index).to.equal(2n);

    // playerB's money never moved
    expect(await ctx.token.read.balanceOf([playerB])).to.equal(HUNDRED_EVA);
  });

  it("rejects non-operator callers at the gate", async () => {
    const ctx = await setup();
    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(
      strangerGame.write.multicallTry([[encodeCreate(freshRoom())]], { gas: 1_000_000n }),
      "NotAuthorizedMulticaller",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin setters & views
// ─────────────────────────────────────────────────────────────────────────────

describe("HorseRaceGame — admin", () => {
  it("setters update state, emit events and enforce bounds", async () => {
    const ctx = await setup();

    await ctx.game.write.setBetTier([TIER * 5n, true]);
    expect(await ctx.game.read.allowedBetAmounts([TIER * 5n])).to.equal(true);
    await ctx.game.write.setBetTier([TIER * 5n, false]);
    expect(await ctx.game.read.allowedBetAmounts([TIER * 5n])).to.equal(false);
    await expectRevert(ctx.game.write.setBetTier([0n, true]), "ConfigOutOfBounds");

    await ctx.game.write.setSettleDeadlineSeconds([600]);
    expect(await ctx.game.read.settleDeadlineSeconds()).to.equal(600);
    await expectRevert(ctx.game.write.setSettleDeadlineSeconds([59]), "ConfigOutOfBounds");
    await expectRevert(ctx.game.write.setSettleDeadlineSeconds([86401]), "ConfigOutOfBounds");

    await ctx.game.write.setRefundBps([9700]);
    expect(await ctx.game.read.refundBps()).to.equal(9700);
    await expectRevert(ctx.game.write.setRefundBps([10001]), "ConfigOutOfBounds");

    const newHash = keccak256(toHex("engine-config-v2"));
    await ctx.game.write.setEngineConfigHash([newHash]);
    expect(await ctx.game.read.currentEngineConfigHash()).to.equal(newHash);
    await expectRevert(
      ctx.game.write.setEngineConfigHash([("0x" + "00".repeat(32)) as `0x${string}`]),
      "ConfigOutOfBounds",
    );

    await ctx.game.write.setPlayerBanned([playerA, true]);
    expect(await ctx.game.read.bannedPlayers([playerA])).to.equal(true);

    await ctx.game.write.setLanes([6]);
    expect(await ctx.game.read.lanes()).to.equal(6);
    await expectRevert(ctx.game.write.setLanes([1]), "ConfigOutOfBounds"); // < MIN_LANES
    await expectRevert(ctx.game.write.setLanes([9]), "ConfigOutOfBounds"); // > MAX_LANES
    await ctx.game.write.setLanes([4]); // restore default
  });

  it("setters reject non-owner callers", async () => {
    const ctx = await setup();
    const strangerGame = await gameAs(ctx, 12);
    await expectRevert(strangerGame.write.setBetTier([TIER, false]), "Ownable: caller is not the owner");
    await expectRevert(strangerGame.write.setSettleDeadlineSeconds([600]), "Ownable: caller is not the owner");
    await expectRevert(strangerGame.write.setRefundBps([9000]), "Ownable: caller is not the owner");
    await expectRevert(strangerGame.write.setEngineConfigHash([ENGINE_HASH]), "Ownable: caller is not the owner");
    await expectRevert(strangerGame.write.setPlayerBanned([playerA, true]), "Ownable: caller is not the owner");
    await expectRevert(strangerGame.write.setLanes([6]), "Ownable: caller is not the owner");
  });

  it("setLanes resizes the field for NEW races; in-flight races keep their snapshot", async () => {
    const ctx = await setup();
    const opGame = await gameAs(ctx, 3);

    // race A created with the default 4 lanes
    const roomA = freshRoom();
    await opGame.write.createRace([roomA, TIER, COMMIT]);
    const raceA = (await ctx.game.read.getRaceIdByRoom([roomA])) as bigint;
    expect(((await ctx.game.read.getSeats([raceA])) as any[]).length).to.equal(4);
    expect(((await ctx.game.read.getRace([raceA])) as any).laneCount).to.equal(4);

    // owner bumps the field to 6
    await ctx.game.write.setLanes([6]);

    // race B created afterwards → 6 lanes; race A (in-flight) keeps 4
    const roomB = freshRoom();
    await opGame.write.createRace([roomB, TIER, COMMIT]);
    const raceB = (await ctx.game.read.getRaceIdByRoom([roomB])) as bigint;
    expect(((await ctx.game.read.getSeats([raceB])) as any[]).length).to.equal(6);
    expect(((await ctx.game.read.getRace([raceB])) as any).laneCount).to.equal(6);
    expect(((await ctx.game.read.getRace([raceA])) as any).laneCount).to.equal(4);

    // 4 real players fit in the 6-lane race (not full at 4); lock tops up 2 house lanes
    for (const kk of ["A", "B", "C", "D"] as const) {
      const pGame = await gameAs(ctx, PLAYER_WALLET[kk]);
      await pGame.write.joinRace([roomB, ZERO_ADDRESS]);
    }
    await opGame.write.lockRace([roomB]);
    const net = (TIER * 9_700n) / MAX_BPS;
    expect(((await ctx.game.read.getRace([raceB])) as any).houseTopUp).to.equal(2n * net);

    // a house lane beyond the 4 players (lane 5) is a valid winner now (laneCount = 6)
    await fulfillVRF(ctx, raceB);
    await opGame.write.settleRace([raceB, SERVER_SEED, 5, CARROT_HASH]);
    expect(((await ctx.game.read.getRace([raceB])) as any).winnerLane).to.equal(5);
  });

  it("emergencyWithdraw requires pause and zeroes lockedExposure (platform invariant)", async () => {
    const ctx = await setup();
    await openLockRace(ctx, 1);
    expect((await ctx.game.read.lockedExposure()) > 0n).to.equal(true);

    await expectRevert(ctx.game.write.emergencyWithdraw([deployer, 0n]), "Pausable: not paused");
    await ctx.game.write.pause();
    await ctx.game.write.emergencyWithdraw([deployer, 0n]);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    expect(await ctx.token.read.balanceOf([ctx.game.address])).to.equal(0n);
  });

  it("refundBps below gross refunds proportionally", async () => {
    const ctx = await setup();
    await ctx.game.write.setRefundBps([9700]);
    const { raceId, roomId } = await openLockRace(ctx, 0, { lock: false });
    const pGame = await gameAs(ctx, PLAYER_WALLET.A);
    await pGame.write.joinRace([roomId, ZERO_ADDRESS]);
    const before = await ctx.token.read.balanceOf([playerA]);
    const opGame = await gameAs(ctx, 3);
    await opGame.write.cancelRace([raceId]);
    expect((await ctx.token.read.balanceOf([playerA])) - before).to.equal((TIER * 9_700n) / MAX_BPS);
  });
});

describe("HorseRaceGame — views", () => {
  it("getRace returns empty struct for unknown ids; getRaceIdByRoom 0 for unknown rooms", async () => {
    const ctx = await setup();
    const race = (await ctx.game.read.getRace([777n])) as any;
    expect(race.state).to.equal(ST.None);
    expect(await ctx.game.read.getRaceIdByRoom([freshRoom()])).to.equal(0n);
    // Unknown race → no seats (the dynamic array is only sized at createRace).
    const seats = (await ctx.game.read.getSeats([777n])) as any[];
    expect(seats.length).to.equal(0);
  });
});
