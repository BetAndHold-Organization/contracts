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

const TIER_COUNT = 9;
const TIER_START_BPS = 500; // 5.0%
const TIER_END_BPS = 50;   // 0.5%

const DIRECT_BET_WEIGHTS = [
  { weight: 5, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false }, // Lose
  { weight: 5, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 1_200, awardsTier: false }, // Consolation 1.2x
  { weight: 5, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 1_500, awardsTier: false }, // Consolation 1.5x
  { weight: 60, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 0
  { weight: 70, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 1
  { weight: 40, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 2
  { weight: 30, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 3
  { weight: 20, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 4
  { weight: 15, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 5
  { weight: 13, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 6
  { weight: 10, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 7
  { weight: 5, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true }, // Tier 8
];

function buildTierBps(): number[] {
  const step = (TIER_START_BPS - TIER_END_BPS) / (TIER_COUNT - 1);
  const values: number[] = [];
  for (let i = 0; i < TIER_COUNT; i += 1) {
    const raw = TIER_START_BPS - i * step;
    values.push(Math.round(raw));
  }
  return values;
}

const TIER_BPS = buildTierBps();
const CONSOLATION1_BPS = 2_000; // 20%
const CONSOLATION2_BPS = 3_000; // 30%
const TOTAL_TIER_BPS = TIER_BPS.reduce((acc, value) => acc + value, 0);
const LOSE_BPS = 10_000 - (CONSOLATION1_BPS + CONSOLATION2_BPS + TOTAL_TIER_BPS);

function buildTierLadder() {
  return Array.from({ length: TIER_COUNT }, (_, index) => ({
    prizeMetric: index === TIER_COUNT - 1 ? 9_000n : 2_000n,
    isTerminal: index === TIER_COUNT - 1,
    isPercent: true,
    fixedBetCost: 0n,
    useDynamicCost: true,
  }));
}

function buildJackpotOutcomes() {
  const entries: {
    cumulativeProbability: bigint;
    tierAdvance: number;
    tierResetTo: number;
    consolationMultiplier: number;
    awardsTier: boolean;
  }[] = [];

  let running = 0n;
  if (LOSE_BPS > 0) {
    running += BigInt(LOSE_BPS);
    entries.push({
      cumulativeProbability: running,
      tierAdvance: 0,
      tierResetTo: 0,
      consolationMultiplier: 0,
      awardsTier: false,
    });
  }

  if (CONSOLATION1_BPS > 0) {
    running += BigInt(CONSOLATION1_BPS);
    entries.push({
      cumulativeProbability: running,
      tierAdvance: 0,
      tierResetTo: 0,
      consolationMultiplier: 1_200,
      awardsTier: false,
    });
  }

  if (CONSOLATION2_BPS > 0) {
    running += BigInt(CONSOLATION2_BPS);
    entries.push({
      cumulativeProbability: running,
      tierAdvance: 0,
      tierResetTo: 0,
      consolationMultiplier: 1_500,
      awardsTier: false,
    });
  }

  for (let i = 0; i < TIER_COUNT; i += 1) {
    running += BigInt(TIER_BPS[i]);
    entries.push({
      cumulativeProbability: running,
      tierAdvance: 1,
      tierResetTo: 0,
      consolationMultiplier: 0,
      awardsTier: true,
    });
  }

  if (running !== 10_000n) {
    throw new Error(`Jackpot outcome probabilities sum to ${running}, expected 10000`);
  }

  return entries;
}

function buildDirectBetOutcomes() {
  const totalWeight = DIRECT_BET_WEIGHTS.reduce((acc, entry) => acc + entry.weight, 0);
  let running = 0n;

  return DIRECT_BET_WEIGHTS.map((entry, index) => {
    const isLast = index === DIRECT_BET_WEIGHTS.length - 1;
    const raw = (entry.weight * 10_000) / totalWeight;
    const probabilityBps = isLast ? Number(10_000n - running) : Math.round(raw);
    running += BigInt(probabilityBps);

    if (running > 10_000n) {
      throw new Error(`Direct bet outcome probabilities overflow: ${running}`);
    }

    return {
      cumulativeProbability: running,
      tierAdvance: entry.tierAdvance,
      tierResetTo: entry.tierResetTo,
      consolationMultiplier: entry.consolationMultiplier,
      awardsTier: entry.awardsTier,
    };
  });
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

  const jackpotOutcomes = buildJackpotOutcomes();
  const directBetOutcomes = buildDirectBetOutcomes();

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

  await jackpot.write.registerGame([
    roulette.address,
    jackpotOutcomes,
  ], { account: deployer.account });

  await jackpot.write.setGameStatus([roulette.address, true], { account: deployer.account });

  await jackpot.write.configureDirectBet([
    true,
    directBetOutcomes,
  ], { account: deployer.account });

  const directBetOutcomesConfigured = await jackpot.read.getDirectBetOutcomes();
  console.log("Direct bet outcomes configured:", directBetOutcomesConfigured.length);

  await roulette.write.setTableConfig([DEFAULT_TABLE_CONFIG], { account: deployer.account });

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

