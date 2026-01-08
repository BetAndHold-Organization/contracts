import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";
import { spawn } from "node:child_process";
import "dotenv/config";

type Addr = `0x${string}`;

const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 500;
const REFERRAL_BPS = 200;
const VERIFY = true;

const MIN_WAGER = parseEther("0.1");
const MAX_WAGER = parseEther("3");
const JACKPOT_START = parseEther("10"); // adjust as needed
const JACKPOT_CONTRIB_BPS = 350;

const CONSUMER_RANGE_LIMIT = 7n;

function runVerifyCli(networkName: string, address: Addr, args: any[] = []) {
  return new Promise<void>((resolve, reject) => {
    const argv = ["hardhat", "verify", "--network", networkName, address, ...args.map(String)];
    const p = spawn(process.platform === "win32" ? "npx.cmd" : "npx", argv, { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`verify exit ${code}`))));
    p.on("error", reject);
  });
}

async function verifyWithRetryCli(networkName: string, address: Addr, args: any[] = []) {
  if (!VERIFY) return;
  for (let i = 0; i < 3; i++) {
    try {
      await runVerifyCli(networkName, address, args);
      console.log("✓ Verified", address);
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Already Verified")) {
        console.log("✓ Already verified", address);
        return;
      }
      if (i < 2) {
        console.warn("↻ verify retry in 15s:", address, msg);
        await new Promise((r) => setTimeout(r, 15_000));
      } else {
        console.warn("⚠ verify failed:", address, e);
      }
    }
  }
}

