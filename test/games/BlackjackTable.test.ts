import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { keccak256, toHex, parseEther, encodePacked, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";
import { KeccakShoe } from "../helpers/blackjack/shoe.js";
import { Action, actionsToBytes, type ActionCode } from "../helpers/blackjack/actions.js";
import { TableRun, type SeatInput } from "../helpers/blackjack/table.js";

/**
 * BlackjackTableGame lifecycle: open → bets (direct + relayed) → lock (VRF) →
 * extra wagers → settle with every seat's signed play (wallet, round key,
 * session key, timeouts) → refunds. Scenarios are built by searching the VRF
 * word that deals the wanted cards with the vendored TypeScript table engine
 * (pinned to BlackjackTableLib by the golden vectors).
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

const W = { deployer: 0, playerA: 1, sessionA: 2, operator: 3, feeRecipient: 4, defaultRcv: 5, playerB: 6, sessionB: 7, playerC: 8, other: 12 } as const;
const PLAYERS = [W.playerA, W.playerB, W.playerC];
const STAKE = ONE_EVA;
const TABLE = {
  enabled: true,
  tables: 2,
  seats: 7,
  minBet: parseEther("0.1"),
  maxBet: parseEther("1"),
  maxSideBet: parseEther("0.25"),
  settleTimeout: 600,
  refundTimeout: 3600,
};
const ST = { None: 0, Open: 1, Locked: 2, Settled: 3, Refunded: 4 } as const;
const KIND = { Double: 0, Split: 1, Insurance: 2 } as const;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();
});

const addr = (idx: number): `0x${string}` => walletClients[idx].account.address;
let seedCounter = 0;
const freshServerSeed = (): Hex => keccak256(toHex(`table-seed-${++seedCounter}`));
const commitOf = (serverSeed: Hex): Hex => keccak256(encodePacked(["bytes32"], [serverSeed]));

interface Ctx {
  token: any;
  handler: any;
  provider: any;
  coordinator: any;
  authHub: any;
  game: any;
}

async function setup(opts: { bankroll?: bigint; table?: Partial<typeof TABLE> } = {}): Promise<Ctx> {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, addr(W.defaultRcv)]);
  await mlr.write.setLevels([1, [10000]]);
  await mlr.write.setPaymentHandler([handler.address]);
  await handler.write.setReferralContract([mlr.address]);
  const coordinator = await env.viem.deployContract("MockVRFCoordinatorV2Plus");
  const provider = await env.viem.deployContract("RandomProvider", [coordinator.address]);
  await provider.write.setSubscriptionId([1n]);
  const authHub = await env.viem.deployContract("AuthHub");
  const lib = await env.viem.deployContract("BlackjackTableLib");
  const game = await env.viem.deployContract(
    "BlackjackTableGame",
    [token.address, handler.address, provider.address, authHub.address, addr(W.operator)],
    { libraries: { BlackjackTableLib: lib.address } },
  );
  await provider.write.setConsumerStatus([game.address, true, 1n]);
  await handler.write.registerGame([game.address, game.address, addr(W.feeRecipient), 45, 45, 0]);
  await authHub.write.setOperator([addr(W.operator), true]);
  await authHub.write.setSpendTracker([game.address, true]);
  await game.write.setTableConfig([{ ...TABLE, ...(opts.table ?? {}) }]);
  for (const idx of PLAYERS) {
    await token.write.transfer([addr(idx), HUNDRED_EVA]);
    const t = await env.viem.getContractAt("EverValueCoin", token.address, { client: { wallet: walletClients[idx] } });
    await t.write.approve([game.address, ONE_THOUSAND_EVA]);
  }
  const bankroll = opts.bankroll ?? HUNDRED_EVA;
  if (bankroll > 0n) await token.write.transfer([game.address, bankroll]);
  return { token, handler, provider, coordinator, authHub, game };
}

const gameAs = (ctx: Ctx, idx: number) =>
  env.viem.getContractAt("BlackjackTableGame", ctx.game.address, { client: { wallet: walletClients[idx] } });

async function receipt(hash: Hex) {
  return publicClient.waitForTransactionReceipt({ hash });
}

async function events(ctx: Ctx, eventName: string): Promise<any[]> {
  return publicClient.getContractEvents({ address: ctx.game.address, abi: ctx.game.abi, eventName, fromBlock: 0n } as any);
}

const balanceOf = (ctx: Ctx, who: `0x${string}`) => ctx.token.read.balanceOf([who]) as Promise<bigint>;
const nowOnChain = async () => (await publicClient.getBlock()).timestamp;
const domain = (ctx: Ctx) => ({ name: "BlackjackTableGame", version: "1", chainId, verifyingContract: ctx.game.address });

async function openRound(ctx: Ctx, tableId = 0, serverSeed = freshServerSeed()) {
  const op = await gameAs(ctx, W.operator);
  await op.write.openRound([tableId, commitOf(serverSeed)]);
  const roundId = (await ctx.game.read.currentRoundOf([tableId])) as bigint;
  return { roundId, serverSeed, tableId };
}

async function bet(ctx: Ctx, idx: number, roundId: bigint, seat: number, opts: { stake?: bigint; side?: bigint; signer?: `0x${string}` } = {}) {
  const g = await gameAs(ctx, idx);
  return g.write.placeBet([roundId, seat, opts.stake ?? STAKE, opts.side ?? 0n, ZERO_ADDRESS, opts.signer ?? ZERO_ADDRESS]);
}

/** Lock and fulfill with the first VRF word whose deal satisfies `pred`. */
async function lockAndDeal(ctx: Ctx, roundId: bigint, serverSeed: Hex, inputs: SeatInput[], pred: (run: TableRun) => boolean) {
  const op = await gameAs(ctx, W.operator);
  await op.write.lockRound([roundId]);
  const r = (await ctx.game.read.getRound([roundId])) as any;
  for (let w = 1n; w < 100_000n; w++) {
    const seed = keccak256(encodePacked(["bytes32", "uint256", "uint256", "address"], [serverSeed, w, roundId, ctx.game.address]));
    const run = new TableRun(new KeccakShoe(seed), inputs);
    if (pred(run)) {
      await ctx.coordinator.write.fulfill([ctx.provider.address, r.requestId, [w]]);
      return { seed, word: w, requestId: r.requestId as bigint };
    }
  }
  throw new Error("no word found");
}

const freshRun = (seed: Hex, inputs: SeatInput[]) => new TableRun(new KeccakShoe(seed), inputs);

type Signer = { signTypedData: (args: any) => Promise<Hex> };
const signerOf = (idx: number): Signer => walletClients[idx] as unknown as Signer;

async function seatSig(ctx: Ctx, signer: Signer, player: `0x${string}`, roundId: bigint, seat: number, actions: readonly ActionCode[]) {
  return signer.signTypedData({
    domain: domain(ctx),
    types: {
      SeatPlay: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "roundId", type: "uint256" },
        { name: "seat", type: "uint8" },
        { name: "actionsHash", type: "bytes32" },
      ],
    },
    primaryType: "SeatPlay",
    message: { game: ctx.game.address, player, roundId, seat, actionsHash: keccak256(actionsToBytes(actions)) },
  });
}

