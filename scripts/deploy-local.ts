import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { keccak256, parseEther } from "viem";

const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 500;
const REFERRAL_BPS = 200;

export const DEFAULT_TABLE_CONFIG = {
  enabled: true,
  replayBps: 1_000,            // 10% per roll
  jackpotBps: 0,               // use scaling below
  jackpotContributionBps: 350, // 3.5% of net stake to jackpot
  minMultiplier: 101,          // 1.01x
  maxMultiplier: 10_000,       // 100x
  minWager: parseEther("0.01"),
  maxWager: parseEther("100"),
};

const KEY_HASH = keccak256("0x01");
const SUBSCRIPTION_ID = 1n;
const JACKPOT_START = parseEther("300");
const CONSUMER_RANGE_LIMIT = 7n;

// New scaled/static probability configuration in bps
const TIER_COUNT = 9;
// Explicit lose slice (fallback remainder is also lose). Keep small to preserve headroom.
const LOSE_BASE_BPS = 300; // 3%
// Consolations: exactly two, as required: 1.2x and 1.5x. Probabilities are conservative to protect solvency.
const CONSOLATION_12_PROB_BPS = 500; // 5%
const CONSOLATION_15_PROB_BPS = 200; // 2%

function buildTierLadder() {
  const TIER_COUNT = 9;
  const P = [1000n, 1000n, 1000n, 1000n, 2000n, 2000n, 2000n, 2000n, 8000n];
  return Array.from({ length: TIER_COUNT }, (_, index) => ({
    prizeMetric: P[index],
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

  // 0) explicit lose
  outcomes.push({
    scaling: scalingConst(LOSE_BASE_BPS),
    tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false,
  });

  // 1) 1.2x consolation
  outcomes.push({
    scaling: scalingConst(CONSOLATION_12_PROB_BPS),
    tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12_000, awardsTier: false,
  });

  // 2) 1.5x consolation
  outcomes.push({
    scaling: scalingConst(CONSOLATION_15_PROB_BPS),
    tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15_000, awardsTier: false,
  });

  // 3–11) 9 tier-award outcomes (probability rises with jackpot balance)
  // 3–6) Tier-award outcomes (Quadratic scaling on jackpot balance J)
  // Max 90% to force payout at very high J, “room” beyond 250.

  //Jackpot consolidation phase with a quadratic scaling function
    outcomes.push({ // 3 - Tier 0
      scaling: scalingRange(200, 9000, "100", "600", SCALING_QUADRATIC), // ~10% at J=250
      tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });
    outcomes.push({ // 4 - Tier 1
      scaling: scalingRange(200, 9000, "120", "620", SCALING_QUADRATIC), // ~8% at J=250
      tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });
    outcomes.push({ // 5 - Tier 2
      scaling: scalingRange(200, 9000, "140", "640", SCALING_QUADRATIC), // ~6% at J=250
      tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });
    outcomes.push({ // 6 - Tier 3
      scaling: scalingRange(200, 9000, "160", "660", SCALING_QUADRATIC), // ~5% at J=250
      tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });


  //Jackpot stabilization phase at 400 EVA
    // 7) Tier 4 - linear, medium ~400 EVA
    outcomes.push({
      scaling: scalingRange(1000, 6000, "300", "500", SCALING_LINEAR), // 10% @300 → 60% @500; ~35% @400
      tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });

    // 8) Tier 5 - linear, slightly higher window
    outcomes.push({
      scaling: scalingRange(800, 6000, "350", "600", SCALING_LINEAR),  // 8% @350 → 60% @600; ~18% @400
      tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });

    // 9) Tier 6 - linear, starts near 400 EVA
    outcomes.push({
      scaling: scalingRange(600, 6000, "400", "700", SCALING_LINEAR),  // 6% @400 → 60% @700; 6% @400
      tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });


    //Final stages jackpot.
      // 10) Tier 7 (20% of J) – slow progression around 600 EVA
      outcomes.push({
        // ~5% at J=600; 2% floor; cap 30%; window 450→900, convex (slow early growth)
        scaling: scalingRange(200, 3000, "450", "900", SCALING_QUADRATIC),
        tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
      });

      // 11) Tier 8 (terminal, 80% of J) – very slow progression, force payout only at very high J
      outcomes.push({
        // ~1% at J=600; 0.5% floor; cap 20%; window 500→1200, convex
        scaling: scalingRange(50, 2000, "750", "1400", SCALING_QUADRATIC),
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
  await randomProvider.write.setConsumerStatus([jackpot.address, true, CONSUMER_RANGE_LIMIT], { account: deployer.account });
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
    minJackpotBps: 500,                         // 2.00% per roll at 0.01 EVA
    maxJackpotBps: 2000,                         // 5.00% per roll at 100 EVA
    minJackpotWager: parseEther("0.01"),
    maxJackpotWager: parseEther("100"),
    functionId: SCALING_LOG,                    // concave growth for more entries at low wagers
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
await jackpot.write.setPaymentHandler([handler.address], { account: deployer.account });
console.log("✓ Payment handler set on jackpot");

// ⭐️ NUEVO: Registrar jackpot en payment handler
await handler.write.registerGame([
  jackpot.address,
  jackpot.address,
  house.account.address,
  HOUSE_EDGE_BPS,
  REFERRAL_BPS,
], { account: deployer.account });
console.log("✓ Jackpot registered in payment handler");

await handler.write.setGameStatus([jackpot.address, true], { account: deployer.account });
console.log("✓ Jackpot enabled in payment handler");
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

