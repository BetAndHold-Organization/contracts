import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";
import { spawn } from "node:child_process";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 200;       // 2%
const REFERRAL_BPS = 200;         // 2%
const VERIFY = true;

// Roulette config
const MIN_WAGER = parseEther("0.1");
const MAX_WAGER = parseEther("3");
const JACKPOT_CONTRIB_BPS = 350;  // 3.5% of net stake
const REPLAY_BPS = 1000;          // 10% replay chance

// Jackpot V2 config
const JACKPOT_START = parseEther("10");

// Tier share distribution (must sum to 10000)
// Default: 6.25% each for tiers 1-8, 50% for tier 9
const TIER_SHARES: readonly [number, number, number, number, number, number, number, number, number] = 
  [625, 625, 625, 625, 625, 625, 625, 625, 5000];

// Probability config for all tiers
const PROB_MIN_BPS = 100;          // 1% starting probability
const PROB_MAX_BPS = 5000;         // 50% max probability
const PROB_INCREMENT_BPS = 10;     // 0.1% increase per entry

// Fixed costs per tier in EVA
const TIER_COSTS = [
  parseEther("0.5"),   // Tier 1
  parseEther("0.6"),   // Tier 2
  parseEther("0.7"),   // Tier 3
  parseEther("0.8"),   // Tier 4
  parseEther("1.0"),   // Tier 5
  parseEther("1.2"),   // Tier 6
  parseEther("1.5"),   // Tier 7
  parseEther("2.0"),   // Tier 8
  parseEther("3.0"),   // Tier 9
] as const;

const CONSUMER_RANGE_LIMIT = 7n;
const SCALING_LOG = 2;

// ═══════════════════════════════════════════════════════════════════════════
// VERIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// JACKPOT V2 CONFIGURATION BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

function buildTierLadderV2() {
  return Array.from({ length: 9 }, (_, index) => ({
    prizeMetric: 0n,                      // Unused in V2 (prize = pot balance)
    isTerminal: index === 8,              // Tier 9 is terminal
    isPercent: false,                     // Unused in V2
    fixedBetCost: TIER_COSTS[index],      // Fixed cost per tier
    useDynamicCost: false,                // Always false in V2
    costBps: 0,                           // Unused in V2
  }));
}

/**
 * Build outcomes for ProgressiveJackpotV2
 * 
 * Structure:
 * - Outcome 0: Pure lose (no payout, no tier advance)
 * - Outcome 1: Consolation 1.2x
 * - Outcome 2: Consolation 1.5x
 * - Outcomes 3-11: Tier awards (tiers 1-9)
 */