/** A fully signed SeatPlay for every seat of a finished run. */
async function plays(ctx: Ctx, roundId: bigint, run: TableRun, signers: Map<number, { signer: Signer; player: `0x${string}`; signedLen?: number }>) {
  const out = [];
  for (const s of run.seats) {
    const who = signers.get(s.seat)!;
    const signedLen = who.signedLen ?? s.actions.length;
    const signature = signedLen > 0 ? await seatSig(ctx, who.signer, who.player, roundId, s.seat, s.actions.slice(0, signedLen)) : "0x";
    out.push({ seat: s.seat, actions: actionsToBytes(s.actions), signedLen, signature });
  }
  return out;
}

/** Play every seat with a simple policy until the table is finished. */
function playOut(run: TableRun, policy: (run: TableRun, seat: number) => ActionCode = (r, seat) => (r.legalActions(seat).includes(Action.INSURE_NO) ? Action.INSURE_NO : Action.STAND)) {
  if (run.phase === "insurance") for (const s of run.seats) run.apply(s.seat, policy(run, s.seat));
  while (run.phase === "playing") run.apply(run.turnSeat!, policy(run, run.turnSeat!));
  return run.finish();
}

// ─────────────────────────────────────────────────────────────────────────────

describe("BlackjackTableGame — admin & open", () => {
  it("validates the table config and exposes the constants", async () => {
    const ctx = await setup();
    expect(Number(await ctx.game.read.MAX_SEATS())).to.equal(7);
    expect(Number(await ctx.game.read.RULES_VERSION())).to.equal(1);
    const bad = [
      { minBet: 0n },
      { maxBet: TABLE.minBet - 1n },
      { tables: 0 },
      { tables: 65 },
      { seats: 0 },
      { seats: 8 },
      { settleTimeout: 0 },
      { refundTimeout: 599 },
    ];
    for (const b of bad) await expectRevert(ctx.game.write.setTableConfig([{ ...TABLE, ...b }]), "InvalidConfig");
    const other = await gameAs(ctx, W.other);
    await expectRevert(other.write.setTableConfig([TABLE]), "NotConfigManager");
    const ev = await events(ctx, "TableConfigUpdated");
    expect(Number(ev[0].args.tables)).to.equal(2);
    expect(Number(await ctx.game.read.MAX_TABLES())).to.equal(64);
    await ctx.game.write.setTableConfig([{ ...TABLE, tables: 64 }]);
  });

  it("a config manager changes the table config, and nothing else", async () => {
    const ctx = await setup();
    const other = await gameAs(ctx, W.other);
    await expectRevert(other.write.setConfigManager([addr(W.other), true]), "Ownable: caller is not the owner");
    await expectRevert(ctx.game.write.setConfigManager([ZERO_ADDRESS, true]), "account");
    await ctx.game.write.setConfigManager([addr(W.other), true]);
    expect(await ctx.game.read.configManagers([addr(W.other)])).to.equal(true);
    await other.write.setTableConfig([{ ...TABLE, tables: 20, maxBet: parseEther("2") }]);
    expect(Number(((await ctx.game.read.tableConfig()) as any)[1])).to.equal(20);
    await expectRevert(other.write.setTableConfig([{ ...TABLE, tables: 0 }]), "InvalidConfig");
    // no funds, no roles
    await expectRevert(other.write.withdrawHouseFunds([addr(W.other), 1n]), "Ownable: caller is not the owner");
    await expectRevert(other.write.setGameOperator([addr(W.other), true]), "Ownable: caller is not the owner");
    await expectRevert(other.write.setConfigManager([addr(W.playerA), true]), "Ownable: caller is not the owner");
    await ctx.game.write.setConfigManager([addr(W.other), false]);
    await expectRevert(other.write.setTableConfig([TABLE]), "NotConfigManager");
    const ev = await events(ctx, "ConfigManagerSet");
    expect(ev.map((e) => e.args.status)).to.deep.equal([true, false]);
  });

  it("opens one round per table, only the game operator, only with a commit", async () => {
    const ctx = await setup();
    const op = await gameAs(ctx, W.operator);
    await expectRevert((await gameAs(ctx, W.other)).write.openRound([0, commitOf(freshServerSeed())]), "NotGameOperator");
    await expectRevert(op.write.openRound([0, `0x${"0".repeat(64)}`]), "InvalidCommit");
    await expectRevert(op.write.openRound([2, commitOf(freshServerSeed())]), "InvalidTable");
    const { roundId } = await openRound(ctx, 0);
    expect(roundId).to.equal(1n);
    await expectRevert(op.write.openRound([0, commitOf(freshServerSeed())]), "TableBusy");
    const r2 = await openRound(ctx, 1);
    expect(r2.roundId).to.equal(2n);
    const r = (await ctx.game.read.getRound([roundId])) as any;
    expect(r.status).to.equal(ST.Open);
    expect(Number(r.tableId)).to.equal(0);
    const ev = await events(ctx, "RoundOpened");
    expect(ev.map((e) => Number(e.args.tableId))).to.deep.equal([0, 1]);
    await ctx.game.write.setTableConfig([{ ...TABLE, enabled: false }]);
    await expectRevert(op.write.openRound([0, commitOf(freshServerSeed())]), "GameDisabled");
    await ctx.game.write.pause();
    await expectRevert(op.write.openRound([0, commitOf(freshServerSeed())]), "Pausable: paused");
  });

  it("withdraws only free bankroll", async () => {
    const ctx = await setup();
    const { roundId } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0);
    const locked = (await ctx.game.read.lockedExposure()) as bigint;
    const bal = await balanceOf(ctx, ctx.game.address);
    await expectRevert(ctx.game.write.withdrawHouseFunds([addr(W.other), bal - locked + 1n]), "InsufficientFreeLiquidity");
    await ctx.game.write.withdrawHouseFunds([addr(W.other), ONE_EVA]);
    expect(await balanceOf(ctx, addr(W.other))).to.equal(ONE_EVA);
    await expectRevert(ctx.game.write.withdrawHouseFunds([ZERO_ADDRESS, 1n]), "to");
    const ev = await events(ctx, "HouseFundsWithdrawn");
    expect(ev).to.have.length(1);
  });
});

