import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
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

const MIN_BET = 0n;
const MAX_BET = 0n;

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
 * Symmetric multiplier table for `rows` rows. mults[k] == mults[rows - k].
 * Center is the lowest payout, edges are the highest. All values in MULTIPLIER_SCALE units (100 = 1.0x).
 */
function symmetricMults(rows: number): bigint[] {
  const arr: bigint[] = [];
  const center = Math.floor(rows / 2);
  for (let i = 0; i <= rows; i++) {
    const dist = Math.abs(i - center);
    arr.push(BigInt(50 + dist * 100)); // 0.5x at center, scales out by 1x per slot
  }
  return arr;
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
    handler.address,
    provider.address,
    token.address,
    authHub.address,
    opts.initialOperator ?? ZERO_ADDRESS,
    MIN_BET,
    MAX_BET,
  ]);

  // RandomProvider needs to know about Plinko as a consumer
  await provider.write.setConsumerStatus([plinko.address, true, 1n]);

  // Register Plinko on PaymentHandler
  await handler.write.registerGame([
    plinko.address,
    plinko.address,
    feeRecipient,
    HOUSE_BPS,
    REFERRAL_BPS,
    JACKPOT_BPS,
  ]);

  // AuthHub: operator + plinko spend tracker
  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([plinko.address, true]);

  // Plinko config: allow 4 rows, set symmetric multipliers
  await plinko.write.setAllowedRows([[4]]);
  await plinko.write.setMultipliers([4, 0, symmetricMults(4)]); // RiskLevel.Low = 0

  // Fund player + approve Plinko
  await token.write.transfer([player, HUNDRED_EVA * 10n]);
  const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerToken.write.approve([plinko.address, ONE_THOUSAND_EVA]);

  // Fund Plinko with bankroll for payouts
  await token.write.transfer([plinko.address, ONE_THOUSAND_EVA * 5n]);

  return { token, handler, provider, coordinator, authHub, plinko };
}

async function authorizeSessionKey(authHubAddress: `0x${string}`, spendCap: bigint = 0n, expiresAt: bigint = 0n) {
  const playerHub = await env.viem.getContractAt("AuthHub", authHubAddress, {
    client: { wallet: walletClients[1] },
  });
  await playerHub.write.authorize([sessionKey, expiresAt, spendCap]);
}

