import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";
import "dotenv/config";
// Reuse your existing outcome/ladder builders (kept minimal here)
const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 500;
const REFERRAL_BPS = 200;

const DEFAULT_TABLE_CONFIG = {
  enabled: true,
  replayBps: 1_000,
  jackpotBps: 0,
  jackpotContributionBps: 350,
  minMultiplier: 101,
  maxMultiplier: 10_000,
  minWager: parseEther("0.01"),
  maxWager: parseEther("100"),
};

const CONSUMER_RANGE_LIMIT = 7n; // 6 base rolls + 1 jackpot
const JACKPOT_START = parseEther("300");

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
    extraData: "0x",
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
    extraData: "0x",
  };
}
function buildScaledOutcomes(): OutcomeConfig[] {
  const outcomes: OutcomeConfig[] = [];
  // 0) explicit lose
  outcomes.push({ scaling: scalingConst(300), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false });
  // 1) 1.2x
  outcomes.push({ scaling: scalingConst(500), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12_000, awardsTier: false });
  // 2) 1.5x
  outcomes.push({ scaling: scalingConst(200), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15_000, awardsTier: false });

  // 3..11) tier-awards
  outcomes.push({ scaling: scalingRange(200, 9000, "100", "600", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(200, 9000, "120", "620", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(200, 9000, "140", "640", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(200, 9000, "160", "660", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });

  outcomes.push({ scaling: scalingRange(1000, 6000, "300", "500", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(800, 6000, "350", "600", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(600, 6000, "400", "700", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });

  outcomes.push({ scaling: scalingRange(200, 3000, "450", "900", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(50, 2000, "750", "1400", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });

  return outcomes;
}

async function main() {
    const VRF_COORDINATOR = process.env.VRF_COORDINATOR as `0x${string}` | undefined;
    const VRF_KEY_HASH = process.env.VRF_KEY_HASH as `0x${string}` | undefined;
    const VRF_SUBSCRIPTION_ID_STR = process.env.VRF_SUBSCRIPTION_ID;
    
    if (!VRF_COORDINATOR || !VRF_KEY_HASH || !VRF_SUBSCRIPTION_ID_STR) {
      throw new Error("Missing VRF env: set VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUBSCRIPTION_ID");
    }
    const VRF_SUBSCRIPTION_ID = BigInt(VRF_SUBSCRIPTION_ID_STR);

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();        // single key on testnet
  const house = deployer;
  const fallback = deployer;
  const player = deployer;

  // Deploy token
  const token = await viem.deployContract("EverValueCoin");
  console.log("EVA token:", token.address);

  // Deploy RandomProvider (real coordinator)
  const randomProvider = await viem.deployContract("RandomProvider", [VRF_COORDINATOR]);
  console.log("Random provider:", randomProvider.address);
  await randomProvider.write.setKeyHash([VRF_KEY_HASH], { account: deployer.account });
  await randomProvider.write.setSubscriptionId([VRF_SUBSCRIPTION_ID], { account: deployer.account });

  const publicClient = await viem.getPublicClient();

// Add RandomProvider as a consumer on the real VRF Coordinator
const VRF_COORDINATOR_ABI = [
    {
      type: "function",
      name: "addConsumer",
      stateMutability: "nonpayable",
      inputs: [
        { name: "subId", type: "uint256", internalType: "uint256" },
        { name: "consumer", type: "address", internalType: "address" },
      ],
      outputs: [],
    },
    {
      type: "function",
      name: "getSubscription",
      stateMutability: "view",
      inputs: [{ name: "subId", type: "uint256", internalType: "uint256" }],
      outputs: [
        { name: "balance", type: "uint96", internalType: "uint96" },
        { name: "nativeBalance", type: "uint96", internalType: "uint96" },
        { name: "reqCount", type: "uint64", internalType: "uint64" },
        { name: "owner", type: "address", internalType: "address" },
        { name: "consumers", type: "address[]", internalType: "address[]" },
      ],
    },
  ] as const;
    
  try {
    const txHash = await deployer.writeContract({
      address: VRF_COORDINATOR,
      abi: VRF_COORDINATOR_ABI,
      functionName: "addConsumer",
      args: [VRF_SUBSCRIPTION_ID, randomProvider.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("✓ RandomProvider added as VRF consumer");
  
    // Optional verification
    const sub: any = await publicClient.readContract({
      address: VRF_COORDINATOR,
      abi: VRF_COORDINATOR_ABI,
      functionName: "getSubscription",
      args: [VRF_SUBSCRIPTION_ID],
    });
    console.log("Consumers now:", sub[4]);
  } catch (e) {
    console.warn("⚠ addConsumer failed (already added or not subscription owner?)", e);
  }

  // Deploy payment handler and referral
  const handler = await viem.deployContract("PaymentHandler", [token.address]);
  console.log("Payment handler:", handler.address);

  const referral = await viem.deployContract("MultiLevelReferral", [token.address, fallback.account.address]);
  console.log("Multi-level referral:", referral.address);

  await handler.write.setReferralContract([referral.address], { account: deployer.account });
  await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
  await referral.write.setDefaultReceiver([fallback.account.address], { account: deployer.account });
  await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });

  // Deploy jackpot and roulette
  const jackpot = await viem.deployContract("ProgressiveJackpot", [token.address, randomProvider.address]);
  console.log("Progressive jackpot:", jackpot.address);
  await jackpot.write.setTierLadder([buildTierLadder()], { account: deployer.account });

  const roulette = await viem.deployContract("SingleRandomRoulette", [handler.address, randomProvider.address, token.address]);
  console.log("Single random roulette:", roulette.address);

  const outcomes = buildScaledOutcomes();

  // Register roulette in handler
// Register roulette in handler → then enable
    const reg1 = await handler.write.registerGame([roulette.address, roulette.address, house.account.address, HOUSE_EDGE_BPS, REFERRAL_BPS], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: reg1 });

    const en1 = await handler.write.setGameStatus([roulette.address, true], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: en1 });

  // Whitelist consumers in RandomProvider
  const c1 = await randomProvider.write.setConsumerStatus([roulette.address, true, CONSUMER_RANGE_LIMIT], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: c1 });
  const c2 = await randomProvider.write.setConsumerStatus([jackpot.address, true, CONSUMER_RANGE_LIMIT], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: c2 });

  // Wire jackpot with roulette
  const setJ = await roulette.write.setJackpot([jackpot.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: setJ });
  const regJP = await jackpot.write.registerGame([roulette.address, outcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: regJP });
  const enJP = await jackpot.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: enJP });
  const cfgDB = await jackpot.write.configureDirectBet([true, outcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: cfgDB });

  // Set fallback outcomes (0 = explicit lose)
  const fbG = await jackpot.write.setGameFallback([roulette.address, 0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: fbG });
  const fbD = await jackpot.write.setDirectFallback([0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: fbD });

  // Configure roulette table and jackpot scaling
  const tbl = await roulette.write.setTableConfig([DEFAULT_TABLE_CONFIG], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tbl });
  const jsc = await roulette.write.setJackpotScalingConfig([{
    enabled: true,
    minJackpotBps: 500,
    maxJackpotBps: 2000,
    minJackpotWager: parseEther("0.01"),
    maxJackpotWager: parseEther("100"),
    functionId: SCALING_LOG,
    extraData: "0x",
  }], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: jsc });

  // Seed balances and approvals
  await token.write.transfer([jackpot.address, JACKPOT_START], { account: deployer.account });
  await token.write.transfer([house.account.address, parseEther("100")], { account: deployer.account });
  await token.write.transfer([fallback.account.address, parseEther("100")], { account: deployer.account });
  await token.write.transfer([roulette.address, parseEther("1000")], { account: deployer.account });

  await token.write.approve([handler.address, parseEther("1000")], { account: deployer.account });

  // Register jackpot in handler for direct-bet flow
  const setPH = await jackpot.write.setPaymentHandler([handler.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: setPH });
  const regJ = await handler.write.registerGame([jackpot.address, jackpot.address, house.account.address, HOUSE_EDGE_BPS, REFERRAL_BPS], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: regJ });
  const enJ = await handler.write.setGameStatus([jackpot.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: enJ });

  // Persist deployment
  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const path = new URL("arb-sepolia.json", deploymentsDir);
  await fs.writeFile(path, JSON.stringify({
    token: token.address,
    randomProvider: randomProvider.address,
    handler: handler.address,
    referral: referral.address,
    jackpot: jackpot.address,
    roulette: roulette.address,
    house: house.account.address,
    fallback: fallback.account.address,
    samplePlayer: player.account.address,
  }, null, 2));
  console.log("Deployment info saved to", path.pathname);

  console.log("\nNext step: add RandomProvider as a consumer in your Chainlink VRF subscription and fund it with test LINK.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });