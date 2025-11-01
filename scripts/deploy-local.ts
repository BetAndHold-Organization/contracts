import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { keccak256, parseEther } from "viem";

const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 500;
const REFERRAL_BPS = 200;

export const DEFAULT_TABLE_CONFIG = {
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

// New scaled/static probability configuration in bps
const TIER_COUNT = 9;
const LOSE_BASE_BPS = 1_000; // 10%
const CONSOLATION_12_BPS = 1_500; // 15%
const CONSOLATION_15_BPS = 1_000; // 10%

function buildTierLadder() {
  return Array.from({ length: TIER_COUNT }, (_, index) => ({
    prizeMetric: index === TIER_COUNT - 1 ? 9_000n : 2_000n,
    isTerminal: index === TIER_COUNT - 1,
    isPercent: true,
    fixedBetCost: 0n,
    useDynamicCost: true,
  }));
}

// Scaling function ids (match JackpotScalingLib.ScalingFunction)
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

  // 0: Lose base 10%
  outcomes.push({
    scaling: scalingConst(LOSE_BASE_BPS),
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 0,
    awardsTier: false,
  });

  // 1: Consolation 1.2x at 15%
  outcomes.push({
    scaling: scalingConst(CONSOLATION_12_BPS),
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 1_200,
    awardsTier: false,
  });

  // 2: Consolation 1.5x at 10%
  outcomes.push({
    scaling: scalingConst(CONSOLATION_15_BPS),
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 1_500,
    awardsTier: false,
  });

  // 3..11: Tiers 1..9 per spec
  outcomes.push({
    scaling: scalingRange(100, 7_000, "15", "1000", SCALING_LINEAR),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });
  outcomes.push({
    scaling: scalingRange(100, 7_000, "20", "1000", SCALING_LINEAR),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });
  outcomes.push({
    scaling: scalingRange(100, 7_000, "25", "1000", SCALING_LINEAR),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });
  outcomes.push({
    scaling: scalingRange(100, 6_500, "50", "1000", SCALING_LINEAR),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });
  outcomes.push({
    scaling: scalingRange(100, 6_500, "60", "1000", SCALING_LINEAR),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });
  outcomes.push({
    scaling: scalingRange(100, 7_000, "70", "1000", SCALING_LINEAR),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });
  outcomes.push({
    scaling: scalingRange(100, 7_000, "100", "1500", SCALING_LINEAR),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });
  outcomes.push({
    scaling: scalingRange(50, 5_000, "100", "2500", SCALING_QUADRATIC),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });
  outcomes.push({
    scaling: scalingRange(50, 7_000, "100", "10000", SCALING_LOG),
    tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
  });

  return outcomes;
}