describe("BlackjackTableGame — bets", () => {
  it("takes seats with their bets, locks exposure and emits both envelopes", async () => {
    const ctx = await setup();
    const { roundId } = await openRound(ctx);
    const key = privateKeyToAccount(generatePrivateKey());
    const before = await balanceOf(ctx, addr(W.playerA));
    await bet(ctx, W.playerA, roundId, 3, { side: parseEther("0.1"), signer: key.address });
    await bet(ctx, W.playerB, roundId, 0);
    expect(before - (await balanceOf(ctx, addr(W.playerA)))).to.equal(STAKE + parseEther("0.1"));
    const r = (await ctx.game.read.getRound([roundId])) as any;
    expect(Number(r.seatMask)).to.equal(0b1001);
    expect(Number(r.seatCount)).to.equal(2);
    // the side bet reserves only its own refund: its wins come from the free bankroll at settle
    expect(r.locked).to.equal((STAKE * 5n) / 2n + parseEther("0.1") + (STAKE * 5n) / 2n);
    const seat = (await ctx.game.read.getSeat([roundId, 3])) as any;
    expect(seat.player.toLowerCase()).to.equal(addr(W.playerA).toLowerCase());
    expect(seat.actionSigner.toLowerCase()).to.equal(key.address.toLowerCase());
    const seats = (await ctx.game.read.getSeats([roundId])) as any[];
    expect(seats).to.have.length(7);
    expect(seats[1].player).to.equal(ZERO_ADDRESS);
    expect(await ctx.game.read.activeRoundOf([addr(W.playerA)])).to.equal(roundId);
    expect(await ctx.game.read.seatWagered([roundId, 3])).to.equal(STAKE + parseEther("0.1"));
    const taken = await events(ctx, "SeatTaken");
    expect(taken.map((e) => Number(e.args.seat))).to.deep.equal([3, 0]);
    const env1 = await events(ctx, "BetPlaced");
    expect(env1[0].args.requestId).to.equal(roundId * 8n + 3n);
  });

  it("rejects bad seats, limits, double seating and closed rounds", async () => {
    const ctx = await setup({ table: { seats: 5 } });
    const { roundId } = await openRound(ctx);
    await expectRevert(bet(ctx, W.playerA, roundId, 5), "InvalidSeat");
    await expectRevert(bet(ctx, W.playerA, roundId, 0, { stake: parseEther("0.09") }), "BetTooLow");
    await expectRevert(bet(ctx, W.playerA, roundId, 0, { stake: parseEther("1.01") }), "BetTooHigh");
    await expectRevert(bet(ctx, W.playerA, roundId, 0, { side: parseEther("0.26") }), "SideBetTooHigh");
    await expectRevert(bet(ctx, W.playerA, 99n, 0), "InvalidRound");
    await bet(ctx, W.playerA, roundId, 0);
    await expectRevert(bet(ctx, W.playerB, roundId, 0), "SeatTakenAlready");
    await expectRevert(bet(ctx, W.playerA, roundId, 1), "ActiveRoundExists");
    // a player seated at table 0 cannot sit at table 1 too
    const t1 = await openRound(ctx, 1);
    await expectRevert(bet(ctx, W.playerA, t1.roundId, 0), "ActiveRoundExists");
    const op = await gameAs(ctx, W.operator);
    await op.write.lockRound([roundId]);
    await expectRevert(bet(ctx, W.playerB, roundId, 1), "InvalidRound");
    await ctx.game.write.setTableConfig([{ ...TABLE, enabled: false }]);
    await expectRevert(bet(ctx, W.playerB, t1.roundId, 1), "GameDisabled");
  });

  it("relays a session-key bet (QuickBet) and refuses non-operators", async () => {
    const ctx = await setup();
    const { roundId } = await openRound(ctx);
    const hub = await env.viem.getContractAt("AuthHub", ctx.authHub.address, { client: { wallet: walletClients[W.playerA] } });
    await hub.write.authorize([addr(W.sessionA), 0n, 0n]);
    const player = addr(W.playerA);
    const nonce = (await ctx.game.read.actionNonces([player])) as bigint;
    const deadline = (await nowOnChain()) + 3600n;
    const signature = await walletClients[W.sessionA].signTypedData({
      domain: domain(ctx),
      types: {
        PlaceBet: [
          { name: "game", type: "address" },
          { name: "player", type: "address" },
          { name: "roundId", type: "uint256" },
          { name: "seat", type: "uint8" },
          { name: "stake", type: "uint128" },
          { name: "sideBet", type: "uint128" },
          { name: "potentialReferrer", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "PlaceBet",
      message: { game: ctx.game.address, player, roundId, seat: 2, stake: STAKE, sideBet: 0n, potentialReferrer: ZERO_ADDRESS, nonce, deadline },
    });
    const args = [player, roundId, 2, STAKE, 0n, ZERO_ADDRESS, nonce, deadline, signature] as const;
    await expectRevert((await gameAs(ctx, W.other)).write.placeBetFor(args), "");
    await (await gameAs(ctx, W.operator)).write.placeBetFor(args);
    const seat = (await ctx.game.read.getSeat([roundId, 2])) as any;
    expect(seat.player.toLowerCase()).to.equal(player.toLowerCase());
    expect(seat.actionSigner).to.equal(ZERO_ADDRESS);
  });

  it("locks only open rounds with seats, and requests one word", async () => {
    const ctx = await setup();
    const op = await gameAs(ctx, W.operator);
    const { roundId } = await openRound(ctx);
    await expectRevert(op.write.lockRound([roundId]), "NoSeatsTaken");
    await bet(ctx, W.playerA, roundId, 0);
    await expectRevert((await gameAs(ctx, W.other)).write.lockRound([roundId]), "NotGameOperator");
    await op.write.lockRound([roundId]);
    await expectRevert(op.write.lockRound([roundId]), "InvalidRound");
    const r = (await ctx.game.read.getRound([roundId])) as any;
    expect(r.status).to.equal(ST.Locked);
    expect(r.requestId > 0n).to.equal(true);
    const ev = await events(ctx, "RoundLocked");
    expect(Number(ev[0].args.seatCount)).to.equal(1);
  });
});

describe("BlackjackTableGame — extra wagers", () => {
  it("double / split / insurance: one each, conflicts, ownership, only while locked", async () => {
    const ctx = await setup();
    const { roundId } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0);
    await bet(ctx, W.playerB, roundId, 1);
    const a = await gameAs(ctx, W.playerA);
    await expectRevert(a.write.addWager([roundId, 0, KIND.Double]), "InvalidRound");
    await (await gameAs(ctx, W.operator)).write.lockRound([roundId]);
    await expectRevert(a.write.addWager([roundId, 1, KIND.Double]), "Unauthorized");
    await expectRevert(a.write.addWager([roundId, 4, KIND.Double]), "Unauthorized");
    const before = await balanceOf(ctx, addr(W.playerA));
    await a.write.addWager([roundId, 0, KIND.Insurance]);
    await expectRevert(a.write.addWager([roundId, 0, KIND.Insurance]), "WagerAlreadyAdded");
    await a.write.addWager([roundId, 0, KIND.Double]);
    await expectRevert(a.write.addWager([roundId, 0, KIND.Double]), "WagerAlreadyAdded");
    await expectRevert(a.write.addWager([roundId, 0, KIND.Split]), "WagerConflict");
    expect(before - (await balanceOf(ctx, addr(W.playerA)))).to.equal(STAKE / 2n + STAKE);
    const b = await gameAs(ctx, W.playerB);
    await b.write.addWager([roundId, 1, KIND.Split]);
    await expectRevert(b.write.addWager([roundId, 1, KIND.Split]), "WagerAlreadyAdded");
    await expectRevert(b.write.addWager([roundId, 1, KIND.Double]), "WagerConflict");
    expect(await ctx.game.read.seatWagered([roundId, 0])).to.equal(STAKE * 2n + STAKE / 2n);
    expect(await ctx.game.read.seatWagered([roundId, 1])).to.equal(STAKE * 2n);
    const ev = await events(ctx, "WagerAdded");
    expect(ev).to.have.length(3);
  });

  it("relays an extra wager signed by the session key", async () => {
    const ctx = await setup();
    const { roundId } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0);
    await (await gameAs(ctx, W.operator)).write.lockRound([roundId]);
    const hub = await env.viem.getContractAt("AuthHub", ctx.authHub.address, { client: { wallet: walletClients[W.playerA] } });
    await hub.write.authorize([addr(W.sessionA), 0n, 0n]);
    const player = addr(W.playerA);
    const nonce = (await ctx.game.read.actionNonces([player])) as bigint;
    const deadline = (await nowOnChain()) + 3600n;
    const signature = await walletClients[W.sessionA].signTypedData({
      domain: domain(ctx),
      types: {
        AddWager: [
          { name: "game", type: "address" },
          { name: "player", type: "address" },
          { name: "roundId", type: "uint256" },
          { name: "seat", type: "uint8" },
          { name: "kind", type: "uint8" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "AddWager",
      message: { game: ctx.game.address, player, roundId, seat: 0, kind: KIND.Double, nonce, deadline },
    });
    await (await gameAs(ctx, W.operator)).write.addWagerFor([player, roundId, 0, KIND.Double, nonce, deadline, signature]);
    expect(((await ctx.game.read.getSeat([roundId, 0])) as any).doubled).to.equal(true);
  });
});

describe("BlackjackTableGame — settle", () => {
  it("three seats, three kinds of signer: replays the table and pays every seat", async () => {
    const ctx = await setup();
    const { roundId, serverSeed } = await openRound(ctx);
    const keyB = privateKeyToAccount(generatePrivateKey());
    const hub = await env.viem.getContractAt("AuthHub", ctx.authHub.address, { client: { wallet: walletClients[W.playerC] } });
    await hub.write.authorize([addr(W.sessionB), 0n, 0n]);
    await bet(ctx, W.playerA, roundId, 1, { side: parseEther("0.1") });
    await bet(ctx, W.playerB, roundId, 3, { signer: keyB.address });
    await bet(ctx, W.playerC, roundId, 5);
    const inputs: SeatInput[] = [
      { seat: 1, stake: STAKE, sideBet: parseEther("0.1") },
      { seat: 3, stake: STAKE, sideBet: 0n },
      { seat: 5, stake: STAKE, sideBet: 0n },
    ];
    const { seed } = await lockAndDeal(ctx, roundId, serverSeed, inputs, (r) => r.phase === "playing" && r.seats.every((s) => !s.natural));
    const run = freshRun(seed, inputs);
    const expected = playOut(run, (r, seat) => {
      const s = r.seatState(seat);
      return s.hands[s.activeHand]!.cards.length < 3 && r.legalActions(seat).includes(Action.HIT) && seat === 1 ? Action.HIT : Action.STAND;
    });
    const before = await Promise.all(PLAYERS.map((p) => balanceOf(ctx, addr(p))));
    const signers = new Map([
      [1, { signer: signerOf(W.playerA), player: addr(W.playerA) }],
      [3, { signer: keyB as unknown as Signer, player: addr(W.playerB) }],
      [5, { signer: signerOf(W.sessionB), player: addr(W.playerC) }],
    ]);
    const ps = await plays(ctx, roundId, run, signers);
    const op = await gameAs(ctx, W.operator);
    const sim = await publicClient.simulateContract({ address: ctx.game.address, abi: ctx.game.abi, functionName: "settle", args: [roundId, serverSeed, ps], account: addr(W.operator) } as any);
    const totalExpected = expected.seats.reduce((a, s) => a + s.payout, 0n);
    expect(sim.result).to.equal(totalExpected);
    const rc = await receipt(await op.write.settle([roundId, serverSeed, ps]));
    console.log(`      settle gas (3 seats): ${rc.gasUsed}`);
    const after = await Promise.all(PLAYERS.map((p) => balanceOf(ctx, addr(p))));
    expected.seats.forEach((s, i) => expect(after[i]! - before[i]!, `seat ${s.seat}`).to.equal(s.payout));
    const r = (await ctx.game.read.getRound([roundId])) as any;
    expect(r.status).to.equal(ST.Settled);
    expect(await ctx.game.read.currentRoundOf([0])).to.equal(0n);
    expect(await ctx.game.read.activeRoundOf([addr(W.playerA)])).to.equal(0n);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    const settled = await events(ctx, "SeatSettled");
    expect(settled.map((e) => Number(e.args.seat))).to.deep.equal([1, 3, 5]);
    const rs = await events(ctx, "RoundSettled");
    expect(rs[0].args.serverSeed).to.equal(serverSeed);
    expect(rs[0].args.totalPayout).to.equal(totalExpected);
    const env1 = await events(ctx, "BetSettled");
    expect(env1).to.have.length(3);
    await expectRevert(op.write.settle([roundId, serverSeed, ps]), "InvalidRound");
    // the table is free again
    await openRound(ctx, 0);
  });

  it("timeouts: after the signed prefix the operator may only stand / decline insurance", async () => {
    const ctx = await setup();
    const { roundId, serverSeed } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0);
    await bet(ctx, W.playerB, roundId, 6);
    const inputs: SeatInput[] = [
      { seat: 0, stake: STAKE, sideBet: 0n },
      { seat: 6, stake: STAKE, sideBet: 0n },
    ];
    const { seed } = await lockAndDeal(ctx, roundId, serverSeed, inputs, (r) => {
      if (r.phase !== "playing" || r.seats.some((s) => s.natural)) return false;
      const h = r.seats[0]!.hands[0]!.cards;
      return h.length === 2 && r.legalActions(0).length === 2; // no double/split: a clean hit then stand
    });
    // seat 0: HIT (signed), then timed out → STAND (auto). seat 6: never acted → STAND (auto, signedLen 0)
    const run = freshRun(seed, inputs);
    run.apply(0, Action.HIT);
    if (!run.seatState(0).done) run.apply(0, Action.STAND);
    if (run.phase === "playing") run.apply(6, Action.STAND);
    const expected = run.finish();
    const seat0Signed = 1;
    const ps = [
      {
        seat: 0,
        actions: actionsToBytes(run.seatState(0).actions),
        signedLen: seat0Signed,
        signature: await seatSig(ctx, signerOf(W.playerA), addr(W.playerA), roundId, 0, run.seatState(0).actions.slice(0, seat0Signed)),
      },
      { seat: 6, actions: actionsToBytes(run.seatState(6).actions), signedLen: 0, signature: "0x" as Hex },
    ];
    const op = await gameAs(ctx, W.operator);
    // an unsigned HIT is refused
    const forged = [{ ...ps[0]!, signedLen: 0, signature: "0x" as Hex }, ps[1]!];
    await expectRevert(op.write.settle([roundId, serverSeed, forged]), "UnsignedAction");
    // a signature over a different log is refused
    const wrongSig = [{ ...ps[0]!, signature: await seatSig(ctx, signerOf(W.playerA), addr(W.playerA), roundId, 0, [Action.STAND]) }, ps[1]!];
    await expectRevert(op.write.settle([roundId, serverSeed, wrongSig]), "InvalidSeatSignature");
    // a stranger's signature is refused
    const stranger = [{ ...ps[0]!, signature: await seatSig(ctx, signerOf(W.other), addr(W.playerA), roundId, 0, [Action.HIT]) }, ps[1]!];
    await expectRevert(op.write.settle([roundId, serverSeed, stranger]), "InvalidSeatSignature");
    // signedLen beyond the log
    await expectRevert(op.write.settle([roundId, serverSeed, [{ ...ps[0]!, signedLen: 9 }, ps[1]!]]), "BadPlays");
    const before = await balanceOf(ctx, addr(W.playerA));
    await op.write.settle([roundId, serverSeed, ps]);
    expect((await balanceOf(ctx, addr(W.playerA))) - before).to.equal(expected.seats[0]!.payout);
    const settled = await events(ctx, "SeatSettled");
    expect(settled.map((e) => Number(e.args.signedLen))).to.deep.equal([1, 0]);
  });

  it("checks commit, random word and seat coverage", async () => {
    const ctx = await setup();
    const { roundId, serverSeed } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 2);
    await bet(ctx, W.playerB, roundId, 4);
    const op = await gameAs(ctx, W.operator);
    await expectRevert(op.write.settle([roundId, serverSeed, []]), "InvalidRound"); // still open
    await op.write.lockRound([roundId]);
    const stand = { actions: actionsToBytes([Action.STAND]), signedLen: 0, signature: "0x" as Hex };
    const two = [{ seat: 2, ...stand }, { seat: 4, ...stand }];
    await expectRevert(op.write.settle([roundId, serverSeed, two]), "RandomNotReady");
    const inputs: SeatInput[] = [
      { seat: 2, stake: STAKE, sideBet: 0n },
      { seat: 4, stake: STAKE, sideBet: 0n },
    ];
    const r = (await ctx.game.read.getRound([roundId])) as any;
    let word = 0n;
    for (let w = 1n; ; w++) {
      const seed = keccak256(encodePacked(["bytes32", "uint256", "uint256", "address"], [serverSeed, w, roundId, ctx.game.address]));
      const run = new TableRun(new KeccakShoe(seed), inputs);
      if (run.phase === "playing" && run.seats.every((s) => !s.natural)) {
        word = w;
        break;
      }
    }
    await ctx.coordinator.write.fulfill([ctx.provider.address, r.requestId, [word]]);
    await expectRevert(op.write.settle([roundId, freshServerSeed(), two]), "InvalidCommit");
    await expectRevert(op.write.settle([roundId, `0x${"0".repeat(64)}`, two]), "InvalidCommit");
    await expectRevert(op.write.settle([roundId, serverSeed, [two[0]!]]), "BadPlays");
    await expectRevert(op.write.settle([roundId, serverSeed, [two[1]!, two[0]!]]), "BadPlays");
    await expectRevert(op.write.settle([roundId, serverSeed, [two[0]!, { seat: 5, ...stand }]]), "BadPlays");
    await expectRevert((await gameAs(ctx, W.other)).write.settle([roundId, serverSeed, two]), "NotGameOperator");
    await op.write.settle([roundId, serverSeed, two]);
  });

  it("a split at first base and a double next to it, both funded on-chain, settle as the engine says", async () => {
    const ctx = await setup();
    const { roundId, serverSeed } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0);
    await bet(ctx, W.playerB, roundId, 1);
    const inputs: SeatInput[] = [
      { seat: 0, stake: STAKE, sideBet: 0n },
      { seat: 1, stake: STAKE, sideBet: 0n },
    ];
    const script = (r: TableRun): boolean => {
      if (r.phase !== "playing" || !r.legalActions(0).includes(Action.SPLIT) || r.seats[1]!.natural) return false;
      r.apply(0, Action.SPLIT);
      while (r.turnSeat === 0) r.apply(0, Action.STAND);
      return r.turnSeat === 1 && r.legalActions(1).includes(Action.DOUBLE);
    };
    const { seed } = await lockAndDeal(ctx, roundId, serverSeed, inputs, script);
    const run = freshRun(seed, inputs);
    script(run);
    run.apply(1, Action.DOUBLE);
    expect(run.phase).to.equal("finished");
    const expected = run.finish();
    const op = await gameAs(ctx, W.operator);
    const signers = new Map([
      [0, { signer: signerOf(W.playerA), player: addr(W.playerA) }],
      [1, { signer: signerOf(W.playerB), player: addr(W.playerB) }],
    ]);
    const ps = await plays(ctx, roundId, run, signers);
    // without the on-chain wagers the replay refuses the split / double
    await expectRevert(op.write.settle([roundId, serverSeed, ps]), "UnfundedAction");
    await (await gameAs(ctx, W.playerA)).write.addWager([roundId, 0, KIND.Split]);
    await expectRevert(op.write.settle([roundId, serverSeed, ps]), "UnfundedAction");
    await (await gameAs(ctx, W.playerB)).write.addWager([roundId, 1, KIND.Double]);
    const before = await Promise.all([W.playerA, W.playerB].map((p) => balanceOf(ctx, addr(p))));
    await op.write.settle([roundId, serverSeed, ps]);
    const after = await Promise.all([W.playerA, W.playerB].map((p) => balanceOf(ctx, addr(p))));
    expect(after[0]! - before[0]!).to.equal(expected.seats[0]!.payout);
    expect(after[1]! - before[1]!).to.equal(expected.seats[1]!.payout);
    expect(expected.seats[0]!.hands).to.have.length(2);
    expect(expected.seats[1]!.hands[0]!.bet).to.equal(2n * STAKE);
  });

  it("Perfect Pairs wins are paid from the free bankroll, never from other rounds' reserve", async () => {
    // a thin bankroll: the main game fits its lock, a perfect pair at 25:1 does not
    const ctx = await setup({ bankroll: 4n * ONE_EVA });
    const side = parseEther("0.25");
    const { roundId, serverSeed } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0, { side });
    const inputs: SeatInput[] = [{ seat: 0, stake: STAKE, sideBet: side }];
    const { seed } = await lockAndDeal(ctx, roundId, serverSeed, inputs, (r) => r.phase === "playing" && r.seats[0]!.sideBetOutcome === "perfect");
    const run = freshRun(seed, inputs);
    const expected = playOut(run);
    expect(expected.seats[0]!.sideBetPayout).to.equal(side * 26n);
    const ps = await plays(ctx, roundId, run, new Map([[0, { signer: signerOf(W.playerA), player: addr(W.playerA) }]]));
    const op = await gameAs(ctx, W.operator);
    // another table's round keeps its reserve out of reach
    const other = await openRound(ctx, 1);
    await bet(ctx, W.playerB, other.roundId, 0);
    await expectRevert(op.write.settle([roundId, serverSeed, ps]), "LiquidityShortfall");
    // topping up the bankroll lets the same settle through
    await ctx.token.write.transfer([ctx.game.address, 10n * ONE_EVA]);
    const before = await balanceOf(ctx, addr(W.playerA));
    await op.write.settle([roundId, serverSeed, ps]);
    expect((await balanceOf(ctx, addr(W.playerA))) - before).to.equal(expected.seats[0]!.payout);
    expect(await ctx.game.read.lockedExposure()).to.equal((STAKE * 5n) / 2n);
  });

  it("ace up with a dealer natural: insurance pays 2:1, an unused paid wager is refunded, naturals need no log", async () => {
    const ctx = await setup();
    const { roundId, serverSeed } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 2);
    await bet(ctx, W.playerB, roundId, 4);
    const inputs: SeatInput[] = [
      { seat: 2, stake: STAKE, sideBet: 0n },
      { seat: 4, stake: STAKE, sideBet: 0n },
    ];
    const { seed } = await lockAndDeal(ctx, roundId, serverSeed, inputs, (r) => r.phase === "insurance" && r.dealerNatural);
    const run = freshRun(seed, inputs);
    run.apply(2, Action.INSURE_YES);
    run.apply(4, Action.INSURE_NO);
    const expected = run.finish();
    await (await gameAs(ctx, W.playerA)).write.addWager([roundId, 2, KIND.Insurance]);
    // seat 4 paid a double it never got to play (the dealer had blackjack): refunded at settle
    await (await gameAs(ctx, W.playerB)).write.addWager([roundId, 4, KIND.Double]);
    const ps = await plays(ctx, roundId, run, new Map([
      [2, { signer: signerOf(W.playerA), player: addr(W.playerA) }],
      [4, { signer: signerOf(W.playerB), player: addr(W.playerB), signedLen: 0 }], // INSURE_NO by timeout
    ]));
    const before = await Promise.all([W.playerA, W.playerB].map((p) => balanceOf(ctx, addr(p))));
    await (await gameAs(ctx, W.operator)).write.settle([roundId, serverSeed, ps]);
    const after = await Promise.all([W.playerA, W.playerB].map((p) => balanceOf(ctx, addr(p))));
    expect(after[0]! - before[0]!).to.equal(expected.seats[0]!.payout);
    expect(expected.seats[0]!.insurancePayout).to.equal((STAKE / 2n) * 3n);
    // the seat-4 refund (unused double) is added by the contract on top of the engine's result
    expect(after[1]! - before[1]!).to.equal(expected.seats[1]!.payout + STAKE);
  });
});

