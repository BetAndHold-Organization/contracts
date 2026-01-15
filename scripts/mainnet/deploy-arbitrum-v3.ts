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
const REPLAY_BPS = 500;           // 5% replay chance (reduced since jackpot disabled adds to replay)
const JACKPOT_BPS = 100;          // 1% jackpot chance

// Jackpot V2 config
const JACKPOT_START = 0n;  // Will be funded manually after deployment

// Tier share distribution (must sum to 10000)
// 10% each for tiers 0-7, 20% for tier 8
const TIER_SHARES: readonly [number, number, number, number, number, number, number, number, number] = 
  [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];

// Probability config for all tiers (entry-based scaling)
const PROB_MIN_BPS = 10;           // 0.1% starting probability
const PROB_MAX_BPS = 2000;         // 20% max probability
const PROB_INCREMENT_BPS = 3;      // 0.03% increase per entry

// Fixed costs per tier in EVA
const TIER_COSTS = [
  parseEther("0.5"),   // Tier 0
  parseEther("0.5"),   // Tier 1
  parseEther("0.5"),   // Tier 2
  parseEther("1"),     // Tier 3
  parseEther("1"),     // Tier 4
  parseEther("1"),     // Tier 5
  parseEther("2"),     // Tier 6
  parseEther("2"),     // Tier 7
  parseEther("3"),     // Tier 8
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

function buildJackpotOutcomes() {
  // Outcomes for jackpot: [lose, cons1, cons2, tier0, tier1, ..., tier8]
  const outcomes: Array<{
    enabled: boolean;
    tierAdvance: number;
    tierResetTo: number;
    consolationMultiplier: number;
    awardsTier: boolean;
  }> = [];

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
    consolationMultiplier: 12000, // 1.2x in bps
    awardsTier: false,
  });

  // Outcome 2: Consolation 1.5x
  outcomes.push({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 15000, // 1.5x in bps
    awardsTier: false,
  });

  // Outcomes 3-11: Tier awards (tier 0 through tier 8)
  for (let tier = 0; tier < 9; tier++) {
    const isTerminal = tier === 8;
    outcomes.push({
      enabled: true,
      tierAdvance: isTerminal ? 0 : 1,
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
  if (!TOKEN_ADDRESS_ENV) {
    throw new Error("Missing MAINNET_TOKEN_ADDRESS - this script reuses existing token");
  }

  const VRF_SUBSCRIPTION_ID = BigInt(VRF_SUBSCRIPTION_ID_STR);
  const tokenAddress = TOKEN_ADDRESS_ENV;
  
  // House and referral fallback wallet (same as V2)
  const HOUSE_FALLBACK_WALLET = "0x8248f7b7f7cb8fa51db9138b42a6bb7af1721e9e" as Addr;

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const networkName = network.name;

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║              ARBITRUM V3 DEPLOYMENT                              ║");
  console.log("║      RandomProviderV2 + JackpotV2 (consolation fix)              ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Network:", networkName);
  console.log("Deployer:", deployer.account.address);
  console.log("Token (reusing):", tokenAddress);
  console.log("House/Fallback:", HOUSE_FALLBACK_WALLET);
  console.log("");

  const publicClient = await viem.getPublicClient();
  let tx: Addr;

  // ─────────────────────────────────────────────────────────────────────────
  // 1. RANDOM PROVIDER V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("1. Deploying RandomProviderV2...");
  
  const randomProvider = await viem.deployContract("RandomProviderV2", [VRF_COORDINATOR]);
  console.log("   ✓ RandomProviderV2:", randomProvider.address);

  await randomProvider.write.setKeyHash([VRF_KEY_HASH], { account: deployer.account });
  console.log("   ✓ Key hash set");

  await randomProvider.write.setSubscriptionId([VRF_SUBSCRIPTION_ID], { account: deployer.account });
  console.log("   ✓ Subscription ID set");

  // Add RandomProviderV2 as VRF consumer
  const VRF_COORDINATOR_ABI = [
    {
      type: "function",
      name: "addConsumer",
      inputs: [
        { name: "subId", type: "uint256" },
        { name: "consumer", type: "address" },
      ],
      outputs: [],
      stateMutability: "nonpayable",
    },
  ] as const;

  try {
    const addConsumerTx = await deployer.writeContract({
      address: VRF_COORDINATOR,
      abi: VRF_COORDINATOR_ABI,
      functionName: "addConsumer",
      args: [VRF_SUBSCRIPTION_ID, randomProvider.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: addConsumerTx });
    console.log("   ✓ Added as VRF consumer");
  } catch (e: any) {
    console.warn("   ⚠ VRF consumer registration may need manual action:", e?.message || e);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. PAYMENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("2. Deploying PaymentHandler...");

  const handler = await viem.deployContract("PaymentHandler", [tokenAddress]);
  console.log("   ✓ PaymentHandler:", handler.address);

  // ─────────────────────────────────────────────────────────────────────────
  // 3. REFERRAL SYSTEM
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("3. Deploying MultiLevelReferral...");

  const referral = await viem.deployContract("MultiLevelReferral", [tokenAddress, HOUSE_FALLBACK_WALLET]);
  console.log("   ✓ MultiLevelReferral:", referral.address);

  // Wire handler and referral
  tx = await handler.write.setReferralContract([referral.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await referral.write.setDefaultReceiver([HOUSE_FALLBACK_WALLET], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await handler.write.setWhitelistEnabled([false], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Referral configured (whitelist disabled)");

  // ─────────────────────────────────────────────────────────────────────────
  // 4. PROGRESSIVE JACKPOT V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("4. Deploying ProgressiveJackpotV2...");

  const jackpot = await viem.deployContract("ProgressiveJackpotV2", [tokenAddress, randomProvider.address]);
  console.log("   ✓ ProgressiveJackpotV2:", jackpot.address);

  // Set tier shares
  tx = await jackpot.write.setTierShares([TIER_SHARES], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Tier shares configured");

  // Set tier ladder
  const tierLadder = buildTierLadderV2();
  tx = await jackpot.write.setTierLadder([tierLadder], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Tier ladder configured");

  // Set probability config for all tiers
  tx = await jackpot.write.setAllTierProbConfigs(
    [PROB_MIN_BPS, PROB_MAX_BPS, PROB_INCREMENT_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Probability config set (min:", PROB_MIN_BPS, "max:", PROB_MAX_BPS, "incr:", PROB_INCREMENT_BPS, ")");

  // Set payment handler
  tx = await jackpot.write.setPaymentHandler([handler.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Payment handler set");

  // Configure direct betting outcomes
  const jackpotOutcomes = buildJackpotOutcomes();
  tx = await jackpot.write.configureDirectBet([true, jackpotOutcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Direct bet configured");

  // Set fallback outcome (index 0 = pure lose)
  tx = await jackpot.write.setDirectFallback([0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Direct fallback set");

  // ─────────────────────────────────────────────────────────────────────────
  // 5. SINGLE RANDOM ROULETTE V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("5. Deploying SingleRandomRouletteV2...");

  const roulette = await viem.deployContract("SingleRandomRouletteV2", [
    handler.address,
    randomProvider.address,
    tokenAddress,
  ]);
  console.log("   ✓ SingleRandomRouletteV2:", roulette.address);

  // Set jackpot address
  tx = await roulette.write.setJackpot([jackpot.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Jackpot linked");

  // Configure table
  const tableConfig = {
    enabled: true,
    replayBps: REPLAY_BPS,
    jackpotBps: JACKPOT_BPS,
    jackpotContributionBps: JACKPOT_CONTRIB_BPS,
    minMultiplier: 101,   // 1.01x minimum
    maxMultiplier: 10000, // 100x maximum
    minWager: MIN_WAGER,
    maxWager: MAX_WAGER,
  };
  tx = await roulette.write.setTableConfig([tableConfig], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Table config set");

  // Configure jackpot scaling (same as V2)
  const scalingConfig = {
    enabled: true,
    minJackpotBps: 500,    // 5% at min wager
    maxJackpotBps: 2000,   // 20% at max wager
    minJackpotWager: parseEther("0.1"),
    maxJackpotWager: parseEther("1"),
    functionId: SCALING_LOG,
    extraData: "0x" as Addr,
  };
  tx = await roulette.write.setJackpotScalingConfig([scalingConfig], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Jackpot scaling configured (5%-20%)");

  // ─────────────────────────────────────────────────────────────────────────
  // 6. REGISTER GAMES IN PAYMENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("6. Registering games in PaymentHandler...");

  // Register roulette
  tx = await handler.write.registerGame(
    [roulette.address, roulette.address, HOUSE_FALLBACK_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await handler.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Roulette registered & enabled");

  // Register jackpot
  tx = await handler.write.registerGame(
    [jackpot.address, jackpot.address, HOUSE_FALLBACK_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await handler.write.setGameStatus([jackpot.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Jackpot registered & enabled");

  // ─────────────────────────────────────────────────────────────────────────
  // 7. REGISTER GAMES IN RANDOM PROVIDER V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("7. Registering consumers in RandomProviderV2...");

  tx = await randomProvider.write.setConsumerStatus(
    [roulette.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Roulette registered (maxRanges:", CONSUMER_RANGE_LIMIT, ")");

  tx = await randomProvider.write.setConsumerStatus(
    [jackpot.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Jackpot registered (maxRanges:", CONSUMER_RANGE_LIMIT, ")");

  // ─────────────────────────────────────────────────────────────────────────
  // 8. REGISTER ROULETTE IN JACKPOT
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("8. Registering Roulette in Jackpot...");

  tx = await jackpot.write.registerGame([roulette.address, jackpotOutcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await jackpot.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Roulette registered & enabled in jackpot");

  tx = await jackpot.write.setGameFallback([roulette.address, 0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Game fallback set");

  // ─────────────────────────────────────────────────────────────────────────
  // 9. FUND JACKPOT (if configured)
  // ─────────────────────────────────────────────────────────────────────────
  if (JACKPOT_START > 0n) {
    console.log("\n═══════════════════════════════════════════════════════════════════");
    console.log("9. Funding Jackpot...");

    const token = await viem.getContractAt("EverValueCoin", tokenAddress);
    
    // Approve jackpot to spend tokens
    tx = await token.write.approve([jackpot.address, JACKPOT_START], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("   ✓ Approved", JACKPOT_START.toString(), "tokens");

    // Admin add funds (distributes to all tier pots)
    tx = await jackpot.write.adminAddFunds([JACKPOT_START], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("   ✓ Funded jackpot with", JACKPOT_START.toString(), "tokens");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SAVE DEPLOYMENT
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("Saving deployment...");

  const deployment = {
    version: "V3",
    deployedAt: new Date().toISOString(),
    token: tokenAddress,
    randomProvider: randomProvider.address,
    handler: handler.address,
    referral: referral.address,
    jackpot: jackpot.address,
    roulette: roulette.address,
    house: HOUSE_FALLBACK_WALLET,
    fallback: HOUSE_FALLBACK_WALLET,
    deployer: deployer.account.address,
    config: {
      tierShares: [...TIER_SHARES],
      tierCosts: TIER_COSTS.map(String),
      probMin: PROB_MIN_BPS,
      probMax: PROB_MAX_BPS,
      probIncrement: PROB_INCREMENT_BPS,
      minWager: MIN_WAGER.toString(),
      maxWager: MAX_WAGER.toString(),
      jackpotContribBps: JACKPOT_CONTRIB_BPS,
      replayBps: REPLAY_BPS,
      jackpotBps: JACKPOT_BPS,
    },
    changes: [
      "RandomProviderV2: Optimized gas (~180k savings per request)",
      "ProgressiveJackpotV2: Consolations paid from current tier (not tier 9)",
      "ProgressiveJackpotV2: Race condition fix - graceful payout capping",
    ],
  };

  const deploymentPath = `scripts/mainnet/deployments/arb-mainnet-v3.json`;
  await fs.writeFile(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("   ✓ Saved to", deploymentPath);

  // ─────────────────────────────────────────────────────────────────────────
  // VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("Starting verification...");

  await verifyWithRetryCli(networkName, randomProvider.address, [VRF_COORDINATOR]);
  await verifyWithRetryCli(networkName, handler.address, [tokenAddress]);
  await verifyWithRetryCli(networkName, referral.address, [tokenAddress, HOUSE_FALLBACK_WALLET]);
  await verifyWithRetryCli(networkName, jackpot.address, [tokenAddress, randomProvider.address]);
  await verifyWithRetryCli(networkName, roulette.address, [handler.address, randomProvider.address, tokenAddress]);

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                    DEPLOYMENT COMPLETE                           ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("📋 Contract Addresses:");
  console.log("   Token (reused):     ", tokenAddress);
  console.log("   RandomProviderV2:   ", randomProvider.address);
  console.log("   PaymentHandler:     ", handler.address);
  console.log("   MultiLevelReferral: ", referral.address);
  console.log("   ProgressiveJackpotV2:", jackpot.address);
  console.log("   SingleRandomRouletteV2:", roulette.address);
  console.log("");
  console.log("🔧 Key Changes in V3:");
  console.log("   • RandomProviderV2: ~180k gas savings per VRF request");
  console.log("   • Consolation prizes now paid from current tier (not tier 9)");
  console.log("   • Race condition fix: Graceful payout capping (no reverts)");
  console.log("   • Probability: 0.1% → 20% scaling (+0.03% per entry)");
  console.log("");
  console.log("⚠️  Next Steps:");
  console.log("   1. Update client to use new contract addresses");
  console.log("   2. Update The Graph subgraph (if needed)");
  console.log("   3. Fund roulette with liquidity");
  console.log("   4. Seed referrals if needed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