async function main() {
  const connection = await network.connect();
  const viem = connection.viem;

  const [deployer, house, fallback, player] = await viem.getWalletClients();

  // Deploy token
  const token = await viem.deployContract("EverValueCoin");
  console.log("EVA token:", token.address);

  // Deploy mock VRF stack
  const coordinator = await viem.deployContract("MockVRFCoordinatorV2Plus");
  console.log("Mock VRF coordinator:", coordinator.address);

  const randomProvider = await viem.deployContract("RandomProvider", [coordinator.address]);
  console.log("Random provider:", randomProvider.address);

  await randomProvider.write.setKeyHash([KEY_HASH], { account: deployer.account });
  await randomProvider.write.setSubscriptionId([SUBSCRIPTION_ID], { account: deployer.account });

  // Deploy payment handler and referral system
  const handler = await viem.deployContract("PaymentHandler", [token.address]);
  console.log("Payment handler:", handler.address);

  const referral = await viem.deployContract("MultiLevelReferral", [token.address, deployer.account.address]);
  console.log("Multi-level referral:", referral.address);

  await handler.write.setReferralContract([referral.address], { account: deployer.account });
  await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
  await referral.write.setDefaultReceiver([fallback.account.address], { account: deployer.account });
  await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });

  const jackpot = await viem.deployContract("ProgressiveJackpot", [token.address, randomProvider.address]);
  console.log("Progressive jackpot:", jackpot.address);

  await jackpot.write.setTierLadder([buildTierLadder()], { account: deployer.account });

  const roulette = await viem.deployContract("SingleRandomRoulette", [handler.address, randomProvider.address, token.address]);
  console.log("Single random roulette:", roulette.address);

  const jackpotOutcomes = buildScaledOutcomes();
  const directBetOutcomes = buildScaledOutcomes();

  await handler.write.registerGame([
    roulette.address,
    roulette.address,
    house.account.address,
    HOUSE_EDGE_BPS,
    REFERRAL_BPS,
  ], { account: deployer.account });

  await handler.write.setGameStatus([roulette.address, true], { account: deployer.account });

  await randomProvider.write.setConsumerStatus([roulette.address, true, CONSUMER_RANGE_LIMIT], { account: deployer.account });

  await roulette.write.setJackpot([jackpot.address], { account: deployer.account });

  console.log("registerGame outcomes len:", jackpotOutcomes.length);
  try {
    await jackpot.write.registerGame([roulette.address, jackpotOutcomes], { account: deployer.account });
  } catch (e) {
    console.error("registerGame failed", e);
    throw e;
  }

  await jackpot.write.setGameStatus([roulette.address, true], { account: deployer.account });

  await jackpot.write.configureDirectBet([
    true,
    directBetOutcomes,
  ], { account: deployer.account });

  // Set fallback indices (use index 0 which is the pure lose outcome)
  await jackpot.write.setGameFallback([roulette.address, 0], { account: deployer.account });
  await jackpot.write.setDirectFallback([0], { account: deployer.account });

  const directBetOutcomesConfigured = await jackpot.read.getDirectBetOutcomes();
  console.log("Direct bet outcomes configured:", directBetOutcomesConfigured.length);

  await roulette.write.setTableConfig([DEFAULT_TABLE_CONFIG], { account: deployer.account });
  await roulette.write.setJackpotScalingConfig([{
    enabled: true,
    minJackpotBps: 100,                   // 1.00% at low wager
    maxJackpotBps: 2500,                  // 25.00% at high wager
    minJackpotWager: parseEther("0.1"),
    maxJackpotWager: parseEther("140"),
    functionId: SCALING_LINEAR,           // 0
    extraData: "0x" as `0x${string}`,
  }], { account: deployer.account });
  await token.write.transfer([jackpot.address, JACKPOT_START], { account: deployer.account });

  await token.write.transfer([house.account.address, parseEther("100")], { account: deployer.account });
  await token.write.transfer([fallback.account.address, parseEther("100")], { account: deployer.account });
  await token.write.transfer([player.account.address, parseEther("100")], { account: deployer.account });
  await token.write.transfer([roulette.address, parseEther("1000")], { account: deployer.account });

  const rouletteFunding = parseEther("1000000");
  await token.write.transfer([roulette.address, rouletteFunding], { account: deployer.account });

  const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
  const FUNDED_PLAYER_COUNT = 1002; // first 1000 plus two replacements for excluded wallets
  for (let i = 0; i < FUNDED_PLAYER_COUNT; i += 1) {
    const account = mnemonicToAccount(HARDHAT_MNEMONIC, {
      path: `m/44'/60'/0'/0/${i}`,
    });
    await token.write.transfer([account.address, parseEther("10000")], { account: deployer.account });
  }

  await token.write.approve([handler.address, parseEther("1000")], { account: player.account });

  const faucetAmount = parseEther("1000");
  await token.write.approve([handler.address, faucetAmount], { account: deployer.account });

  console.log("House funded with 100 EVA at", house.account.address);
  console.log("Fallback funded with 100 EVA at", fallback.account.address);
  console.log("Player funded with 100 EVA at", player.account.address);

  console.log("\nConfiguration Summary:");
  console.log("  Token:", token.address);
  console.log("  Coordinator:", coordinator.address);
  console.log("  RandomProvider:", randomProvider.address);
  console.log("  PaymentHandler:", handler.address);
  console.log("  MultiLevelReferral:", referral.address);
  console.log("  ProgressiveJackpot:", jackpot.address);
  console.log("  SingleRandomRoulette:", roulette.address);
  console.log("  Referral ladder:", REFERRAL_LADDER.join(","));
  console.log("  House edge:", HOUSE_EDGE_BPS);
  console.log("  Referral BPS:", REFERRAL_BPS);

  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const deploymentPath = new URL("local.json", deploymentsDir);
  await fs.writeFile(deploymentPath, JSON.stringify({
    token: token.address,
    coordinator: coordinator.address,
    randomProvider: randomProvider.address,
    handler: handler.address,
    referral: referral.address,
    jackpot: jackpot.address,
    roulette: roulette.address,
    house: house.account.address,
    fallback: fallback.account.address,
    samplePlayer: player.account.address,
  }, null, 2));
  console.log("Deployment info saved to", deploymentPath.pathname);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

