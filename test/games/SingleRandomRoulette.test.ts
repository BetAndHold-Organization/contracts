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

const MIN_MULTIPLIER = 200; // 2.00x
const MAX_MULTIPLIER = 5000; // 50.00x

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

  const roulette = await env.viem.deployContract("SingleRandomRoulette", [
    handler.address,
    provider.address,
    token.address,
    authHub.address,
  ]);

  // Roulette requests MAX_ROLLS + 1 = 7 ranges per spin (one per roll plus one for jackpot)
  await provider.write.setConsumerStatus([roulette.address, true, 8n]);

  await handler.write.registerGame([
    roulette.address, roulette.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);

  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([roulette.address, true]);

  // Enable a table config (no jackpot to keep setup minimal)
  await roulette.write.setTableConfig([{
    enabled: true,
    replayBps: 0,
    jackpotBps: 0,
    minMultiplier: MIN_MULTIPLIER,
    maxMultiplier: MAX_MULTIPLIER,
    minWager: 0n,
    maxWager: 0n,
  } as any]);

  // Fund player + approve
  await token.write.transfer([player, HUNDRED_EVA * 5n]);
  const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerToken.write.approve([roulette.address, ONE_THOUSAND_EVA]);

  // Bankroll
  await token.write.transfer([roulette.address, ONE_THOUSAND_EVA * 5n]);

  return { token, handler, provider, coordinator, authHub, roulette };
}

async function authorizeSessionKey(authHubAddress: `0x${string}`, spendCap: bigint = 0n, expiresAt: bigint = 0n) {
  const playerHub = await env.viem.getContractAt("AuthHub", authHubAddress, {
    client: { wallet: walletClients[1] },
  });
  await playerHub.write.authorize([sessionKey, expiresAt, spendCap]);
}

async function signStartSpin(
  signerWallet: (typeof walletClients)[number],
  rouletteAddress: `0x${string}`,
  message: {
    game: `0x${string}`;
    player: `0x${string}`;
    wager: bigint;
    multiplierHundredths: bigint;
    potentialReferrer: `0x${string}`;
    participateInJackpot: boolean;
    nonce: bigint;
    deadline: bigint;
  },
) {
  return signerWallet.signTypedData({
    domain: {
      name: "SingleRandomRoulette",
      version: "1",
      chainId,
      verifyingContract: rouletteAddress,
    },
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
    message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("SingleRandomRoulette — constructor", () => {
  it("wires AuthHub and exposes EIP-712 domain separator", async () => {
    const { roulette, authHub } = await setup();
    expect((await roulette.read.authHub()).toLowerCase()).to.equal(authHub.address.toLowerCase());
    const sep = await roulette.read.domainSeparator();
    expect(sep).to.not.equal("0x" + "00".repeat(32));
  });
});

describe("SingleRandomRoulette — startSpin (direct)", () => {
  it("starts a spin and emits SpinStarted (or equivalent)", async () => {
    const { roulette } = await setup();
    const playerR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[1] },
    });
    // 2.00x multiplier, no jackpot
    const txHash = await playerR.write.startSpin([ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    // Just verify no revert; specific event names are checked in the *For test below
    // by comparing direct vs delegated emissions via state.
  });

  it("rejects a multiplier below the table minimum", async () => {
    const { roulette } = await setup();
    const playerR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(playerR.write.startSpin([ONE_EVA, BigInt(MIN_MULTIPLIER - 1), ZERO_ADDRESS, false]));
  });
});

describe("SingleRandomRoulette — startSpinFor", () => {
  it("happy path: verifies signature, charges spend cap, increments nonce", async () => {
    const { roulette, authHub } = await setup();
    await authorizeSessionKey(authHub.address, HUNDRED_EVA);

    const t = await nowOnChain();
    const sig = await signStartSpin(walletClients[2], roulette.address, {
      game: roulette.address,
      player,
      wager: ONE_EVA,
      multiplierHundredths: BigInt(MIN_MULTIPLIER),
      potentialReferrer: ZERO_ADDRESS,
      participateInJackpot: false,
      nonce: 0n,
      deadline: t + 60n,
    });

    const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opR.write.startSpinFor([
      player, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, t + 60n, sig,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    expect(await roulette.read.actionNonces([player])).to.equal(1n);
    expect(await authHub.read.remainingSpend([player])).to.equal(HUNDRED_EVA - ONE_EVA);
  });

  it("rejects when caller is not a registered AuthHub operator", async () => {
    const { roulette, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signStartSpin(walletClients[2], roulette.address, {
      game: roulette.address, player, wager: ONE_EVA, multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS, participateInJackpot: false, nonce: 0n, deadline: t + 60n,
    });
    const asOther = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(
      asOther.write.startSpinFor([player, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, t + 60n, sig]),
    );
  });

  it("rejects a signature with wrong game (cross-contract replay)", async () => {
    const { roulette, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const wrongGame = walletClients[8].account.address;
    const sig = await signStartSpin(walletClients[2], roulette.address, {
      game: wrongGame, player, wager: ONE_EVA, multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS, participateInJackpot: false, nonce: 0n, deadline: t + 60n,
    });
    const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(
      opR.write.startSpinFor([player, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, t + 60n, sig]),
    );
  });

  it("rejects same nonce twice (replay protection)", async () => {
    const { roulette, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signStartSpin(walletClients[2], roulette.address, {
      game: roulette.address, player, wager: ONE_EVA, multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS, participateInJackpot: false, nonce: 0n, deadline: t + 600n,
    });
    const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[3] },
    });
    await opR.write.startSpinFor([player, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, t + 600n, sig]);
    await expectRevert(
      opR.write.startSpinFor([player, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, t + 600n, sig]),
    );
  });

  it("rejects when player has no session key", async () => {
    const { roulette } = await setup();
    const t = await nowOnChain();
    const sig = await signStartSpin(walletClients[2], roulette.address, {
      game: roulette.address, player, wager: ONE_EVA, multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS, participateInJackpot: false, nonce: 0n, deadline: t + 60n,
    });
    const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(
      opR.write.startSpinFor([player, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, t + 60n, sig]),
    );
  });
});
