import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { keccak256, parseEther, formatEther, encodeFunctionData, decodeErrorResult } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 500;
const REFERRAL_BPS = 200;

const DEFAULT_TABLE_CONFIG = {
  enabled: true,
  replayBps: 1_000,
  jackpotBps: 200,
  jackpotContributionBps: 200,
  minMultiplier: 101,
  maxMultiplier: 10_000,
  minWager: parseEther("1"),
  maxWager: parseEther("100"),
};

const KEY_HASH = keccak256("0x01");
const SUBSCRIPTION_ID = 1n;
const JACKPOT_START = parseEther("30");
const CONSUMER_RANGE_LIMIT = 7n;

const TIER_COUNT = 9;
const LOSE_BASE_BPS = 1_000; // 10%
const CONSOLATION_12_BPS = 1_500; // 15%
const CONSOLATION_15_BPS = 1_000; // 10%

const SCALING_LINEAR = 0;
const SCALING_QUADRATIC = 1;
const SCALING_LOG = 2;

type ScalingConfig = {
  enabled: boolean;
  minJackpotBps: number;
  maxJackpotBps: number;
  minJackpotWager: bigint;
  maxJackpotWager: bigint;
  functionId: number;
  extraData: `0x${string}`;
};

type OutcomeConfig = {
  scaling: ScalingConfig;
  tierAdvance: number;
  tierResetTo: number;
  consolationMultiplier: number;
  awardsTier: boolean;
};

function buildTierLadder() {
  return Array.from({ length: TIER_COUNT }, (_, index) => ({
    prizeMetric: index === TIER_COUNT - 1 ? 9_000n : 2_000n,
    isTerminal: index === TIER_COUNT - 1,
    isPercent: true,
    fixedBetCost: 0n,
    useDynamicCost: true,
  }));
}

function scalingConst(bps: number): ScalingConfig {
  return {
    enabled: true,
    minJackpotBps: bps,
    maxJackpotBps: bps,
    minJackpotWager: 0n,
    maxJackpotWager: 1n,
    functionId: SCALING_LINEAR,
    extraData: "0x" as `0x${string}`,
  };
}

function scalingRange(minBps: number, maxBps: number, minBal: string, maxBal: string, fn: number): ScalingConfig {
  return {
    enabled: true,
    minJackpotBps: minBps,
    maxJackpotBps: maxBps,
    minJackpotWager: parseEther(minBal),
    maxJackpotWager: parseEther(maxBal),
    functionId: fn,
    extraData: "0x" as `0x${string}`,
  };
}