describe("BlackjackTableGame — refunds", () => {
  it("operator closes an open round at any time and every seat gets its bet back", async () => {
    const ctx = await setup();
    const { roundId } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0, { side: parseEther("0.2") });
    await bet(ctx, W.playerB, roundId, 1);
    const before = await balanceOf(ctx, addr(W.playerA));
    await expectRevert((await gameAs(ctx, W.other)).write.cancelRound([roundId]), "TimeoutNotReached");
    await (await gameAs(ctx, W.operator)).write.cancelRound([roundId]);
    expect((await balanceOf(ctx, addr(W.playerA))) - before).to.equal(STAKE + parseEther("0.2"));
    const r = (await ctx.game.read.getRound([roundId])) as any;
    expect(r.status).to.equal(ST.Refunded);
    expect(await ctx.game.read.currentRoundOf([0])).to.equal(0n);
    expect(await ctx.game.read.activeRoundOf([addr(W.playerA)])).to.equal(0n);
    expect(await ctx.game.read.lockedExposure()).to.equal(0n);
    const rr = await events(ctx, "RoundRefunded");
    expect(rr[0].args.reason).to.equal(toHex("CLOSED", { size: 32 }));
    expect(await events(ctx, "SeatRefunded")).to.have.length(2);
    expect(await events(ctx, "BetFailed")).to.have.length(2);
    await expectRevert((await gameAs(ctx, W.operator)).write.cancelRound([roundId]), "InvalidRound");
  });

  it("locked round: operator after settleTimeout only if the word never came; anyone after refundTimeout, extras included", async () => {
    const ctx = await setup();
    const { roundId } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0);
    const op = await gameAs(ctx, W.operator);
    await op.write.lockRound([roundId]);
    await (await gameAs(ctx, W.playerA)).write.addWager([roundId, 0, KIND.Double]);
    await expectRevert(op.write.cancelRound([roundId]), "TimeoutNotReached");
    await env.networkHelpers.time.increase(TABLE.settleTimeout);
    const r = (await ctx.game.read.getRound([roundId])) as any;
    await ctx.coordinator.write.fulfill([ctx.provider.address, r.requestId, [7n]]);
    await expectRevert(op.write.cancelRound([roundId]), "RandomAlreadyFulfilled");
    await expectRevert((await gameAs(ctx, W.other)).write.cancelRound([roundId]), "TimeoutNotReached");
    await env.networkHelpers.time.increase(TABLE.refundTimeout);
    const before = await balanceOf(ctx, addr(W.playerA));
    await (await gameAs(ctx, W.other)).write.cancelRound([roundId]);
    expect((await balanceOf(ctx, addr(W.playerA))) - before).to.equal(STAKE * 2n);
    const rr = await events(ctx, "RoundRefunded");
    expect(rr[0].args.reason).to.equal(toHex("EXPIRED", { size: 32 }));
  });

  it("locked round without a word: operator refunds after settleTimeout", async () => {
    const ctx = await setup();
    const { roundId } = await openRound(ctx);
    await bet(ctx, W.playerA, roundId, 0);
    await bet(ctx, W.playerB, roundId, 1);
    const op = await gameAs(ctx, W.operator);
    await op.write.lockRound([roundId]);
    await (await gameAs(ctx, W.playerB)).write.addWager([roundId, 1, KIND.Insurance]);
    await (await gameAs(ctx, W.playerB)).write.addWager([roundId, 1, KIND.Split]);
    await env.networkHelpers.time.increase(TABLE.settleTimeout);
    const before = await balanceOf(ctx, addr(W.playerB));
    await op.write.cancelRound([roundId]);
    expect((await balanceOf(ctx, addr(W.playerB))) - before).to.equal(STAKE * 2n + STAKE / 2n);
  });
});