function buildOutcomesV2() {
  const outcomes = [];
  
  // Outcome 0: Pure lose
  outcomes.push({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 0,
    awardsTier: false,
  });
  
  // Outcome 1: Consolation 1.2x
  outcomes.push({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 12_000,  // 1.2x
    awardsTier: false,
  });
  
  // Outcome 2: Consolation 1.5x
  outcomes.push({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 15_000,  // 1.5x
    awardsTier: false,
  });
  
  // Outcomes 3-11: Tier awards (tiers 1-9)
  for (let tier = 0; tier < 9; tier++) {
    outcomes.push({
      enabled: true,
      tierAdvance: 1,
      tierResetTo: 0,
      consolationMultiplier: 0,
      awardsTier: true,
    });
  }
  
  return outcomes;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN DEPLOYMENT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const VRF_COORDINATOR = (process.env.MAINNET_VRF_COORDINATOR || "").trim() as Addr | undefined;
  const VRF_KEY_HASH = (process.env.MAINNET_VRF_KEY_HASH || "").trim() as Addr | undefined;
  const VRF_SUBSCRIPTION_ID_STR = (process.env.MAINNET_VRF_SUBSCRIPTION_ID || "").trim();
  const TOKEN_ADDRESS_ENV_RAW = (process.env.MAINNET_TOKEN_ADDRESS || "").trim();
  const TOKEN_ADDRESS_ENV = TOKEN_ADDRESS_ENV_RAW.length > 0 ? (TOKEN_ADDRESS_ENV_RAW as Addr) : undefined;

  if (!VRF_COORDINATOR || !VRF_KEY_HASH || !VRF_SUBSCRIPTION_ID_STR) {
    throw new Error("Missing VRF env: MAINNET_VRF_COORDINATOR, MAINNET_VRF_KEY_HASH, MAINNET_VRF_SUBSCRIPTION_ID");
  }
  const VRF_SUBSCRIPTION_ID = BigInt(VRF_SUBSCRIPTION_ID_STR);

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  
  // House and referral fallback wallet
  const HOUSE_FALLBACK_WALLET = "0x8248f7b7f7cb8fa51db9138b42a6bb7af1721e9e" as Addr;
  const houseAddress = HOUSE_FALLBACK_WALLET;
  const fallbackAddress = HOUSE_FALLBACK_WALLET;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DEPLOYING V2 CONTRACTS TO ARBITRUM MAINNET");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.account.address);
  console.log("House/Fallback wallet:", HOUSE_FALLBACK_WALLET);
  console.log("");
  
  const publicClient = await viem.getPublicClient();

  // ─────────────────────────────────────────────────────────────────────────
  // 1. TOKEN
  // ─────────────────────────────────────────────────────────────────────────
  let tokenAddress: Addr;
  if (TOKEN_ADDRESS_ENV) {
    tokenAddress = TOKEN_ADDRESS_ENV;
    console.log("✓ Using existing token:", tokenAddress);
  } else {
    const token = await viem.deployContract("EverValueCoin");
    tokenAddress = token.address;
    console.log("✓ Deployed new token:", tokenAddress);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. RANDOM PROVIDER
  // ─────────────────────────────────────────────────────────────────────────
  const randomProvider = await viem.deployContract("RandomProvider", [VRF_COORDINATOR]);
  console.log("✓ Random provider:", randomProvider.address);
  
  await randomProvider.write.setKeyHash([VRF_KEY_HASH], { account: deployer.account });
  await randomProvider.write.setSubscriptionId([VRF_SUBSCRIPTION_ID], { account: deployer.account });

  // Add RandomProvider as VRF consumer
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
    console.log("  └─ Added as VRF consumer");
  } catch (e) {
    console.warn("  └─ ⚠ addConsumer failed (already added or not subscription owner?)");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. PAYMENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  const handler = await viem.deployContract("PaymentHandler", [tokenAddress]);
  console.log("✓ Payment handler:", handler.address);

  // ─────────────────────────────────────────────────────────────────────────
  // 4. MULTI-LEVEL REFERRAL
  // ─────────────────────────────────────────────────────────────────────────
  const referral = await viem.deployContract("MultiLevelReferral", [tokenAddress, fallbackAddress]);
  console.log("✓ Multi-level referral:", referral.address);

  // Wire handler and referral
  await handler.write.setReferralContract([referral.address], { account: deployer.account });
  await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
  await referral.write.setDefaultReceiver([fallbackAddress], { account: deployer.account });
  await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });
  await handler.write.setWhitelistEnabled([false], { account: deployer.account });
  console.log("  └─ Configured (whitelist disabled)");

  // ─────────────────────────────────────────────────────────────────────────
  // 5. PROGRESSIVE JACKPOT V2
  // ─────────────────────────────────────────────────────────────────────────
  const jackpot = await viem.deployContract("ProgressiveJackpotV2", [tokenAddress, randomProvider.address]);
  console.log("✓ Progressive Jackpot V2:", jackpot.address);

  // Configure tier ladder (fixed costs)
  const tierLadder = buildTierLadderV2();
  let tx = await jackpot.write.setTierLadder([tierLadder], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Tier ladder configured");

  // Configure tier shares (distribution of funds)
  tx = await jackpot.write.setTierShares([TIER_SHARES], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Tier shares configured");

  // Configure probability scaling for all tiers
  tx = await jackpot.write.setAllTierProbConfigs(
    [PROB_MIN_BPS, PROB_MAX_BPS, PROB_INCREMENT_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Probability configs set");

  // ─────────────────────────────────────────────────────────────────────────
  // 6. SINGLE RANDOM ROULETTE V2
  // ─────────────────────────────────────────────────────────────────────────
  const roulette = await viem.deployContract("SingleRandomRouletteV2", [
    handler.address,
    randomProvider.address,
    tokenAddress,
  ]);
  console.log("✓ Single Random Roulette V2:", roulette.address);

  // ─────────────────────────────────────────────────────────────────────────
  // 7. REGISTER GAMES IN RANDOM PROVIDER
  // ─────────────────────────────────────────────────────────────────────────
  tx = await randomProvider.write.setConsumerStatus(
    [roulette.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Roulette registered in RandomProvider");

  tx = await randomProvider.write.setConsumerStatus(
    [jackpot.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Jackpot registered in RandomProvider");

  // ─────────────────────────────────────────────────────────────────────────
  // 8. REGISTER ROULETTE IN PAYMENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  tx = await handler.write.registerGame(
    [roulette.address, roulette.address, houseAddress, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await handler.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Roulette registered in PaymentHandler");

  // ─────────────────────────────────────────────────────────────────────────
  // 9. WIRE JACKPOT WITH ROULETTE
  // ─────────────────────────────────────────────────────────────────────────
  tx = await roulette.write.setJackpot([jackpot.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Jackpot linked to Roulette");

  const outcomes = buildOutcomesV2();

  tx = await jackpot.write.registerGame([roulette.address, outcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await jackpot.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Roulette registered in Jackpot");

  tx = await jackpot.write.setGameFallback([roulette.address, 0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Game fallback set");

  // ─────────────────────────────────────────────────────────────────────────
  // 10. CONFIGURE DIRECT BETS ON JACKPOT
  // ─────────────────────────────────────────────────────────────────────────
  tx = await jackpot.write.configureDirectBet([true, outcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await jackpot.write.setDirectFallback([0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Direct bet configured");

  // Register jackpot in payment handler
  tx = await jackpot.write.setPaymentHandler([handler.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await handler.write.registerGame(
    [jackpot.address, jackpot.address, houseAddress, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await handler.write.setGameStatus([jackpot.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Jackpot registered in PaymentHandler");

  // ─────────────────────────────────────────────────────────────────────────
  // 11. CONFIGURE ROULETTE TABLE
  // ─────────────────────────────────────────────────────────────────────────
  tx = await roulette.write.setTableConfig([{
    enabled: true,
    replayBps: REPLAY_BPS,
    jackpotBps: 0,                          // Scaled via JackpotScalingConfig
    jackpotContributionBps: JACKPOT_CONTRIB_BPS,
    minMultiplier: 101,                     // 1.01x minimum
    maxMultiplier: 10_000,                  // 100x maximum
    minWager: MIN_WAGER,
    maxWager: MAX_WAGER,
  }], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Table config set");

  tx = await roulette.write.setJackpotScalingConfig([{
    enabled: true,
    minJackpotBps: 500,                     // 5% at min wager
    maxJackpotBps: 2000,                    // 20% at max wager
    minJackpotWager: parseEther("0.1"),
    maxJackpotWager: parseEther("1"),
    functionId: SCALING_LOG,
    extraData: "0x",
  }], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  └─ Jackpot scaling config set");

  // ─────────────────────────────────────────────────────────────────────────
  // 12. SEED BALANCES (if new token)
  // ─────────────────────────────────────────────────────────────────────────
  if (!TOKEN_ADDRESS_ENV) {
    const token = await viem.getContractAt("EverValueCoin", tokenAddress);
    
    // Seed jackpot (distributed across tier pots)
    tx = await token.write.transfer([jackpot.address, JACKPOT_START], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    
    // Seed roulette liquidity
    tx = await token.write.transfer([roulette.address, parseEther("10")], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    
    // Approve handler for testing
    tx = await token.write.approve([handler.address, parseEther("2000")], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    
    console.log("  └─ Balances seeded");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 13. SAVE DEPLOYMENT
  // ─────────────────────────────────────────────────────────────────────────
  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  
  const deploymentData = {
    version: "V2",
    deployedAt: new Date().toISOString(),
    token: tokenAddress,
    randomProvider: randomProvider.address,
    handler: handler.address,
    referral: referral.address,
    jackpot: jackpot.address,
    roulette: roulette.address,
    house: houseAddress,
    fallback: fallbackAddress,
    deployer: deployer.account.address,
    config: {
      tierShares: TIER_SHARES,
      tierCosts: TIER_COSTS.map(c => c.toString()),
      probMin: PROB_MIN_BPS,
      probMax: PROB_MAX_BPS,
      probIncrement: PROB_INCREMENT_BPS,
      minWager: MIN_WAGER.toString(),
      maxWager: MAX_WAGER.toString(),
      jackpotContribBps: JACKPOT_CONTRIB_BPS,
      replayBps: REPLAY_BPS,
    },
  };

  const path = new URL("./deployments/arb-mainnet-v2.json", import.meta.url);
  await fs.writeFile(path, JSON.stringify(deploymentData, null, 2));

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Saved to:", path.pathname);
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // 14. VERIFY CONTRACTS
  // ─────────────────────────────────────────────────────────────────────────
  console.log("Waiting 30s before verification...");
  await new Promise(r => setTimeout(r, 30_000));

  const networkName = "arbitrum";

  if (!TOKEN_ADDRESS_ENV) {
    await verifyWithRetryCli(networkName, tokenAddress, []);
  }
  await verifyWithRetryCli(networkName, randomProvider.address, [VRF_COORDINATOR]);
  await verifyWithRetryCli(networkName, handler.address, [tokenAddress]);
  await verifyWithRetryCli(networkName, referral.address, [tokenAddress, fallbackAddress]);
  await verifyWithRetryCli(networkName, jackpot.address, [tokenAddress, randomProvider.address]);
  await verifyWithRetryCli(networkName, roulette.address, [handler.address, randomProvider.address, tokenAddress]);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ALL DONE!");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