function buildTierLadder() {
  const TIER_COUNT = 9;
  const P = [1000n, 1000n, 1000n, 1000n, 2000n, 2000n, 2000n, 2000n, 8000n];
  return Array.from({ length: TIER_COUNT }, (_, index) => ({
    prizeMetric: P[index],
    isTerminal: index === TIER_COUNT - 1,
    isPercent: true,
    fixedBetCost: 0n,
    useDynamicCost: true,
    costBps: 1000, // 20% of prize as direct-bet cost
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
  outcomes.push({ scaling: scalingConst(300), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false });
  outcomes.push({ scaling: scalingConst(500), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12_000, awardsTier: false });
  outcomes.push({ scaling: scalingConst(200), tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15_000, awardsTier: false });
  outcomes.push({ scaling: scalingRange(200, 9000, "2", "12", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(200, 9000, "2", "12", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(200, 9000, "2", "12", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(200, 9000, "8", "18", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(1000, 6000, "8", "24", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(800, 6000, "8", "24", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(600, 6000, "10", "28", SCALING_LINEAR), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(200, 3000, "18", "35", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  outcomes.push({ scaling: scalingRange(50, 2000, "40", "60", SCALING_QUADRATIC), tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  return outcomes;
}

function parseList(envVal: string | undefined): Addr[] {
  if (!envVal) return [];
  return envVal.split(",").map((s) => s.trim() as Addr).filter((s) => s.length > 0);
}

async function loadWhitelist(): Promise<Addr[]> {
  const path = new URL("../referrals/whitelist-wallets.json", import.meta.url);
  const raw = await fs.readFile(path, "utf8");
  const data = JSON.parse(raw);
  return (data.whitelist as { wallet: string }[]).map((w) => w.wallet as Addr);
}

async function loadReferralSeed(): Promise<{ referees: Addr[]; referrers: Addr[] }> {
  const path = new URL("../referrals/referral-seed.json", import.meta.url);
  const raw = await fs.readFile(path, "utf8");
  const data = JSON.parse(raw) as { referrals: { referee: string; referrer: string }[] };
  const referees = data.referrals.map((r) => r.referee as Addr);
  const referrers = data.referrals.map((r) => r.referrer as Addr);
  return { referees, referrers };
}

async function main() {
  const VRF_COORDINATOR = (process.env.MAINNET_VRF_COORDINATOR || "").trim() as Addr | undefined;
  const VRF_KEY_HASH = (process.env.MAINNET_VRF_KEY_HASH || "").trim() as Addr | undefined;
  const VRF_SUBSCRIPTION_ID_STR = (process.env.MAINNET_VRF_SUBSCRIPTION_ID || "").trim();
  const TOKEN_ADDRESS_ENV_RAW = (process.env.MAINNET_TOKEN_ADDRESS || "").trim();
  const TOKEN_ADDRESS_ENV = TOKEN_ADDRESS_ENV_RAW.length > 0 ? (TOKEN_ADDRESS_ENV_RAW as Addr) : undefined;
  // Force whitelist-only mode for closed test
  const WL_ENABLED = true;
  const BLACKLIST: Addr[] = [];
  const BL_ENABLED = false;

  if (!VRF_COORDINATOR || !VRF_KEY_HASH || !VRF_SUBSCRIPTION_ID_STR) {
    throw new Error("Missing VRF env: MAINNET_VRF_COORDINATOR, MAINNET_VRF_KEY_HASH, MAINNET_VRF_SUBSCRIPTION_ID");
  }
  const VRF_SUBSCRIPTION_ID = BigInt(VRF_SUBSCRIPTION_ID_STR);

  const whitelist = await loadWhitelist();
  const referralSeed = await loadReferralSeed();

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const house = deployer;
  const fallback = deployer;
  const player = deployer;

  console.log("Deployer:", deployer.account.address);
  const publicClient = await viem.getPublicClient();

  // Token
  let tokenAddress: Addr;
  if (TOKEN_ADDRESS_ENV) {
    tokenAddress = TOKEN_ADDRESS_ENV;
    console.log("Using existing token:", tokenAddress);
  } else {
    const token = await viem.deployContract("EverValueCoin");
    tokenAddress = token.address;
    console.log("Deployed new token:", tokenAddress);
  }

  // RandomProvider
  const randomProvider = await viem.deployContract("RandomProvider", [VRF_COORDINATOR]);
  console.log("Random provider:", randomProvider.address);
  await randomProvider.write.setKeyHash([VRF_KEY_HASH], { account: deployer.account });
  await randomProvider.write.setSubscriptionId([VRF_SUBSCRIPTION_ID], { account: deployer.account });

  // Add as consumer
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
  } catch (e) {
    console.warn("⚠ addConsumer failed (already added or not subscription owner?)", e);
  }

  // Payment handler and referral
  const handler = await viem.deployContract("PaymentHandler", [tokenAddress]);
  console.log("Payment handler:", handler.address);

  const referral = await viem.deployContract("MultiLevelReferral", [tokenAddress, fallback.account.address]);
  console.log("Multi-level referral:", referral.address);

  await handler.write.setReferralContract([referral.address], { account: deployer.account });
  await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
  await referral.write.setDefaultReceiver([fallback.account.address], { account: deployer.account });
  await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });

  // Whitelist / blacklist
  // Enforce whitelist-only; no blacklist for this closed test
  await handler.write.setWhitelistEnabled([true], { account: deployer.account });
  if (whitelist.length > 0) {
    await handler.write.setWhitelist([whitelist, true], { account: deployer.account });
  }

  // Seed referral tree (owner-only)
  if (referralSeed.referees.length > 0) {
    await referral.write.adminSetReferrers([referralSeed.referees, referralSeed.referrers], { account: deployer.account });
    console.log("Referral tree seeded:", referralSeed.referees.length, "entries");
  }

  // Jackpot and roulette
  const jackpot = await viem.deployContract("ProgressiveJackpot", [tokenAddress, randomProvider.address]);
  console.log("Progressive jackpot:", jackpot.address);
  await jackpot.write.setTierLadder([buildTierLadder()], { account: deployer.account });

  const roulette = await viem.deployContract("SingleRandomRoulette", [handler.address, randomProvider.address, tokenAddress]);
  console.log("Single random roulette:", roulette.address);

  const outcomes = buildScaledOutcomes();

  // Register roulette in handler
  const reg1 = await handler.write.registerGame(
    [roulette.address, roulette.address, house.account.address, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: reg1 });
  const en1 = await handler.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: en1 });

  // Whitelist consumers
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

  // Fallbacks
  const fbG = await jackpot.write.setGameFallback([roulette.address, 0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: fbG });
  const fbD = await jackpot.write.setDirectFallback([0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: fbD });

  // Roulette config
  const tbl = await roulette.write.setTableConfig([{
    enabled: true,
    replayBps: 1_000,
    jackpotBps: 0,
    jackpotContributionBps: JACKPOT_CONTRIB_BPS,
    minMultiplier: 101,
    maxMultiplier: 10_000,
    minWager: MIN_WAGER,
    maxWager: MAX_WAGER,
  }], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tbl });
  const jsc = await roulette.write.setJackpotScalingConfig([{
    enabled: true,
    minJackpotBps: 500,
    maxJackpotBps: 2000,
    minJackpotWager: parseEther("0.1"),
    maxJackpotWager: parseEther("1"),
    functionId: SCALING_LOG,
    extraData: "0x",
  }], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: jsc });

  // Seed balances (skip if using existing token without mint rights)
  if (!TOKEN_ADDRESS_ENV) {
    const token = await viem.getContractAt("EverValueCoin", tokenAddress);
    await token.write.transfer([jackpot.address, JACKPOT_START], { account: deployer.account });
    //await token.write.transfer([house.account.address, parseEther("1000")], { account: deployer.account });
    //await token.write.transfer([fallback.account.address, parseEther("1000")], { account: deployer.account });
    await token.write.transfer([roulette.address, parseEther("10")], { account: deployer.account });
    await token.write.approve([handler.address, parseEther("2000")], { account: deployer.account });
  }

  // Register jackpot in handler
  const setPH = await jackpot.write.setPaymentHandler([handler.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: setPH });
  const regJ = await handler.write.registerGame([jackpot.address, jackpot.address, house.account.address, HOUSE_EDGE_BPS, REFERRAL_BPS], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: regJ });
  const enJ = await handler.write.setGameStatus([jackpot.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: enJ });

  // Persist deployment
  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const path = new URL("./deployments/arb-mainnet.json", import.meta.url);
  await fs.writeFile(path, JSON.stringify({
    token: tokenAddress,
    randomProvider: randomProvider.address,
    handler: handler.address,
    referral: referral.address,
    jackpot: jackpot.address,
    roulette: roulette.address,
    house: house.account.address,
    fallback: fallback.account.address,
    samplePlayer: player.account.address,
    whitelistEnabled: WL_ENABLED,
    blacklistEnabled: BL_ENABLED,
    whitelist,
    blacklist: BLACKLIST,
    referralSeedCount: referralSeed.referees.length,
  }, null, 2));
  console.log("Deployment info saved to", path.pathname);

  const networkName = "arbitrum";

  await new Promise(r => setTimeout(r, 30_000));

  await verifyWithRetryCli(networkName, tokenAddress, []);
  await verifyWithRetryCli(networkName, randomProvider.address, [VRF_COORDINATOR]);
  await verifyWithRetryCli(networkName, handler.address, [tokenAddress]);
  await verifyWithRetryCli(networkName, referral.address, [tokenAddress, fallback.account.address]);
  await verifyWithRetryCli(networkName, jackpot.address, [tokenAddress, randomProvider.address]);
  await verifyWithRetryCli(networkName, roulette.address, [handler.address, randomProvider.address, tokenAddress]);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

