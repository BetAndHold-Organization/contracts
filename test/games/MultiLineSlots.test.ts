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

const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 0;

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
});

async function nowOnChain(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

async function setup() {
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

  // MultiLineSlots constructor: (handler, provider, eva, authHub)
  const slots = await env.viem.deployContract("MultiLineSlots", [
    handler.address,
    provider.address,
    token.address,
    authHub.address,
  ]);

  await provider.write.setConsumerStatus([slots.address, true, 9n]);

  await handler.write.registerGame([
    slots.address, slots.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);

  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([slots.address, true]);

  // Configure 4 enabled symbols with simple weights and 3-match payouts.
  // Last symbol = wild. weights total to make sums small (game uses cumulative weight rolls).
  const sym = (w: number, three: number, two: number, isWild: boolean, enabled: boolean) => ({
    weightBps: w, threeMatchPayout: three, twoMatchPayout: two, isWild, enabled,
  });
  const symbols = [
    sym(2500, 200, 0, false, true),
    sym(2500, 500, 0, false, true),
    sym(2500, 1000, 0, false, true),
    sym(2500, 0, 0, true, true), // wild
    sym(0, 0, 0, false, false),
    sym(0, 0, 0, false, false),
    sym(0, 0, 0, false, false),
    sym(0, 0, 0, false, false),
  ];
  await slots.write.setAllSymbols([symbols as any]);

  // SlotsConfig: enabled, activeSymbolCount=4, min=0, max=0
  await slots.write.setSlotsConfig([{
    enabled: true, activeSymbolCount: 4, minWagerPerLine: 0n, maxWagerPerLine: 0n,
  } as any]);

  // Fund player + approve
  await token.write.transfer([player, HUNDRED_EVA * 5n]);
  const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerToken.write.approve([slots.address, ONE_THOUSAND_EVA]);

  // Bankroll
  await token.write.transfer([slots.address, ONE_THOUSAND_EVA * 5n]);

  return { token, handler, provider, coordinator, authHub, slots };
}

async function authorizeSessionKey(authHubAddress: `0x${string}`, spendCap: bigint = 0n, expiresAt: bigint = 0n) {
  const playerHub = await env.viem.getContractAt("AuthHub", authHubAddress, {
    client: { wallet: walletClients[1] },
  });
  await playerHub.write.authorize([sessionKey, expiresAt, spendCap]);
}

async function signStartSpin(
  signerWallet: (typeof walletClients)[number],
  slotsAddress: `0x${string}`,
  message: {
    game: `0x${string}`;
    player: `0x${string}`;
    wagerPerLine: bigint;
    paylineCount: number;
    potentialReferrer: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  },
) {
  return signerWallet.signTypedData({
    domain: {
      name: "MultiLineSlots",
      version: "1",
      chainId,
      verifyingContract: slotsAddress,
    },
    types: {
      StartSpin: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "wagerPerLine", type: "uint256" },
        { name: "paylineCount", type: "uint8" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartSpin",
    message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — constructor", () => {
  it("wires AuthHub and exposes EIP-712 domain separator", async () => {
    const { slots, authHub } = await setup();
    expect((await slots.read.authHub()).toLowerCase()).to.equal(authHub.address.toLowerCase());
    const sep = await slots.read.domainSeparator();
    expect(sep).to.not.equal("0x" + "00".repeat(32));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startSpin (direct)
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — startSpin (direct)", () => {
  it("places a spin and emits SpinStarted", async () => {
    const { slots } = await setup();
    const playerSlots = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[1] },
    });
    const txHash = await playerSlots.write.startSpin([ONE_EVA, 1, ZERO_ADDRESS]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const events = await slots.getEvents.SpinStarted();
    const evt = events.find((e) => e.args.player?.toLowerCase() === player.toLowerCase());
    expect(evt, "SpinStarted not emitted").to.exist;
    expect(evt!.args.activePaylines).to.equal(1);
    expect(evt!.args.wagerPerLine).to.equal(ONE_EVA);
    expect(evt!.args.totalWager).to.equal(ONE_EVA);
  });

  it("rejects an invalid payline count", async () => {
    const { slots } = await setup();
    const playerSlots = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(playerSlots.write.startSpin([ONE_EVA, 2, ZERO_ADDRESS]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startSpinFor
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLineSlots — startSpinFor", () => {
  it("happy path: verifies signature, charges spend cap, increments nonce, emits same SpinStarted event", async () => {
    const { slots, authHub } = await setup();
    await authorizeSessionKey(authHub.address, HUNDRED_EVA);

    const t = await nowOnChain();
    const sig = await signStartSpin(walletClients[2], slots.address, {
      game: slots.address,
      player,
      wagerPerLine: ONE_EVA,
      paylineCount: 1,
      potentialReferrer: ZERO_ADDRESS,
      nonce: 0n,
      deadline: t + 60n,
    });

    const opSlots = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opSlots.write.startSpinFor([
      player, ONE_EVA, 1, ZERO_ADDRESS, 0n, t + 60n, sig,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    expect(await slots.read.actionNonces([player])).to.equal(1n);
    // spendCap = HUNDRED_EVA, wager charged = ONE_EVA (totalWager == wagerPerLine for 1 line)
    expect(await authHub.read.remainingSpend([player])).to.equal(HUNDRED_EVA - ONE_EVA);

    const events = await slots.getEvents.SpinStarted();
    const evt = events.find((e) => e.args.player?.toLowerCase() === player.toLowerCase());
    expect(evt, "SpinStarted not emitted via *For").to.exist;
    expect(evt!.args.wagerPerLine).to.equal(ONE_EVA);
  });

  it("rejects when caller is not a registered AuthHub operator", async () => {
    const { slots, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signStartSpin(walletClients[2], slots.address, {
      game: slots.address, player, wagerPerLine: ONE_EVA, paylineCount: 1, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const asOther = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(
      asOther.write.startSpinFor([player, ONE_EVA, 1, ZERO_ADDRESS, 0n, t + 60n, sig]),
    );
  });

  it("rejects a signature with wrong game (cross-contract replay)", async () => {
    const { slots, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const wrongGame = walletClients[8].account.address;
    const sig = await signStartSpin(walletClients[2], slots.address, {
      game: wrongGame, player, wagerPerLine: ONE_EVA, paylineCount: 1, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const opSlots = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(
      opSlots.write.startSpinFor([player, ONE_EVA, 1, ZERO_ADDRESS, 0n, t + 60n, sig]),
    );
  });

  it("rejects same nonce twice (replay protection)", async () => {
    const { slots, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signStartSpin(walletClients[2], slots.address, {
      game: slots.address, player, wagerPerLine: ONE_EVA, paylineCount: 1, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 600n,
    });
    const opSlots = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[3] },
    });
    await opSlots.write.startSpinFor([player, ONE_EVA, 1, ZERO_ADDRESS, 0n, t + 600n, sig]);
    await expectRevert(
      opSlots.write.startSpinFor([player, ONE_EVA, 1, ZERO_ADDRESS, 0n, t + 600n, sig]),
    );
  });

  it("rejects when player has no session key", async () => {
    const { slots } = await setup();
    const t = await nowOnChain();
    const sig = await signStartSpin(walletClients[2], slots.address, {
      game: slots.address, player, wagerPerLine: ONE_EVA, paylineCount: 1, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const opSlots = await env.viem.getContractAt("MultiLineSlots", slots.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(
      opSlots.write.startSpinFor([player, ONE_EVA, 1, ZERO_ADDRESS, 0n, t + 60n, sig]),
    );
  });
});
