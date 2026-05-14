import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { encodeFunctionData, decodeEventLog, parseAbi } from "viem";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../../helpers/constants.js";
import { expectRevert } from "../../helpers/utils.js";

/**
 * multicallTry is a BaseGame primitive. We exercise it through SingleRandomRoulette
 * because the operator-relayed startSpinFor flow is the canonical use case.
 *
 * Scenario: three players queue signed startSpin actions; the operator bundles them
 * into one multicallTry call. The middle action carries a stale nonce, so it must
 * revert in isolation without affecting the other two.
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;

let playerA: `0x${string}`;
let playerB: `0x${string}`;
let playerC: `0x${string}`;

const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 0;
const MIN_MULTIPLIER = 200;
const MAX_MULTIPLIER = 5000;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();

  operator = walletClients[3].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;

  // Three distinct players, each with a distinct session key wallet.
  // playerA / skA = walletClients[1] / walletClients[2]
  // playerB / skB = walletClients[6] / walletClients[7]
  // playerC / skC = walletClients[8] / walletClients[9]
  playerA = walletClients[1].account.address;
  playerB = walletClients[6].account.address;
  playerC = walletClients[8].account.address;
});

async function nowOnChain(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
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
    handler.address, provider.address, token.address, authHub.address,
  ]);

  await provider.write.setConsumerStatus([roulette.address, true, 8n]);
  await handler.write.registerGame([
    roulette.address, roulette.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([roulette.address, true]);
  await roulette.write.setTableConfig([{
    enabled: true, replayBps: 0, jackpotBps: 0,
    minMultiplier: MIN_MULTIPLIER, maxMultiplier: MAX_MULTIPLIER,
    minWager: 0n, maxWager: 0n,
  } as any]);

  // Fund + approve for each player
  for (const [p, w] of [
    [playerA, walletClients[1]],
    [playerB, walletClients[6]],
    [playerC, walletClients[8]],
  ] as const) {
    await token.write.transfer([p, HUNDRED_EVA * 5n]);
    const pt = await env.viem.getContractAt("EverValueCoin", token.address, { client: { wallet: w } });
    await pt.write.approve([roulette.address, ONE_THOUSAND_EVA]);
  }

  // Bankroll
  await token.write.transfer([roulette.address, ONE_THOUSAND_EVA * 5n]);

  return { token, handler, provider, coordinator, authHub, roulette };
}

async function authorizeSessionKey(
  authHubAddress: `0x${string}`,
  playerWallet: (typeof walletClients)[number],
  sessionKeyAddr: `0x${string}`,
  spendCap: bigint,
) {
  const hub = await env.viem.getContractAt("AuthHub", authHubAddress, {
    client: { wallet: playerWallet },
  });
  await hub.write.authorize([sessionKeyAddr, 0n, spendCap]);
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
    domain: { name: "SingleRandomRoulette", version: "1", chainId, verifyingContract: rouletteAddress },
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

const startSpinForAbi = parseAbi([
  "function startSpinFor(address player, uint256 wager, uint256 multiplierHundredths, address potentialReferrer, bool participateInJackpot, uint256 nonce, uint256 deadline, bytes signature)",
]);

describe("BaseGame.multicallTry — via SingleRandomRoulette", () => {
  it("partial success: 2 of 3 sub-calls land, 1 stale-nonce sub-call reverts in isolation", async () => {
    const { roulette, authHub, token } = await setup();

    // Each player authorizes their session key (operator submits, session key signs).
    await authorizeSessionKey(authHub.address, walletClients[1], walletClients[2].account.address, HUNDRED_EVA);
    await authorizeSessionKey(authHub.address, walletClients[6], walletClients[7].account.address, HUNDRED_EVA);
    await authorizeSessionKey(authHub.address, walletClients[8], walletClients[9].account.address, HUNDRED_EVA);

    const deadline = (await nowOnChain()) + 60n;

    // Player A: correct nonce 0
    const sigA = await signStartSpin(walletClients[2], roulette.address, {
      game: roulette.address, player: playerA, wager: ONE_EVA * 5n,
      multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS,
      participateInJackpot: false, nonce: 0n, deadline,
    });
    // Player B: STALE nonce 99 (on-chain is 0)
    const sigB = await signStartSpin(walletClients[7], roulette.address, {
      game: roulette.address, player: playerB, wager: ONE_EVA * 10n,
      multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS,
      participateInJackpot: false, nonce: 99n, deadline,
    });
    // Player C: correct nonce 0
    const sigC = await signStartSpin(walletClients[9], roulette.address, {
      game: roulette.address, player: playerC, wager: ONE_EVA * 2n,
      multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS,
      participateInJackpot: false, nonce: 0n, deadline,
    });

    const callA = encodeFunctionData({
      abi: startSpinForAbi, functionName: "startSpinFor",
      args: [playerA, ONE_EVA * 5n, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, deadline, sigA],
    });
    const callB = encodeFunctionData({
      abi: startSpinForAbi, functionName: "startSpinFor",
      args: [playerB, ONE_EVA * 10n, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 99n, deadline, sigB],
    });
    const callC = encodeFunctionData({
      abi: startSpinForAbi, functionName: "startSpinFor",
      args: [playerC, ONE_EVA * 2n, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, deadline, sigC],
    });

    const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[3] },
    });

    const balABefore = await token.read.balanceOf([playerA]);
    const balBBefore = await token.read.balanceOf([playerB]);
    const balCBefore = await token.read.balanceOf([playerC]);

    const txHash = await opR.write.multicallTry([[callA, callB, callC]], { gas: 5_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // ── Final state — A and C settled, B untouched ────────────────────────────

    // ── Final state — A and C settled, B untouched ────────────────────────────
    expect(await roulette.read.actionNonces([playerA])).to.equal(1n);
    expect(await roulette.read.actionNonces([playerB])).to.equal(0n); // revert rolled back
    expect(await roulette.read.actionNonces([playerC])).to.equal(1n);

    expect(await authHub.read.remainingSpend([playerA])).to.equal(HUNDRED_EVA - ONE_EVA * 5n);
    expect(await authHub.read.remainingSpend([playerB])).to.equal(HUNDRED_EVA); // never charged
    expect(await authHub.read.remainingSpend([playerC])).to.equal(HUNDRED_EVA - ONE_EVA * 2n);

    expect(await token.read.balanceOf([playerA])).to.equal(balABefore - ONE_EVA * 5n);
    expect(await token.read.balanceOf([playerB])).to.equal(balBBefore); // untouched
    expect(await token.read.balanceOf([playerC])).to.equal(balCBefore - ONE_EVA * 2n);

    // ── MulticallSubCallFailed emitted exactly once, for index 1 ──────────────
    const failedEventAbi = parseAbi([
      "event MulticallSubCallFailed(uint256 indexed index, bytes returnData)",
    ]);
    const failedLogs = receipt.logs
      .map((l) => {
        try {
          return decodeEventLog({ abi: failedEventAbi, data: l.data, topics: l.topics });
        } catch {
          return null;
        }
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);

    expect(failedLogs.length).to.equal(1);
    expect(failedLogs[0].args.index).to.equal(1n);
  });

  it("all-success: every sub-call lands, no MulticallSubCallFailed event", async () => {
    const { roulette, authHub } = await setup();

    await authorizeSessionKey(authHub.address, walletClients[1], walletClients[2].account.address, HUNDRED_EVA);
    await authorizeSessionKey(authHub.address, walletClients[6], walletClients[7].account.address, HUNDRED_EVA);

    const deadline = (await nowOnChain()) + 60n;

    const sigA = await signStartSpin(walletClients[2], roulette.address, {
      game: roulette.address, player: playerA, wager: ONE_EVA,
      multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS,
      participateInJackpot: false, nonce: 0n, deadline,
    });
    const sigB = await signStartSpin(walletClients[7], roulette.address, {
      game: roulette.address, player: playerB, wager: ONE_EVA,
      multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS,
      participateInJackpot: false, nonce: 0n, deadline,
    });

    const callA = encodeFunctionData({
      abi: startSpinForAbi, functionName: "startSpinFor",
      args: [playerA, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, deadline, sigA],
    });
    const callB = encodeFunctionData({
      abi: startSpinForAbi, functionName: "startSpinFor",
      args: [playerB, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, deadline, sigB],
    });

    const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opR.write.multicallTry([[callA, callB]], { gas: 5_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    expect(await roulette.read.actionNonces([playerA])).to.equal(1n);
    expect(await roulette.read.actionNonces([playerB])).to.equal(1n);

    const failedEventAbi = parseAbi([
      "event MulticallSubCallFailed(uint256 indexed index, bytes returnData)",
    ]);
    const failedLogs = receipt.logs.filter((l) => {
      try {
        decodeEventLog({ abi: failedEventAbi, data: l.data, topics: l.topics });
        return true;
      } catch {
        return false;
      }
    });
    expect(failedLogs.length).to.equal(0);
  });

  it("gated: a non-operator caller is rejected at the wrapper with NotAuthorizedMulticaller", async () => {
    const { roulette, authHub } = await setup();
    await authorizeSessionKey(authHub.address, walletClients[1], walletClients[2].account.address, HUNDRED_EVA);

    const deadline = (await nowOnChain()) + 60n;
    const sigA = await signStartSpin(walletClients[2], roulette.address, {
      game: roulette.address, player: playerA, wager: ONE_EVA,
      multiplierHundredths: BigInt(MIN_MULTIPLIER), potentialReferrer: ZERO_ADDRESS,
      participateInJackpot: false, nonce: 0n, deadline,
    });
    const callA = encodeFunctionData({
      abi: startSpinForAbi, functionName: "startSpinFor",
      args: [playerA, ONE_EVA, BigInt(MIN_MULTIPLIER), ZERO_ADDRESS, false, 0n, deadline, sigA],
    });

    // Caller is walletClients[6] — NOT a registered AuthHub operator. The wrapper
    // itself reverts now (no per-sub-call execution, no event-spam vector).
    const griefer = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(griefer.write.multicallTry([[callA]]));

    // No state change anywhere.
    expect(await roulette.read.actionNonces([playerA])).to.equal(0n);
    expect(await authHub.read.remainingSpend([playerA])).to.equal(HUNDRED_EVA);
  });

  it("empty batch: returns empty arrays without error", async () => {
    const { roulette } = await setup();
    const opR = await env.viem.getContractAt("SingleRandomRoulette", roulette.address, {
      client: { wallet: walletClients[3] },
    });
    const txHash = await opR.write.multicallTry([[]]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  });
});
