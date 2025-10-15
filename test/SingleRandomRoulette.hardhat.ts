import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { decodeEventLog, encodeAbiParameters, keccak256, parseAbiItem, parseAbiParameters, parseEther, parseEventLogs, toHex } from "viem";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";

import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";

const HASH_ABI = parseAbiParameters("uint256 seed,uint256 salt");
const BPS = 10_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_DERIVED_ROLLS = 7; // 6 game rolls + 1 jackpot roll

const RANDOM_REQUESTED_EVENT = parseAbiItem(
  "event RandomWordsRequested(uint256 indexed requestId, address indexed consumer, uint256 rangeCount, uint256 gasLimit, (uint128 min, uint128 max)[] ranges)"
);

const SPIN_STARTED_EVENT = parseAbiItem(
  "event SpinStarted(uint256 indexed requestId, address indexed player, uint256 wager, uint256 netStake, uint256 multiplierHundredths, uint256 maxPayout, uint256 jackpotContribution, uint32 configIndex)"
);

const ENTRY_PROCESSED_EVENT = parseAbiItem(
  "event EntryProcessed(uint256 indexed entryId, address indexed game, address indexed player, uint8 tierIndex, uint8 outcomeIndex, uint256 payout)"
);

const SPIN_RESOLVED_EVENT = parseAbiItem(
  "event SpinResolved(uint256 indexed requestId, address indexed player, uint256 wager, uint256 netStake, uint256 multiplierHundredths, uint256 maxPayout, uint256 jackpotContribution, uint32 configIndex)"
);

type HardhatConnection = Awaited<ReturnType<typeof network.connect>>;
type Viem = HardhatConnection["viem"];
type WalletClient = Awaited<ReturnType<Viem["getWalletClients"]>>[number];
type PublicClient = Awaited<ReturnType<Viem["getPublicClient"]>>;

type TokenContract = ContractReturnType<"EverValueCoin">;
type PaymentHandlerContract = ContractReturnType<"PaymentHandler">;
type ReferralContract = ContractReturnType<"MultiLevelReferral">;
type ProgressiveJackpotContract = ContractReturnType<"ProgressiveJackpot">;
type RandomProviderContract = ContractReturnType<"RandomProvider">;
type VRFCoordinatorMockContract = ContractReturnType<"MockVRFCoordinatorV2Plus">;
type SingleRandomRouletteContract = ContractReturnType<"SingleRandomRoulette">;
type MockRandomProviderCallerContract = ContractReturnType<"MockRandomProviderCaller">;
type SingleRandomRouletteHarnessContract = ContractReturnType<"SingleRandomRouletteHarness">;
type MockJackpotPrecisionContract = ContractReturnType<"MockJackpotPrecision">;
type ManualRandomProviderContract = ContractReturnType<"ManualRandomProvider">;
type MockPaymentHandlerContract = ContractReturnType<"MockPaymentHandler">;

type PendingSpinTuple = Awaited<ReturnType<SingleRandomRouletteContract["read"]["pendingSpins"]>>;

type Balances = {
  player: bigint;
  roulette: bigint;
  jackpot: bigint;
  handler: bigint;
  referral: bigint;
  house: bigint;
};

function deriveRolls(seed: bigint, jackpotCap: bigint) {
  const rolls: bigint[] = [];
  for (let i = 0; i < MAX_DERIVED_ROLLS; i++) {
    const max = i < MAX_DERIVED_ROLLS - 1 ? BPS : jackpotCap;
    rolls.push(seed % max);
    const encoded = encodeAbiParameters(HASH_ABI, [seed, BigInt(i)]);
    seed = BigInt(keccak256(encoded));
  }
  return rolls;
}

function findSeed(predicate: (rolls: bigint[]) => boolean, jackpotCap: bigint) {
  for (let seed = 1n; seed < 10_000_000n; seed++) {
    const rolls = deriveRolls(seed, jackpotCap);
    if (predicate(rolls)) {
      console.log("Seed found:", seed.toString());
      return seed;
    }
  }
  throw new Error("Seed not found");
}

function assertSpin(tuple: PendingSpinTuple) {
  assert.equal(tuple[9], true);
}