async function signPlaceBet(
  signerWallet: (typeof walletClients)[number],
  plinkoAddress: `0x${string}`,
  message: {
    game: `0x${string}`;
    player: `0x${string}`;
    betAmount: bigint;
    rows: number;
    risk: number;
    numDrops: number;
    potentialReferrer: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  },
) {
  return signerWallet.signTypedData({
    domain: {
      name: "Plinko",
      version: "1",
      chainId,
      verifyingContract: plinkoAddress,
    },
    types: {
      PlaceBet: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "betAmount", type: "uint256" },
        { name: "rows", type: "uint8" },
        { name: "risk", type: "uint8" },
        { name: "numDrops", type: "uint8" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PlaceBet",
    message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — constructor", () => {
  it("seeds initial operator when non-zero", async () => {
    const { plinko } = await setup({ initialOperator: operator });
    expect(await plinko.read.gameOperators([operator])).to.equal(true);
  });

  it("does not seed an operator when initialOperator = zero", async () => {
    const { plinko } = await setup();
    expect(await plinko.read.gameOperators([operator])).to.equal(false);
  });

  it("wires AuthHub and exposes EIP-712 domain separator", async () => {
    const { plinko, authHub } = await setup();
    expect((await plinko.read.authHub()).toLowerCase()).to.equal(authHub.address.toLowerCase());
    const sep = await plinko.read.domainSeparator();
    expect(sep).to.not.equal("0x" + "00".repeat(32));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// placeBet (direct path)
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — placeBet (direct)", () => {
  it("places a bet, locks exposure, emits BetPlaced, increments pending counters", async () => {
    const { plinko } = await setup();
    const playerPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[1] },
    });
    const txHash = await playerPlinko.write.placeBet([ONE_EVA, 4, 0, 1, ZERO_ADDRESS]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    expect(await plinko.read.pendingBetCount([player])).to.equal(1n);
    expect(await plinko.read.totalPendingBets()).to.equal(1n);

    const events = await plinko.getEvents.BetPlaced();
    const evt = events.find((e) => e.args.player?.toLowerCase() === player.toLowerCase());
    expect(evt, "BetPlaced not emitted").to.exist;
    expect(evt!.args.betAmount).to.equal(ONE_EVA);
    expect(evt!.args.rows).to.equal(4);
    expect(evt!.args.risk).to.equal(0);
    expect(evt!.args.numDrops).to.equal(1);
    expect(evt!.args.totalWager).to.equal(ONE_EVA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// placeBetFor (delegated path)
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — placeBetFor", () => {
  it("happy path: verifies signature, charges spend cap, increments nonce, emits same BetPlaced event", async () => {
    const { plinko, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address, HUNDRED_EVA);

    const t = await nowOnChain();
    const sig = await signPlaceBet(walletClients[2], plinko.address, {
      game: plinko.address,
      player,
      betAmount: ONE_EVA,
      rows: 4,
      risk: 0,
      numDrops: 1,
      potentialReferrer: ZERO_ADDRESS,
      nonce: 0n,
      deadline: t + 60n,
    });

    const opPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opPlinko.write.placeBetFor([
      player, ONE_EVA, 4, 0, 1, ZERO_ADDRESS, 0n, t + 60n, sig,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    expect(await plinko.read.pendingBetCount([player])).to.equal(1n);
    expect(await plinko.read.actionNonces([player])).to.equal(1n);
    expect(await authHub.read.remainingSpend([player])).to.equal(HUNDRED_EVA - ONE_EVA);

    const events = await plinko.getEvents.BetPlaced();
    const evt = events.find((e) => e.args.player?.toLowerCase() === player.toLowerCase());
    expect(evt, "BetPlaced not emitted via *For path").to.exist;
    expect(evt!.args.betAmount).to.equal(ONE_EVA);
  });

  it("rejects when caller is not a registered AuthHub operator", async () => {
    const { plinko, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signPlaceBet(walletClients[2], plinko.address, {
      game: plinko.address, player, betAmount: ONE_EVA, rows: 4, risk: 0, numDrops: 1, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const asOther = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(
      asOther.write.placeBetFor([player, ONE_EVA, 4, 0, 1, ZERO_ADDRESS, 0n, t + 60n, sig]),
    );
  });

  it("rejects a signature for a different game (cross-contract replay)", async () => {
    const { plinko, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const wrongGame = walletClients[8].account.address;
    const sig = await signPlaceBet(walletClients[2], plinko.address, {
      game: wrongGame, player, betAmount: ONE_EVA, rows: 4, risk: 0, numDrops: 1, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const opPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(
      opPlinko.write.placeBetFor([player, ONE_EVA, 4, 0, 1, ZERO_ADDRESS, 0n, t + 60n, sig]),
    );
  });

  it("rejects same nonce twice (replay protection)", async () => {
    const { plinko, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signPlaceBet(walletClients[2], plinko.address, {
      game: plinko.address, player, betAmount: ONE_EVA, rows: 4, risk: 0, numDrops: 1, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 600n,
    });
    const opPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    await opPlinko.write.placeBetFor([player, ONE_EVA, 4, 0, 1, ZERO_ADDRESS, 0n, t + 600n, sig]);
    await expectRevert(
      opPlinko.write.placeBetFor([player, ONE_EVA, 4, 0, 1, ZERO_ADDRESS, 0n, t + 600n, sig]),
    );
  });

  it("rejects when player has no session key", async () => {
    const { plinko } = await setup({ initialOperator: operator });
    const t = await nowOnChain();
    const sig = await signPlaceBet(walletClients[2], plinko.address, {
      game: plinko.address, player, betAmount: ONE_EVA, rows: 4, risk: 0, numDrops: 1, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const opPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(
      opPlinko.write.placeBetFor([player, ONE_EVA, 4, 0, 1, ZERO_ADDRESS, 0n, t + 60n, sig]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelExpiredBet (lifecycle, operator-gated)
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — cancelExpiredBet", () => {
  it("rejects non-operator caller", async () => {
    const { plinko } = await setup(); // no operator seeded
    await expectRevert(plinko.write.cancelExpiredBet([1n]));
  });

  it("rejects when called too early (BetNotExpired)", async () => {
    const { plinko } = await setup({ initialOperator: operator });
    const playerPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[1] },
    });
    await playerPlinko.write.placeBet([ONE_EVA, 4, 0, 1, ZERO_ADDRESS]);

    const opPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(opPlinko.write.cancelExpiredBet([1n]));
  });

  it("rejects unknown requestId (BetNotFound)", async () => {
    const { plinko } = await setup({ initialOperator: operator });
    const opPlinko = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(opPlinko.write.cancelExpiredBet([999n]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Operator setters smoke
// ─────────────────────────────────────────────────────────────────────────────

describe("Plinko — operator setters (smoke)", () => {
  it("owner can rotate operators", async () => {
    const { plinko } = await setup({ initialOperator: operator });
    await plinko.write.setGameOperator([operator, false]);
    expect(await plinko.read.gameOperators([operator])).to.equal(false);
    const opB = walletClients[7].account.address;
    await plinko.write.setGameOperators([[opB], true]);
    expect(await plinko.read.gameOperators([opB])).to.equal(true);
  });

  it("non-owner cannot rotate operators", async () => {
    const { plinko } = await setup();
    const asOther = await env.viem.getContractAt("Plinko", plinko.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setGameOperator([operator, true]), "Ownable: caller is not the owner");
  });
});
