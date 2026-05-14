import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS, MAX_BPS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let deployer: `0x${string}`;
let player: `0x${string}`;
let sessionKey: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;
let other: `0x${string}`;

const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 0;
const NET_BPS = Number(MAX_BPS) - HOUSE_BPS - REFERRAL_BPS - JACKPOT_BPS;

const GAME_ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

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
});

async function nowOnChain(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

/**
 * Full deployment with PaymentHandler + MLR + AuthHub + adapter, plus player funded.
 * - operator is allowlisted on AuthHub AND on the adapter's GameLifecycleRoles
 *   (the two roles are independent — adapter needs both for full delegated play)
 * - sessionKey is authorized on AuthHub for the player
 */
async function setup(opts: { initialOperator?: `0x${string}` } = {}) {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  await mlr.write.setLevels([1, [10000]]);
  await mlr.write.setPaymentHandler([handler.address]);
  await handler.write.setReferralContract([mlr.address]);

  const authHub = await env.viem.deployContract("AuthHub");

  const adapter = await env.viem.deployContract("PaymentOnlyGameAdapter", [
    token.address,
    handler.address,
    authHub.address,
    opts.initialOperator ?? ZERO_ADDRESS,
  ]);

  // Register the adapter as a game on PaymentHandler (payoutTarget = adapter itself).
  await handler.write.registerGame([
    adapter.address,
    adapter.address,
    feeRecipient,
    HOUSE_BPS,
    REFERRAL_BPS,
    JACKPOT_BPS,
  ]);

  // AuthHub: operator + adapter as spend tracker
  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([adapter.address, true]);

  // Player funded + approves the adapter (V5 flow: pull from player into game)
  await token.write.transfer([player, HUNDRED_EVA * 5n]);
  const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerToken.write.approve([adapter.address, ONE_THOUSAND_EVA]);

  // Fund the adapter with payout liquidity (so payWinner has tokens to send)
  await token.write.transfer([adapter.address, ONE_THOUSAND_EVA]);

  return { token, handler, mlr, authHub, adapter };
}

async function authorizeSessionKey(authHubAddress: `0x${string}`, spendCap: bigint = 0n, expiresAt: bigint = 0n) {
  const playerHub = await env.viem.getContractAt("AuthHub", authHubAddress, {
    client: { wallet: walletClients[1] },
  });
  await playerHub.write.authorize([sessionKey, expiresAt, spendCap]);
}

async function signPlay(
  signerWallet: (typeof walletClients)[number],
  adapterAddress: `0x${string}`,
  message: {
    game: `0x${string}`;
    player: `0x${string}`;
    amount: bigint;
    potentialReferrer: `0x${string}`;
    gameId: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  },
) {
  return signerWallet.signTypedData({
    domain: {
      name: "PaymentOnlyGameAdapter",
      version: "1",
      chainId,
      verifyingContract: adapterAddress,
    },
    types: {
      Play: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "potentialReferrer", type: "address" },
        { name: "gameId", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Play",
    message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("PaymentOnlyGameAdapter — constructor", () => {
  it("seeds initial game operator when non-zero", async () => {
    const { adapter } = await setup({ initialOperator: operator });
    expect(await adapter.read.gameOperators([operator])).to.equal(true);
  });

  it("does not auto-seed when initialOperator = address(0)", async () => {
    const { adapter } = await setup();
    expect(await adapter.read.gameOperators([operator])).to.equal(false);
  });

  it("wires AuthHub and exposes a non-zero EIP-712 domain separator", async () => {
    const { adapter, authHub } = await setup();
    expect((await adapter.read.authHub()).toLowerCase()).to.equal(authHub.address.toLowerCase());
    const sep = await adapter.read.domainSeparator();
    expect(sep).to.not.equal("0x" + "00".repeat(32));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// play (direct path — msg.sender drives)
// ─────────────────────────────────────────────────────────────────────────────

describe("PaymentOnlyGameAdapter — play (direct)", () => {
  it("collects bet, routes fees through handler, and emits GamePlayed", async () => {
    const { token, adapter, handler } = await setup();
    const playerAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[1] },
    });
    const before = await token.read.balanceOf([player]);
    const txHash = await playerAdapter.write.play([HUNDRED_EVA, ZERO_ADDRESS, GAME_ID]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const after = await token.read.balanceOf([player]);
    expect(before - after).to.equal(HUNDRED_EVA);

    const events = await adapter.getEvents.GamePlayed();
    const evt = events.find((e) => e.args.player?.toLowerCase() === player.toLowerCase());
    expect(evt, "GamePlayed not emitted").to.exist;
    expect(evt!.args.amountPaid).to.equal(HUNDRED_EVA);
    expect(evt!.args.netAmount).to.equal((HUNDRED_EVA * BigInt(NET_BPS)) / MAX_BPS);
    expect(evt!.args.gameId).to.equal(GAME_ID);
  });

  it("reverts on amount = 0", async () => {
    const { adapter } = await setup();
    const playerAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(playerAdapter.write.play([0n, ZERO_ADDRESS, GAME_ID]), "amount=0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// playFor (delegated path)
// ─────────────────────────────────────────────────────────────────────────────

describe("PaymentOnlyGameAdapter — playFor", () => {
  it("happy path: verifies signature, charges spend cap, increments nonce, emits same GamePlayed event", async () => {
    const { token, adapter, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address, HUNDRED_EVA * 2n);

    const t = await nowOnChain();
    const sig = await signPlay(walletClients[2], adapter.address, {
      game: adapter.address,
      player,
      amount: HUNDRED_EVA,
      potentialReferrer: ZERO_ADDRESS,
      gameId: GAME_ID,
      nonce: 0n,
      deadline: t + 60n,
    });

    const opAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[3] },
    });
    const before = await token.read.balanceOf([player]);
    const txHash = await opAdapter.write.playFor([
      player, HUNDRED_EVA, ZERO_ADDRESS, GAME_ID, 0n, t + 60n, sig,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const after = await token.read.balanceOf([player]);

    expect(before - after).to.equal(HUNDRED_EVA);
    expect(await adapter.read.actionNonces([player])).to.equal(1n);
    // Spend cap was HUNDRED_EVA * 2; after spending HUNDRED_EVA, remaining = HUNDRED_EVA.
    expect(await authHub.read.remainingSpend([player])).to.equal(HUNDRED_EVA);

    const events = await adapter.getEvents.GamePlayed();
    const evt = events.find((e) => e.args.player?.toLowerCase() === player.toLowerCase());
    expect(evt, "GamePlayed not emitted").to.exist;
    expect(evt!.args.amountPaid).to.equal(HUNDRED_EVA);
    expect(evt!.args.netAmount).to.equal((HUNDRED_EVA * BigInt(NET_BPS)) / MAX_BPS);
    expect(evt!.args.gameId).to.equal(GAME_ID);
  });

  it("rejects when caller is not a registered AuthHub operator", async () => {
    const { adapter, authHub } = await setup(); // no initialOperator on adapter, but doesn't matter
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signPlay(walletClients[2], adapter.address, {
      game: adapter.address, player, amount: ONE_EVA, potentialReferrer: ZERO_ADDRESS, gameId: GAME_ID, nonce: 0n, deadline: t + 60n,
    });
    const asOther = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(
      asOther.write.playFor([player, ONE_EVA, ZERO_ADDRESS, GAME_ID, 0n, t + 60n, sig]),
    );
  });

  it("rejects a signature for a different game (replay across games)", async () => {
    const { adapter, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    // Sign with a wrong `game` field — typehash binding includes the game address.
    // Any valid (checksum) address that isn't the adapter works as the wrong target.
    const wrongGame = walletClients[8].account.address;
    const sig = await signPlay(walletClients[2], adapter.address, {
      game: wrongGame,
      player,
      amount: ONE_EVA,
      potentialReferrer: ZERO_ADDRESS,
      gameId: GAME_ID,
      nonce: 0n,
      deadline: t + 60n,
    });
    const opAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(
      opAdapter.write.playFor([player, ONE_EVA, ZERO_ADDRESS, GAME_ID, 0n, t + 60n, sig]),
    );
  });

  it("rejects when player has no session key registered", async () => {
    const { adapter } = await setup({ initialOperator: operator });
    const t = await nowOnChain();
    const sig = await signPlay(walletClients[2], adapter.address, {
      game: adapter.address, player, amount: ONE_EVA, potentialReferrer: ZERO_ADDRESS, gameId: GAME_ID, nonce: 0n, deadline: t + 60n,
    });
    const opAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(
      opAdapter.write.playFor([player, ONE_EVA, ZERO_ADDRESS, GAME_ID, 0n, t + 60n, sig]),
    );
  });

  it("rejects same nonce twice (replay protection)", async () => {
    const { adapter, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signPlay(walletClients[2], adapter.address, {
      game: adapter.address, player, amount: ONE_EVA, potentialReferrer: ZERO_ADDRESS, gameId: GAME_ID, nonce: 0n, deadline: t + 600n,
    });
    const opAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[3] },
    });
    await opAdapter.write.playFor([player, ONE_EVA, ZERO_ADDRESS, GAME_ID, 0n, t + 600n, sig]);
    // Replay attempt with the same nonce
    await expectRevert(
      opAdapter.write.playFor([player, ONE_EVA, ZERO_ADDRESS, GAME_ID, 0n, t + 600n, sig]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// payWinner (lifecycle op, operator-gated)
// ─────────────────────────────────────────────────────────────────────────────

describe("PaymentOnlyGameAdapter — payWinner", () => {
  it("pays the winner and emits WinnerPaid when called by an operator", async () => {
    const { token, adapter } = await setup({ initialOperator: operator });
    const opAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[3] },
    });
    const before = await token.read.balanceOf([player]);
    const txHash = await opAdapter.write.payWinner([player, ONE_EVA]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const after = await token.read.balanceOf([player]);
    expect(after - before).to.equal(ONE_EVA);

    const events = await adapter.getEvents.WinnerPaid();
    expect(
      events.find((e) => e.args.player?.toLowerCase() === player.toLowerCase()),
      "WinnerPaid not emitted",
    ).to.exist;
  });

  it("rejects non-operator caller (modifier check)", async () => {
    const { adapter } = await setup(); // no operator seeded — owner is not auto-operator
    await expectRevert(adapter.write.payWinner([player, ONE_EVA]));
  });

  it("reverts on zero player address", async () => {
    const { adapter } = await setup({ initialOperator: operator });
    const opAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(opAdapter.write.payWinner([ZERO_ADDRESS, ONE_EVA]), "bad player");
  });

  it("reverts on zero amount", async () => {
    const { adapter } = await setup({ initialOperator: operator });
    const opAdapter = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(opAdapter.write.payWinner([player, 0n]), "amount=0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withdraw (treasury sweep, owner-gated)
// ─────────────────────────────────────────────────────────────────────────────

describe("PaymentOnlyGameAdapter — withdraw", () => {
  it("owner can sweep tokens to a recipient", async () => {
    const { token, adapter } = await setup();
    const recipient = walletClients[7].account.address;
    const before = await token.read.balanceOf([recipient]);
    await adapter.write.withdraw([recipient, ONE_EVA]);
    const after = await token.read.balanceOf([recipient]);
    expect(after - before).to.equal(ONE_EVA);
  });

  it("rejects non-owner caller", async () => {
    const { adapter } = await setup();
    const asOther = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.withdraw([other, ONE_EVA]), "Ownable: caller is not the owner");
  });

  it("rejects zero recipient", async () => {
    const { adapter } = await setup();
    await expectRevert(adapter.write.withdraw([ZERO_ADDRESS, ONE_EVA]), "bad to");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Operator allowlist setters (smoke; full coverage is in GameLifecycleRoles tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("PaymentOnlyGameAdapter — operator setters (smoke)", () => {
  it("owner can rotate operators via setGameOperator and setGameOperators", async () => {
    const { adapter } = await setup({ initialOperator: operator });
    await adapter.write.setGameOperator([operator, false]);
    expect(await adapter.read.gameOperators([operator])).to.equal(false);

    const opB = walletClients[7].account.address;
    const opC = walletClients[8].account.address;
    await adapter.write.setGameOperators([[opB, opC], true]);
    expect(await adapter.read.gameOperators([opB])).to.equal(true);
    expect(await adapter.read.gameOperators([opC])).to.equal(true);
  });

  it("non-owner cannot rotate operators", async () => {
    const { adapter } = await setup();
    const asOther = await env.viem.getContractAt("PaymentOnlyGameAdapter", adapter.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setGameOperator([operator, true]), "Ownable: caller is not the owner");
  });
});