async function setupMockProviderEnvironment(options?: {
  includeJackpot?: boolean;
  initialFunding?: bigint;
}) {
  const { viem: localViem } = await network.connect();
  const [localOwner, localPlayer, localHouse] = await localViem.getWalletClients();

  const localToken = await localViem.deployContract("EverValueCoin");
  const localHandler = await localViem.deployContract("PaymentHandler", [localToken.address]);
  const localReferral = await localViem.deployContract("MultiLevelReferral", [localToken.address, localOwner.account.address]);
  const localJackpot = await localViem.deployContract("ProgressiveJackpot", [localToken.address, localOwner.account.address]);
  const mockProvider = await localViem.deployContract("MockRandomProviderCaller");

  const localRoulette = await localViem.deployContract("SingleRandomRoulette", [
    localHandler.address,
    mockProvider.address,
    localToken.address,
  ]);

  await localHandler.write.registerGame([
    localRoulette.address,
    localRoulette.address,
    localHouse.account.address,
    1_000,
    500,
  ], { account: localOwner.account });
  await localHandler.write.setReferralContract([localReferral.address], { account: localOwner.account });
  await localReferral.write.setPaymentHandler([localHandler.address], { account: localOwner.account });
  await localReferral.write.setLevels([1, [10_000]], { account: localOwner.account });
  await localHandler.write.setGameStatus([localRoulette.address, true], { account: localOwner.account });

  await localToken.write.transfer([localPlayer.account.address, parseEther("10")], { account: localOwner.account });
  const funding = options?.initialFunding ?? parseEther("100");
  if (funding > 0n) {
    await localToken.write.transfer([localRoulette.address, funding], { account: localOwner.account });
  }
  await localToken.write.approve([localHandler.address, parseEther("10")], { account: localPlayer.account });

  if (options?.includeJackpot ?? true) {
    await localJackpot.write.setTierLadder([
      [
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 9_000n,
          isTerminal: true,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
      ],
    ], { account: localOwner.account });

    await localJackpot.write.registerGame([
      localRoulette.address,
      [
        {
          cumulativeProbability: 2_000n,
          tierAdvance: 1,
          tierResetTo: 0,
          consolationMultiplier: 0,
          awardsTier: true,
        },
        {
          cumulativeProbability: 5_000n,
          tierAdvance: 0,
          tierResetTo: 0,
          consolationMultiplier: 0,
          awardsTier: false,
        },
        {
          cumulativeProbability: 6_000n,
          tierAdvance: 0,
          tierResetTo: 0,
          consolationMultiplier: 15_000,
          awardsTier: false,
        },
        {
          cumulativeProbability: 10_000n,
          tierAdvance: 0,
          tierResetTo: 0,
          consolationMultiplier: 12_000,
          awardsTier: false,
        },
      ],
    ], { account: localOwner.account });
    await localJackpot.write.setGameStatus([localRoulette.address, true], { account: localOwner.account });
    await localRoulette.write.setJackpot([localJackpot.address], { account: localOwner.account });
    await localToken.write.transfer([localJackpot.address, parseEther("5")], { account: localOwner.account });
  }

  await localRoulette.write.setTableConfig([
    {
      enabled: true,
      replayBps: 1_000,
      jackpotBps: 200,
      jackpotContributionBps: options?.includeJackpot ? 100 : 0,
      minMultiplier: 150,
      maxMultiplier: 2_000,
      minWager: parseEther("1"),
      maxWager: 0n,
    },
  ], { account: localOwner.account });

  return {
    localOwner,
    localPlayer,
    localHouse,
    localRoulette,
    mockProvider,
    localToken,
    localJackpot: options?.includeJackpot ? localJackpot : undefined,
  } as const;
}

function buildDerivedValues(options: {
  multiplierBps: bigint;
  replayBps?: bigint;
  jackpotBps?: bigint;
  jackpotRoll?: bigint;
}) {
  const replay = options.replayBps ?? 1_000n;
  const derived = Array<bigint>(MAX_DERIVED_ROLLS + 1).fill(0n);
  derived[0] = options.multiplierBps + replay;
  if (options.jackpotRoll !== undefined) {
    derived[MAX_DERIVED_ROLLS] = options.jackpotRoll;
  }
  return derived;
}