function buildScaledOutcomes(): OutcomeConfig[] {
  const outcomes: OutcomeConfig[] = [];
  outcomes.push({ scaling: scalingConst(LOSE_BASE_BPS), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false });
  outcomes.push({ scaling: scalingConst(CONSOLATION_12_BPS), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 1_200, awardsTier: false });
  outcomes.push({ scaling: scalingConst(CONSOLATION_15_BPS), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 1_500, awardsTier: false });

  outcomes.push({ scaling: scalingRange(100, 7_000, "15", "1000", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(100, 7_000, "20", "1000", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(100, 7_000, "25", "1000", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(100, 6_500, "50", "1000", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(100, 6_500, "60", "1000", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(100, 7_000, "70", "1000", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(100, 7_000, "100", "1500", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(50, 5_000, "100", "2500", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(50, 7_000, "100", "10000", SCALING_LOG), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });

  return outcomes;
}

describe("Overflow logging and reproduction (deploy-local + simulate-bets flow)", function () {
  let viem: any;
  let deployer: any, house: any, fallbackAcc: any, player: any;
  let token: any, coordinator: any, randomProvider: any, handler: any, referral: any, jackpot: any, roulette: any;

  beforeEach(async function () {
    const connection = await network.connect();
    viem = connection.viem;

    [deployer, house, fallbackAcc, player] = await viem.getWalletClients();

    token = await viem.deployContract("EverValueCoin");
    coordinator = await viem.deployContract("MockVRFCoordinatorV2Plus");
    randomProvider = await viem.deployContract("RandomProvider", [coordinator.address]);

    await randomProvider.write.setKeyHash([KEY_HASH], { account: deployer.account });
    await randomProvider.write.setSubscriptionId([SUBSCRIPTION_ID], { account: deployer.account });

    handler = await viem.deployContract("PaymentHandler", [token.address]);
    referral = await viem.deployContract("MultiLevelReferral", [token.address, deployer.account.address]);

    await handler.write.setReferralContract([referral.address], { account: deployer.account });
    await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
    await referral.write.setDefaultReceiver([fallbackAcc.account.address], { account: deployer.account });
    await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });

    jackpot = await viem.deployContract("ProgressiveJackpot", [token.address, randomProvider.address]);
    await jackpot.write.setTierLadder([buildTierLadder()], { account: deployer.account });

    roulette = await viem.deployContract("SingleRandomRoulette", [handler.address, randomProvider.address, token.address]);

    // handler game config
    await handler.write.registerGame([
      roulette.address,
      roulette.address,
      house.account.address,
      HOUSE_EDGE_BPS,
      REFERRAL_BPS,
    ], { account: deployer.account });
    await handler.write.setGameStatus([roulette.address, true], { account: deployer.account });

    // consumer setup
    await randomProvider.write.setConsumerStatus([roulette.address, true, CONSUMER_RANGE_LIMIT], { account: deployer.account });

    // jackpot hooking
    await roulette.write.setJackpot([jackpot.address], { account: deployer.account });

    const jackpotOutcomes = buildScaledOutcomes();
    await jackpot.write.registerGame([roulette.address, jackpotOutcomes], { account: deployer.account });
    await jackpot.write.setGameStatus([roulette.address, true], { account: deployer.account });

    // direct bet config (not used here, included for parity)
    await jackpot.write.configureDirectBet([true, jackpotOutcomes], { account: deployer.account });

    // fallback indices
    await jackpot.write.setGameFallback([roulette.address, 0], { account: deployer.account });
    await jackpot.write.setDirectFallback([0], { account: deployer.account });

    // table + scaling config
    await roulette.write.setTableConfig([DEFAULT_TABLE_CONFIG], { account: deployer.account });
    await roulette.write.setJackpotScalingConfig([{
      enabled: true,
      minJackpotBps: 100,
      maxJackpotBps: 2500,
      minJackpotWager: parseEther("0.1"),
      maxJackpotWager: parseEther("140"),
      functionId: SCALING_LINEAR,
      extraData: "0x" as `0x${string}`,
    }], { account: deployer.account });

    // fund pools and accounts
    await token.write.transfer([jackpot.address, JACKPOT_START], { account: deployer.account });
    await token.write.transfer([roulette.address, parseEther("1000000")], { account: deployer.account });

    // fund player with EVA and approve handler
    await token.write.transfer([player.account.address, parseEther("10000")], { account: deployer.account });
    await token.write.approve([handler.address, parseEther("10000")], { account: player.account });
  });

  it("runs a small simulate-bets-like sequence and prints diagnostics (no asserts)", async function () {
    const publicClient = await viem.getPublicClient();

    // choose params that likely trigger ProbabilityOverflow at higher scaled jackpot bps
    const wager = parseEther("82.1"); // ≈ the recorded case
    const multiplier = 113;
    const referrer = fallbackAcc.account.address;

    // preview first to see probabilities
    const preview = await roulette.read.previewSpin([wager, multiplier, await roulette.read.getTableConfig().then(() => 0xffffffff)]);
    const [multiplierBps, replayBps, jackpotBps, loseBps, maxPayout, jackpotContribution] = preview as unknown as [
      number, number, number, number, bigint, bigint
    ];
    console.log("preview", {
      wager: formatEther(wager),
      multiplier,
      multiplierBps,
      replayBps,
      jackpotBps,
      loseBps,
      maxPayout: formatEther(maxPayout),
      jackpotContribution: formatEther(jackpotContribution),
    });

    // try simulate.startSpin to surface revert without tx where possible
    try {
      await roulette.simulate.startSpin([wager, multiplier, referrer], { account: player.account });
      console.log("simulate.startSpin: success");
    } catch (err: any) {
      console.log("simulate.startSpin: reverted");
      await printRevert("startSpin", [wager, multiplier, referrer], err, roulette.abi as any[], roulette.address, player.account.address);
    }

    // send the real tx to trigger on-chain hardhat console logs (if present in contract)
    try {
      const hash = await roulette.write.startSpin([wager, multiplier, referrer], { account: player.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("startSpin tx mined", receipt.status);
    } catch (err: any) {
      console.log("startSpin tx: reverted");
      await printRevert("startSpin", [wager, multiplier, referrer], err, roulette.abi as any[], roulette.address, player.account.address);
    }
  });
});

async function printRevert(
  fn: string,
  args: any[],
  err: any,
  abi: any[],
  to: `0x${string}`,
  from: `0x${string}`
) {
  try {
    const calldata = encodeFunctionData({ abi, functionName: fn, args });
    const cause: any = err?.cause ?? err;
    const data = cause?.data ?? cause?.error?.data ?? cause?.cause?.data;
    if (typeof data === "string" && data.startsWith("0x")) {
      try {
        const dec = decodeErrorResult({ abi, data });
        console.log("decoded revert", { name: dec.errorName, args: dec.args });
      } catch {
        console.log("raw revert payload", data.slice(0, 10));
      }
    } else {
      console.log("no revert payload on error", String(err));
    }
    console.log("replay", { from, to, calldata });
  } catch (e) {
    console.log("printRevert failed", e);
  }
}