describe("SingleRandomRoulette", () => {
  it("decodes spin event straight from receipt", async () => {
    const { viem } = await network.connect();
    const [owner, player, house] = await viem.getWalletClients();

    const token = await viem.deployContract("EverValueCoin");
    const handler = await viem.deployContract("PaymentHandler", [token.address]);
    const jackpot = await viem.deployContract("ProgressiveJackpot", [token.address, owner.account.address]);
    const coordinator = await viem.deployContract("MockVRFCoordinatorV2Plus");
    const provider = await viem.deployContract("RandomProvider", [coordinator.address]);
    const roulette = await viem.deployContract("SingleRandomRoulette", [handler.address, provider.address, token.address]);
    await handler.write.setReferralContract([ZERO_ADDRESS], { account: owner.account });

    await provider.write.setKeyHash([keccak256("0x01")], { account: owner.account });
    await provider.write.setSubscriptionId([1n], { account: owner.account });
    await provider.write.setConsumerStatus([roulette.address, true, 7n], { account: owner.account });

    await handler.write.registerGame(
      [roulette.address, roulette.address, house.account.address, 1_000, 0],
      { account: owner.account }
    );

    await roulette.write.setTableConfig([
      {
        enabled: true,
        replayBps: 0,
        jackpotBps: 0,
        jackpotContributionBps: 0,
        minMultiplier: 150,
        maxMultiplier: 0,
        minWager: 0n,
        maxWager: 0n,
      },
    ], { account: owner.account });

    await token.write.transfer([player.account.address, parseEther("10")], { account: owner.account });
    await token.write.transfer([roulette.address, parseEther("100")], { account: owner.account });
    await token.write.approve([handler.address, parseEther("10")], { account: player.account });

    const simulated = await roulette.simulate.startSpin([parseEther("2"), 200, house.account.address], {
      account: player.account,
    });
    const startTx = await roulette.write.startSpin([parseEther("2"), 200, house.account.address], {
      account: player.account,
    });
    const publicClient = await viem.getPublicClient();
    await publicClient.waitForTransactionReceipt({ hash: startTx });

    const fulfillHash = await coordinator.write.fulfill(
      [provider.address, simulated.result, [123n]],
      { account: owner.account }
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fulfillHash });

    const spinLog = receipt.logs.find((log) => log.address === roulette.address);
    assert.ok(spinLog);

    const decoded = decodeEventLog({
      abi: roulette.abi,
      eventName: "SpinResolved",
      data: spinLog!.data,
      topics: spinLog!.topics,
    });

    console.log("Minimal decoded SpinResolved:", decoded.args);
  });

  it("reverts constructor when dependencies missing", async () => {
    await assert.rejects(
      () =>
        viem.deployContract("SingleRandomRoulette", [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS]),
      (error: unknown) => {
        assert.match(String(error), /PaymentHandlerMisconfigured/);
        return true;
      }
    );
  });

  let viem: Viem;
  let publicClient: PublicClient;

  let owner: WalletClient;
  let player: WalletClient;
  let house: WalletClient;

  let token: TokenContract;
  let handler: PaymentHandlerContract;
  let referral: ReferralContract;
  let jackpot: ProgressiveJackpotContract;
  let provider: RandomProviderContract;
  let coordinator: VRFCoordinatorMockContract;
  let roulette: SingleRandomRouletteContract;
  let networkHelpers: Awaited<ReturnType<typeof network.connect>>["networkHelpers"];
  let providerAccount: WalletClient;

  async function simulateStart(args: [bigint, number, string]) {
    const { result } = await roulette.simulate.startSpin(args, {
      account: player.account,
    });
    return result as bigint;
  }

  async function getBalances(): Promise<Balances> {
    const [playerBalance, rouletteBalance, jackpotAddress, handlerBalance, referralBalance, houseBalance] = await Promise.all([
      token.read.balanceOf([player.account.address]),
      token.read.balanceOf([roulette.address]),
      (async () => {
        const jackpotAddress = await roulette.read.jackpot();
        return token.read.balanceOf([jackpotAddress]);
      })(),
      token.read.balanceOf([handler.address]),
      token.read.balanceOf([referral.address]),
      token.read.balanceOf([house.account.address]),
    ]);

    return {
      player: playerBalance,
      roulette: rouletteBalance,
      jackpot: jackpotAddress,
      handler: handlerBalance,
      referral: referralBalance,
      house: houseBalance,
    };
  }

  async function startSpin(wager: bigint, multiplier: number) {
    const simulatedRequestId = await simulateStart([wager, multiplier, house.account.address]);

    const txHash = await roulette.write.startSpin([wager, multiplier, house.account.address], {
      account: player.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const pending = await roulette.read.pendingSpins([simulatedRequestId]);
    assertSpin(pending);
    return { iid: simulatedRequestId, pending };
  }

  async function fulfill(requestId: bigint, seed: bigint) {
    const receiptHash = await coordinator.write.fulfill([provider.address, requestId, [seed]], {
      account: owner.account,
    });
    return publicClient.waitForTransactionReceipt({ hash: receiptHash });
  }
  beforeEach(async () => {
    ({ viem } = await network.connect());
    publicClient = await viem.getPublicClient();

    [owner, player, house] = await viem.getWalletClients();
    providerAccount = owner;

    token = await viem.deployContract("EverValueCoin");
    handler = await viem.deployContract("PaymentHandler", [token.address]);
    referral = await viem.deployContract("MultiLevelReferral", [token.address, owner.account.address]);
    jackpot = await viem.deployContract("ProgressiveJackpot", [token.address, owner.account.address]);
    coordinator = await viem.deployContract("MockVRFCoordinatorV2Plus");
    provider = await viem.deployContract("RandomProvider", [coordinator.address]);

    await provider.write.setKeyHash([keccak256("0x01")], { account: owner.account });
    await provider.write.setSubscriptionId([1n], { account: owner.account });

    roulette = await viem.deployContract("SingleRandomRoulette", [handler.address, provider.address, token.address]);

    await provider.write.setConsumerStatus([roulette.address, true, 7n], { account: owner.account });

    await handler.write.registerGame([
      roulette.address,
      roulette.address,
      house.account.address,
      1_000,
      500,
    ], { account: owner.account });
    await handler.write.setReferralContract([referral.address], { account: owner.account });
    await referral.write.setPaymentHandler([handler.address], { account: owner.account });
    await referral.write.setLevels([1, [10_000]], { account: owner.account });
    await handler.write.setGameStatus([roulette.address, true], { account: owner.account });

    await token.write.transfer([player.account.address, parseEther("100")], { account: owner.account });
    await token.write.transfer([roulette.address, parseEther("1000")], { account: owner.account });
    await token.write.approve([handler.address, parseEther("100")], { account: player.account });

    await jackpot.write.setTierLadder([
      [
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 2_000n,
          isTerminal: false,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
        {
          prizeMetric: 9_000n,
          isTerminal: true,
          isPercent: true,
          fixedBetCost: 0n,
          useDynamicCost: true,
        },
      ],
    ], { account: owner.account });

    await jackpot.write.registerGame([
      roulette.address,
      [
        {
          cumulativeProbability: 2_000n,
          tierAdvance: 1,
          tierResetTo: 0,
          consolationMultiplier: 0,
          awardsTier: true,
        },
        {
          cumulativeProbability: 5_000n,
          tierAdvance: 0,
          tierResetTo: 0,
          consolationMultiplier: 0,
          awardsTier: false,
        },
        {
          cumulativeProbability: 6_000n,
          tierAdvance: 0,
          tierResetTo: 0,
          consolationMultiplier: 15_000,
          awardsTier: false,
        },
        {
          cumulativeProbability: 10_000n,
          tierAdvance: 0,
          tierResetTo: 0,
          consolationMultiplier: 12_000,
          awardsTier: false,
        },
      ],
    ], { account: owner.account });

    await jackpot.write.setGameStatus([roulette.address, true], { account: owner.account });
    await roulette.write.setJackpot([jackpot.address], { account: owner.account });

    await roulette.write.setTableConfig([
      {
        enabled: true,
        replayBps: 1_000,
        jackpotBps: 200,
        jackpotContributionBps: 100,
        minMultiplier: 150,
        maxMultiplier: 2_000,
        minWager: parseEther("1"),
        maxWager: 0n,
      },
    ], { account: owner.account });
  });

  it("initializes with zero pending spins and full liquidity", async () => {
    const configIndex = await roulette.read.currentConfigIndex();
    assert.equal(configIndex, 1);

    const randomLogs = await publicClient.getLogs({
      address: provider.address,
      event: RANDOM_REQUESTED_EVENT,
      fromBlock: 0n,
      toBlock: "latest",
    });
    assert.equal(randomLogs.length, 0);

    const spinLogs = await publicClient.getLogs({
      address: roulette.address,
      event: SPIN_STARTED_EVENT,
      fromBlock: 0n,
      toBlock: "latest",
    });
    assert.equal(spinLogs.length, 0);

    const balance = await token.read.balanceOf([roulette.address]);
    const liquidity = await roulette.read.availableLiquidity();
    assert.equal(liquidity, balance);
  });

  it("resolves losing outcome and distributes jackpot contribution", async () => {
    const wager = parseEther("4");
    const multiplier = 250;

    await token.write.transfer([jackpot.address, parseEther("7")], { account: owner.account });

    const balancesBefore = await getBalances();

    const { iid, pending } = await startSpin(wager, multiplier);
    const replayBps = 1_000;
    const loseThreshold = Number(pending[6]) + replayBps + Number(pending[7]);
    const cap = await jackpot.read.PROBABILITY_PRECISION();

    const seed = findSeed((rolls) => rolls[0] >= BigInt(loseThreshold) && rolls[0] < BPS, cap);
    await fulfill(iid, seed);

    const balancesAfter = await getBalances();

    assert.equal(balancesAfter.player, balancesBefore.player - wager);
    assert.equal(balancesAfter.jackpot, balancesBefore.jackpot + (pending[4] as bigint));
  });

  it("pays multiplier outcome and unlocks exposure", async () => {
    const wager = parseEther("5");
    const multiplier = 300;

    await token.write.transfer([jackpot.address, parseEther("10")], { account: owner.account });

    const balancesBefore = await getBalances();

    const { iid, pending } = await startSpin(wager, multiplier);
    const multiplierBps = Number(pending[6]);
    const cap = await jackpot.read.PROBABILITY_PRECISION();

    const seed = findSeed((rolls) => rolls[0] < BigInt(multiplierBps), cap);
    await fulfill(iid, seed);

    const balancesAfter = await getBalances();

    const expectedPlayer = balancesBefore.player - wager + (pending[3] as bigint);
    assert.equal(balancesAfter.player, expectedPlayer);
    assert.equal(balancesAfter.jackpot, balancesBefore.jackpot + (pending[4] as bigint));

    const lockedExposure = await roulette.read.lockedExposure();
    assert.equal(lockedExposure, 0n);
  });

  it("consumes replay before hitting multiplier", async () => {
    const wager = parseEther("6");
    const multiplier = 250;

    await token.write.transfer([jackpot.address, parseEther("12")], { account: owner.account });

    const { iid, pending } = await startSpin(wager, multiplier);
    const replayBps = 1_000;
    const multiplierBps = Number(pending[6]);
    const jackpotBps = Number(pending[7]);
    const cap = await jackpot.read.PROBABILITY_PRECISION();

    const seed = findSeed(
      (rolls) =>
        rolls[0] >= BigInt(multiplierBps) &&
        rolls[0] < BigInt(multiplierBps + replayBps) &&
        rolls[1] < BigInt(multiplierBps) &&
        rolls[0] < BigInt(multiplierBps + replayBps + jackpotBps),
      cap
    );

    await fulfill(iid, seed);
  });

  it("awards jackpot branch", async () => {
    const wager = parseEther("4");
    const multiplier = 200;

    await token.write.transfer([jackpot.address, parseEther("20")], { account: owner.account });

    const ladder = await jackpot.read.getTierLadder();

    const balancesBefore = await getBalances();

    const { iid, pending } = await startSpin(wager, multiplier);
    const replayBps = 1_000;
    const multiplierBps = Number(pending[6]);
    const jackpotBps = Number(pending[7]);
    const cap = await jackpot.read.PROBABILITY_PRECISION();

    const seed = findSeed(
      (rolls) =>
        rolls[0] >= BigInt(multiplierBps + replayBps) &&
        rolls[0] < BigInt(multiplierBps + replayBps + jackpotBps) &&
        rolls[6] < BigInt(replayBps),
      cap
    );

    const receipt = await fulfill(iid, seed);
    const contribution = pending[4] as bigint;

    const spinEvents = parseEventLogs({
      abi: roulette.abi,
      eventName: "SpinResolved",
      logs: receipt.logs,
    });
    assert.equal(spinEvents.length, 1);
    const spinArgs = spinEvents[0].args as {
      outcome: number;
      spinsConsumed: number;
      jackpotPayout: bigint;
    };

    assert.equal(spinArgs.outcome, 2);
    assert.equal(spinArgs.spinsConsumed, 1);

    const entries = await jackpot.read.getPlayerEntries([player.account.address]);
    assert.equal(entries.length, 1);

    const entry = await jackpot.read.getEntry([entries[0]]);
    const tierIndex = Number(entry.tierIndex);
    const tier = ladder[tierIndex];
    const expectedPayout = tier.isPercent
      ? ((balancesBefore.jackpot + contribution) * tier.prizeMetric) / 10_000n
      : tier.prizeMetric;

    assert.equal(entry.payout, expectedPayout);

    const entryEvents = parseEventLogs({
      abi: jackpot.abi,
      eventName: "EntryProcessed",
      logs: receipt.logs,
    });
    assert.equal(entryEvents.length, 1);
    const entryArgs = entryEvents[0].args as { payout: bigint; tierIndex: number };
    assert.equal(entryArgs.payout, expectedPayout);
    assert.equal(entryArgs.tierIndex, tierIndex);
    assert.equal(spinArgs.jackpotPayout, expectedPayout);

    const balancesAfter = await getBalances();

    assert.equal(balancesAfter.player, balancesBefore.player - wager + expectedPayout);
    assert.equal(balancesAfter.jackpot, balancesBefore.jackpot + contribution - expectedPayout);
  });

  it("loses after consuming all replay rolls", async () => {
    const wager = parseEther("3");
    const multiplier = 200;

    await roulette.write.setTableConfig([
      {
        enabled: true,
        replayBps: 8_000,
        jackpotBps: 0,
        jackpotContributionBps: 0,
        minMultiplier: 200,
        maxMultiplier: 200,
        minWager: parseEther("1"),
        maxWager: 0n,
      },
    ], { account: owner.account });

    await token.write.transfer([jackpot.address, parseEther("5")], { account: owner.account });

    const { iid, pending } = await startSpin(wager, multiplier);
    const multiplierBps = Number(pending[6]);
    const replayBps = Number(pending[7]) > 0 ? Number(pending[7]) : 1_000;
    const cap = await jackpot.read.PROBABILITY_PRECISION();

    const loseSeed = 4_612_162n;

    const receipt = await fulfill(iid, loseSeed);
    const [spinEvent] = parseEventLogs({
      abi: roulette.abi,
      eventName: "SpinResolved",
      logs: receipt.logs,
    });

    const spinArgs = spinEvent.args as { outcome: number; spinsConsumed: number };
    assert.equal(spinArgs.outcome, 0);
    assert.equal(spinArgs.spinsConsumed, 6);
  });

  it("updates available liquidity while exposure locked", async () => {
    const wager = parseEther("3");
    const multiplier = 200;

    await token.write.transfer([jackpot.address, parseEther("5")], { account: owner.account });

    const balanceBefore = await token.read.balanceOf([roulette.address]);

    const { pending } = await startSpin(wager, multiplier);

    const lockedExposure = (pending[3] as bigint) + (pending[4] as bigint);
    assert.equal(await roulette.read.lockedExposure(), lockedExposure);

    const balanceAfter = await token.read.balanceOf([roulette.address]);
    const availableLiquidity = await roulette.read.availableLiquidity();
    assert.equal(availableLiquidity, balanceAfter - lockedExposure);
    assert.equal(balanceAfter, balanceBefore + (pending[2] as bigint));
  });

  it("returns zero liquidity when exposure equals balance", async () => {
    const balance = await token.read.balanceOf([roulette.address]);
    const testClient = await viem.getTestClient();
    const LOCKED_EXPOSURE_SLOT = 7n;

    await testClient.setStorageAt({
      address: roulette.address,
      index: toHex(LOCKED_EXPOSURE_SLOT, { size: 32 }),
      value: toHex(balance, { size: 32 }),
    });

    const locked = await roulette.read.lockedExposure();
    assert.equal(locked, balance);

    const liquidity = await roulette.read.availableLiquidity();
    assert.equal(liquidity, 0n);
  });

  it("previews spin probabilities and payouts", async () => {
    const wager = parseEther("2");
    const multiplier = 250;

    const preview = await roulette.read.previewSpin([wager, multiplier, 0xffffffff]);

    const multiplierProbability = BigInt(preview[0]);
    const replayProbability = BigInt(preview[1]);
    const jackpotProbability = BigInt(preview[2]);
    const loseProbability = BigInt(preview[3]);
    const maxPayout = BigInt(preview[4]);
    const jackpotContribution = BigInt(preview[5]);

    const totalProbability =
      multiplierProbability + replayProbability + jackpotProbability + loseProbability;
    assert.equal(totalProbability, BPS);

    const expectedPayout = (wager * BigInt(multiplier)) / 100n;
    assert.equal(maxPayout, expectedPayout);

    const expectedContribution = (wager * 100n) / BPS;
    assert.equal(jackpotContribution, expectedContribution);
  });

  it("guards against probability overflow in table config", async () => {
    await assert.rejects(
      () =>
        roulette.write.setTableConfig([
          {
            enabled: true,
            replayBps: 7_000,
            jackpotBps: 4_000,
            jackpotContributionBps: 100,
            minMultiplier: 150,
            maxMultiplier: 2_000,
            minWager: parseEther("1"),
            maxWager: 0n,
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /ProbabilityOverflow/);
        return true;
      }
    );
  });

  it("rejects invalid table config thresholds", async () => {
    await assert.rejects(
      () =>
        roulette.write.setTableConfig([
          {
            enabled: true,
            replayBps: 0,
            jackpotBps: 0,
            jackpotContributionBps: 10_001,
            minMultiplier: 150,
            maxMultiplier: 2_000,
            minWager: parseEther("1"),
            maxWager: 0n,
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /ProbabilityOverflow/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        roulette.write.setTableConfig([
          {
            enabled: true,
            replayBps: 0,
            jackpotBps: 0,
            jackpotContributionBps: 0,
            minMultiplier: 50,
            maxMultiplier: 2_000,
            minWager: parseEther("1"),
            maxWager: 0n,
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /InvalidMultiplier/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        roulette.write.setTableConfig([
          {
            enabled: true,
            replayBps: 0,
            jackpotBps: 0,
            jackpotContributionBps: 0,
            minMultiplier: 200,
            maxMultiplier: 150,
            minWager: parseEther("1"),
            maxWager: 0n,
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /InvalidMultiplier/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        roulette.write.setTableConfig([
          {
            enabled: true,
            replayBps: 0,
            jackpotBps: 0,
            jackpotContributionBps: 0,
            minMultiplier: 150,
            maxMultiplier: 2_000,
            minWager: parseEther("2"),
            maxWager: parseEther("1"),
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /WagerTooHigh/);
        return true;
      }
    );
  });

  it("requires jackpot when enabling probabilistic jackpots", async () => {
    await roulette.write.setJackpot([ZERO_ADDRESS], { account: owner.account });

    await assert.rejects(
      () =>
        roulette.write.setTableConfig([
          {
            enabled: true,
            replayBps: 500,
            jackpotBps: 100,
            jackpotContributionBps: 50,
            minMultiplier: 150,
            maxMultiplier: 0,
            minWager: parseEther("1"),
            maxWager: 0n,
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /JackpotNotConfigured/);
        return true;
      }
    );
  });

  it("applies scaling configuration to jackpot probability", async () => {
    await roulette.write.setJackpot([jackpot.address], { account: owner.account });

    await roulette.write.setTableConfig([
      {
        enabled: true,
        replayBps: 500,
        jackpotBps: 0,
        jackpotContributionBps: 50,
        minMultiplier: 150,
        maxMultiplier: 2_000,
        minWager: parseEther("1"),
        maxWager: 0n,
      },
    ], { account: owner.account });

    await roulette.write.setJackpotScalingConfig([
      {
        enabled: true,
        minJackpotBps: 100,
        maxJackpotBps: 500,
        minJackpotWager: parseEther("1"),
        maxJackpotWager: parseEther("5"),
        functionId: 0,
        extraData: "0x",
      },
    ], { account: owner.account });

    const minPreview = await roulette.read.previewSpin([parseEther("1"), 200, 0xffffffff]);
    const midPreview = await roulette.read.previewSpin([parseEther("3"), 200, 0xffffffff]);
    const maxPreview = await roulette.read.previewSpin([parseEther("5"), 200, 0xffffffff]);

    assert.equal(BigInt(minPreview[2]), 100n);
    assert.equal(BigInt(midPreview[2]), 300n);
    assert.equal(BigInt(maxPreview[2]), 500n);
  });

  it("rejects invalid scaling configuration thresholds", async () => {
    await assert.rejects(
      () =>
        roulette.write.setJackpotScalingConfig([
          {
            enabled: true,
            minJackpotBps: 100,
            maxJackpotBps: 10_001,
            minJackpotWager: parseEther("1"),
            maxJackpotWager: parseEther("3"),
            functionId: 0,
            extraData: "0x",
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /ProbabilityOverflow/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        roulette.write.setJackpotScalingConfig([
          {
            enabled: true,
            minJackpotBps: 500,
            maxJackpotBps: 100,
            minJackpotWager: parseEther("1"),
            maxJackpotWager: parseEther("3"),
            functionId: 0,
            extraData: "0x",
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /ProbabilityOverflow/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        roulette.write.setJackpotScalingConfig([
          {
            enabled: true,
            minJackpotBps: 100,
            maxJackpotBps: 500,
            minJackpotWager: parseEther("3"),
            maxJackpotWager: parseEther("1"),
            functionId: 0,
            extraData: "0x",
          },
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /ProbabilityOverflow/);
        return true;
      }
    );
  });

  it("returns current table config via getters", async () => {
    const currentIndex = await roulette.read.currentConfigIndex();
    const currentConfig = await roulette.read.getTableConfig();
    const configByIndex = await roulette.read.getTableConfig([currentIndex]);

    assert.equal(currentConfig.enabled, true);
    assert.equal(currentConfig.replayBps, 1_000);
    assert.equal(currentConfig.jackpotBps, 200);
    assert.equal(currentConfig.jackpotContributionBps, 100);
    assert.equal(currentConfig.minMultiplier, 150);
    assert.equal(currentConfig.maxMultiplier, 2_000);
    assert.equal(currentConfig.minWager, parseEther("1"));
    assert.equal(currentConfig.maxWager, 0n);

    assert.equal(configByIndex.enabled, currentConfig.enabled);
    assert.equal(configByIndex.replayBps, currentConfig.replayBps);

    const legacyConfig = await roulette.read.getTableConfig([0]);
    assert.equal(legacyConfig.enabled, false);
  });

  it("returns scaling config via getters", async () => {
    const baseScaling = await roulette.read.getJackpotScalingConfig();
    const baseScalingByIndex = await roulette.read.getJackpotScalingConfig([
      await roulette.read.currentConfigIndex(),
    ]);

    assert.equal(baseScaling.enabled, false);
    assert.equal(baseScaling.minJackpotBps, 0);
    assert.equal(baseScalingByIndex.maxJackpotBps, baseScaling.maxJackpotBps);

    await roulette.write.setJackpotScalingConfig([
      {
        enabled: true,
        minJackpotBps: 50,
        maxJackpotBps: 150,
        minJackpotWager: parseEther("1"),
        maxJackpotWager: parseEther("3"),
        functionId: 0,
        extraData: "0x",
      },
    ], { account: owner.account });

    const updatedScaling = await roulette.read.getJackpotScalingConfig();
    const updatedByIndex = await roulette.read.getJackpotScalingConfig([
      await roulette.read.currentConfigIndex(),
    ]);

    assert.equal(updatedScaling.enabled, true);
    assert.equal(updatedScaling.minJackpotBps, 50);
    assert.equal(updatedScaling.maxJackpotBps, 150);
    assert.equal(updatedScaling.minJackpotWager, parseEther("1"));
    assert.equal(updatedScaling.maxJackpotWager, parseEther("3"));
    assert.equal(updatedByIndex.functionId, updatedScaling.functionId);
  });

  it("unlocks exposure on random failure", async () => {
    await token.write.transfer([jackpot.address, parseEther("5")], { account: owner.account });

    const { iid, pending } = await startSpin(parseEther("2"), 200);

    const beforeLocked = await roulette.read.lockedExposure();
    assert.equal(beforeLocked, (pending[3] as bigint) + (pending[4] as bigint));

    const testClient = await viem.getTestClient();
    const timeout = await provider.read.REQUEST_TIMEOUT();
    await testClient.increaseTime({ seconds: timeout + 1n });
    await testClient.mine({ blocks: 1n });

    const fulfillHash = await coordinator.write.fulfill([
      provider.address,
      iid,
      [123n],
    ], { account: owner.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fulfillHash });

    const failedPending = await roulette.read.pendingSpins([iid]);
    assert.equal(failedPending[9], false);

    const lockedAfter = await roulette.read.lockedExposure();
    assert.equal(lockedAfter, 0n);

    const [log] = parseEventLogs({
      abi: roulette.abi,
      eventName: "SpinFailed",
      logs: receipt.logs,
    });
    const args = log.args as { requestId: bigint; reason: string };
    assert.equal(args.requestId, iid);
    assert.equal(args.reason, await provider.read.failureReasonTimeout());
  });


  it("disables roulette via table config", async () => {
    await roulette.write.setTableConfig([
      {
        enabled: false,
        replayBps: 1_000,
        jackpotBps: 200,
        jackpotContributionBps: 100,
        minMultiplier: 150,
        maxMultiplier: 2_000,
        minWager: parseEther("1"),
        maxWager: 0n,
      },
    ], { account: owner.account });

    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("2"), 200, house.account.address], {
        account: player.account,
      }),
      (error: unknown) => {
        assert.match(String(error), /RouletteDisabled/);
        return true;
      }
    );
  });

  it("clears jackpot allowance when jackpot removed", async () => {
    const allowanceBefore = await token.read.allowance([roulette.address, jackpot.address]);
    assert.equal(allowanceBefore > 0n, true);

    await roulette.write.setJackpot([ZERO_ADDRESS], { account: owner.account });

    const allowanceAfter = await token.read.allowance([roulette.address, jackpot.address]);
    assert.equal(allowanceAfter, 0n);
    const configuredJackpot = await roulette.read.jackpot();
    assert.equal(configuredJackpot, ZERO_ADDRESS);
  });

  it("reverts when jackpot precision is zero", async () => {
    const zeroPrecision = await viem.deployContract("MockJackpotPrecision", [0n]);

    await assert.rejects(
      () => roulette.write.setJackpot([zeroPrecision.address], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /ProbabilityOverflow/);
        return true;
      }
    );
  });

  it("reverts when jackpot precision exceeds uint128", async () => {
    const hugePrecision = await viem.deployContract("MockJackpotPrecision", [1n << 130n]);

    await assert.rejects(
      () => roulette.write.setJackpot([hugePrecision.address], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /ProbabilityOverflow/);
        return true;
      }
    );
  });

  it("reverts when jackpot cannot cover payouts", async () => {
    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("4"), 250n, house.account.address], {
        account: player.account,
      }),
      (error: unknown) => {
        assert.match(String(error), /Jackpot underfunded/);
        return true;
      }
    );
  });

  it("rejects multipliers outside configured range", async () => {
    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("2"), 140n, house.account.address], {
          account: player.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /InvalidMultiplier/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("2"), 5_000n, house.account.address], {
        account: player.account,
      }),
      (error: unknown) => {
        assert.match(String(error), /InvalidMultiplier/);
        return true;
      }
    );
  });

  it("rejects wagers outside configured range", async () => {
    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("0.5"), 200, house.account.address], {
          account: player.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /WagerTooLow/);
        return true;
      }
    );

    await roulette.write.setTableConfig([
      {
        enabled: true,
        replayBps: 1_000,
        jackpotBps: 200,
        jackpotContributionBps: 100,
        minMultiplier: 150,
        maxMultiplier: 2_000,
        minWager: parseEther("1"),
        maxWager: parseEther("5"),
      },
    ], { account: owner.account });

    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("6"), 200, house.account.address], {
        account: player.account,
      }),
      (error: unknown) => {
        assert.match(String(error), /WagerTooHigh/);
        return true;
      }
    );
  });

  it("rejects when payment handler payout target mismatched", async () => {
    await handler.write.updateGameConfig([
      roulette.address,
      owner.account.address,
      house.account.address,
      1_000,
      500,
    ], { account: owner.account });

    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("2"), 200, house.account.address], {
        account: player.account,
      }),
      (error: unknown) => {
        assert.match(String(error), /PaymentHandlerMisconfigured/);
        return true;
      }
    );
  });

  it("rejects when liquidity insufficient to cover payout", async () => {
    await token.write.transfer([jackpot.address, parseEther("60")], { account: owner.account });

    const wager = parseEther("40");
    const multiplier = 2_000;

    const firstTx = await roulette.write.startSpin([wager, multiplier, house.account.address], {
      account: player.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: firstTx });

    await token.write.transfer([player.account.address, parseEther("20")], { account: owner.account });
    await token.write.approve([handler.address, parseEther("120")], { account: player.account });

    await assert.rejects(
      () =>
        roulette.write.startSpin([wager, multiplier, house.account.address], {
        account: player.account,
      }),
      (error: unknown) => {
        assert.match(String(error), /LiquidityShortfall/);
        return true;
      }
    );
  });

  it("rejects when locking exposure exceeds remaining balance", async () => {
    await token.write.transfer([jackpot.address, parseEther("30")], { account: owner.account });

    const firstSpin = await roulette.write.startSpin([parseEther("10"), 300, house.account.address], {
      account: player.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: firstSpin });

    const testClient = await viem.getTestClient();
    const BALANCES_SLOT = 0n;
    const slotIndex = keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "uint256" },
        ],
        [roulette.address, BALANCES_SLOT]
      )
    );

    await testClient.setStorageAt({
      address: token.address,
      index: slotIndex,
      value: toHex(parseEther("5"), { size: 32 }),
    });

    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("6"), 300, house.account.address], {
      account: player.account,
      }),
      (error: unknown) => {
        assert.match(String(error), /LiquidityShortfall/);
        return true;
      }
    );
  });

  it("rejects spins when jackpot disabled but contributions configured", async () => {
    await roulette.write.setJackpot([ZERO_ADDRESS], { account: owner.account });

    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("2"), 200, house.account.address], {
      account: player.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /JackpotNotConfigured/);
        return true;
      }
    );
  });

  it("rejects fulfillRandomness when caller is not provider", async () => {
    await token.write.transfer([jackpot.address, parseEther("5")], { account: owner.account });
    const { iid } = await startSpin(parseEther("2"), 200);

    await assert.rejects(
      () =>
        roulette.write.fulfillRandomness([
          iid,
          0n,
          Array(MAX_DERIVED_ROLLS + 1).fill(0n),
        ], { account: player.account }),
      (error: unknown) => {
        assert.match(String(error), /UnauthorizedCaller/);
        return true;
      }
    );
  });

  it("rejects fulfillRandomness when provider returns insufficient derived values", async () => {
    const { localOwner, localPlayer, localHouse, mockProvider, localRoulette } =
      await setupMockProviderEnvironment();

    const { result: simulatedRequest } = await localRoulette.simulate.startSpin(
      [parseEther("2"), 200, localHouse.account.address],
      { account: localPlayer.account }
    );
    const requestId = simulatedRequest as bigint;

    await localRoulette.write.startSpin([parseEther("2"), 200, localHouse.account.address], {
      account: localPlayer.account,
    });

    await assert.rejects(
      () => mockProvider.write.fulfillWith([requestId, [0n]], { account: localOwner.account }),
      (error: unknown) => {
        assert.match(String(error), /InvalidRandomResponse/);
        return true;
      }
    );
  });

  it("rejects fulfillRandomness when pending spin missing", async () => {
    const { localOwner, localPlayer, localHouse, mockProvider, localRoulette } =
      await setupMockProviderEnvironment();

    const { result: simulatedRequest } = await localRoulette.simulate.startSpin(
      [parseEther("2"), 200, localHouse.account.address],
      { account: localPlayer.account }
    );
    const requestId = simulatedRequest as bigint;

    await localRoulette.write.startSpin([parseEther("2"), 200, localHouse.account.address], {
      account: localPlayer.account,
    });

    await mockProvider.write.fulfillWith([
      requestId,
      Array(MAX_DERIVED_ROLLS + 1).fill(0n),
    ], { account: localOwner.account });

    await assert.rejects(
      () =>
        mockProvider.write.fulfillWith([
          requestId,
          Array(MAX_DERIVED_ROLLS + 1).fill(0n),
        ], { account: localOwner.account }),
      (error: unknown) => {
        assert.match(String(error), /UnauthorizedCaller/);
        return true;
      }
    );
  });

  it("reverts fulfillRandomness when jackpot cap removed before resolution", async () => {
    const {
      localOwner,
      localPlayer,
      localHouse,
      mockProvider,
      localRoulette,
    } = await setupMockProviderEnvironment();

    const { result: simulatedRequest } = await localRoulette.simulate.startSpin(
      [parseEther("2"), 200, localHouse.account.address],
      { account: localPlayer.account }
    );
    const requestId = simulatedRequest as bigint;

    await localRoulette.write.startSpin([parseEther("2"), 200, localHouse.account.address], {
      account: localPlayer.account,
    });

    const pending = await localRoulette.read.pendingSpins([requestId]);
    const multiplierBps = BigInt(pending[6]);
    const replayBps = 1_000n;

    await localRoulette.write.setJackpot([ZERO_ADDRESS], { account: localOwner.account });

    const derived = Array<bigint>(MAX_DERIVED_ROLLS + 1).fill(0n);
    derived[0] = multiplierBps + replayBps;
    derived[MAX_DERIVED_ROLLS] = 0n;

    await assert.rejects(
      () => mockProvider.write.fulfillWith([requestId, derived], { account: localOwner.account }),
      (error: unknown) => {
        assert.match(String(error), /InvalidRandomSlice/);
        return true;
      }
    );
  });

  it("rejects when payment handler payout target mismatched", async () => {
    await handler.write.updateGameConfig([
      roulette.address,
      owner.account.address,
      house.account.address,
      1_000,
      500,
    ], { account: owner.account });

    await assert.rejects(
      () =>
        roulette.write.startSpin([parseEther("2"), 200, house.account.address], {
        account: player.account,
      }),
      (error: unknown) => {
        assert.match(String(error), /PaymentHandlerMisconfigured/);
        return true;
      }
    );
  });
});

