import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther } from "viem";
import { spawn } from "node:child_process";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════════
// MAINNET CONFIGURATION V5
// Base contracts (BaseGame / VRFGameBase / JackpotClient)
// New payment flow: player → game → handler
// Games: Roulette + Jackpot only
// ═══════════════════════════════════════════════════════════════════════════

// ─── Existing token (do NOT redeploy) ───────────────────────────────────
const TOKEN_ADDRESS = (process.env.MAINNET_TOKEN_ADDRESS || "").trim() as Addr;

// ─── Fee structure ──────────────────────────────────────────────────────
const HOUSE_EDGE_BPS = 150;              // 1.5% house edge
const REFERRAL_BPS = 150;                // 1.5% referral
const REFERRAL_LADDER = [3_000, 2_500, 2_000, 1_500, 1_000] as const;
// Level 1: 30%, Level 2: 25%, Level 3: 20%, Level 4: 15%, Level 5: 10%

// ─── Roulette config ────────────────────────────────────────────────────
const MIN_WAGER = parseEther("0.1");     // 0.1 TRT minimum bet
const MAX_WAGER = parseEther("3");       // 3 TRT maximum bet
const MIN_MULTIPLIER = 101;              // 1.01x minimum
const MAX_MULTIPLIER = 10000;            // 100x maximum
const JACKPOT_CONTRIB_BPS = 300;         // 3% of net stake → jackpot
const REPLAY_BPS = 500;                  // 5% replay (re-roll) chance
const JACKPOT_BPS = 300;                 // 3% FIXED jackpot trigger chance
const JACKPOT_SCALING_ENABLED = false;   // No wager-based jackpot probability scaling

// ─── Jackpot V2 config ─────────────────────────────────────────────────
// Tier share distribution (must sum to 10000 bps = 100%)
// Each deposit is split across 9 tier pots after consolation share
const TIER_SHARES: readonly [number, number, number, number, number, number, number, number, number] =
  [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];
// T0-T7: 10% each, T8 (grand jackpot): 20%

// Fixed cost per tier for direct jackpot bets
const TIER_COSTS = [
  parseEther("0.5"),   // Tier 0
  parseEther("0.5"),   // Tier 1
  parseEther("0.5"),   // Tier 2
  parseEther("1"),     // Tier 3
  parseEther("1"),     // Tier 4
  parseEther("1"),     // Tier 5
  parseEther("2"),     // Tier 6
  parseEther("2"),     // Tier 7
  parseEther("3"),     // Tier 8 (grand jackpot)
] as const;

// Tier probability (ppm = parts-per-million, 1_000_000 = 100%)
const PROB_MIN_PPM = 1_000;              // 0.10% starting probability
const PROB_MAX_PPM = 50_000;             // 5.00% max probability
const PROB_INCREMENT_PPM = 300;          // +0.03% per entry since last win

// Consolation pot
const CONSOLATION_SHARE_BPS = 500;       // 5% of each deposit → consolation pot
const CONSOLATION_1_PROB_PPM = 50_000;   // 5% chance for 1.2x consolation
const CONSOLATION_2_PROB_PPM = 20_000;   // 2% chance for 1.5x consolation

// VRF ranges per request
const CONSUMER_RANGE_LIMIT = 7n;

// ─── Funding (set to 0n to skip) ────────────────────────────────────────
const INITIAL_JACKPOT_FUNDING = parseEther(process.env.MAINNET_JACKPOT_SEED || "0");
const INITIAL_ROULETTE_LIQUIDITY = parseEther(process.env.MAINNET_ROULETTE_SEED || "0");

// ─── Operational ────────────────────────────────────────────────────────
const WHITELIST_ENABLED = (process.env.MAINNET_WHITELIST_ENABLED || "true").trim() === "true";
const VERIFY = true;

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
      console.log("  Verified", address);
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Already Verified")) {
        console.log("  Already verified", address);
        return;
      }
      if (i < 2) {
        console.warn("  verify retry in 15s:", address, msg);
        await new Promise((r) => setTimeout(r, 15_000));
      } else {
        console.warn("  verify failed:", address, e);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// JACKPOT V2 CONFIGURATION BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

function buildTierLadderV2() {
  return Array.from({ length: 9 }, (_, index) => ({
    prizeMetric: 0n,
    isTerminal: index === 8,
    isPercent: false,
    fixedBetCost: TIER_COSTS[index],
    useDynamicCost: false,
    costBps: 0,
  }));
}

function buildJackpotOutcomes() {
  const outcomes: Array<{
    enabled: boolean;
    tierAdvance: number;
    tierResetTo: number;
    consolationMultiplier: number;
    awardsTier: boolean;
  }> = [];

  // Index 0: Miss
  outcomes.push({ enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false });
  // Index 1: Consolation 1.2x
  outcomes.push({ enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false });
  // Index 2: Consolation 1.5x
  outcomes.push({ enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false });

  // Indices 3-11: Tier 0 through Tier 8
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
  // ─── Validate environment ─────────────────────────────────────────────

  const VRF_COORDINATOR = (process.env.MAINNET_VRF_COORDINATOR || "").trim() as Addr;
  const VRF_KEY_HASH = (process.env.MAINNET_VRF_KEY_HASH || "").trim() as Addr;
  const VRF_SUB_STR = (process.env.MAINNET_VRF_SUBSCRIPTION_ID || "").trim();
  const HOUSE_WALLET = (process.env.MAINNET_HOUSE_WALLET || "").trim() as Addr;

  const missing: string[] = [];
  if (!TOKEN_ADDRESS) missing.push("MAINNET_TOKEN_ADDRESS");
  if (!VRF_COORDINATOR) missing.push("MAINNET_VRF_COORDINATOR");
  if (!VRF_KEY_HASH) missing.push("MAINNET_VRF_KEY_HASH");
  if (!VRF_SUB_STR) missing.push("MAINNET_VRF_SUBSCRIPTION_ID");
  if (!HOUSE_WALLET) missing.push("MAINNET_HOUSE_WALLET");

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const VRF_SUBSCRIPTION_ID = BigInt(VRF_SUB_STR);

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const networkName = "arbitrum";

  console.log("==================================================================");
  console.log("  ARBITRUM MAINNET V5 DEPLOYMENT");
  console.log("  Base contracts + new payment flow (player → game → handler)");
  console.log("  Games: Roulette + Jackpot only");
  console.log("==================================================================");
  console.log("");
  console.log("Network:      ", networkName);
  console.log("Deployer:     ", deployer.account.address);
  console.log("House wallet: ", HOUSE_WALLET);
  console.log("Token (TRT):  ", TOKEN_ADDRESS, "(existing)");
  console.log("VRF Coord:    ", VRF_COORDINATOR);
  console.log("VRF Sub ID:   ", VRF_SUBSCRIPTION_ID.toString().slice(0, 20) + "...");
  console.log("Whitelist:    ", WHITELIST_ENABLED);
  console.log("");

  // ─── Pre-flight: check deployer balance ───────────────────────────────

  const ERC20_ABI = [{
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  }] as const;

  const deployerBalance = await publicClient.readContract({
    address: TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf",
    args: [deployer.account.address],
  });
  const ethBalance = await publicClient.getBalance({ address: deployer.account.address });

  console.log("Deployer ETH: ", formatEther(ethBalance), "ETH");
  console.log("Deployer TRT: ", formatEther(deployerBalance), "TRT");

  const totalFunding = INITIAL_JACKPOT_FUNDING + INITIAL_ROULETTE_LIQUIDITY;
  if (totalFunding > 0n) {
    console.log("Planned seed:  JP=" + formatEther(INITIAL_JACKPOT_FUNDING) +
                " + Roulette=" + formatEther(INITIAL_ROULETTE_LIQUIDITY) + " TRT");
    if (deployerBalance < totalFunding) {
      throw new Error(`Insufficient TRT for funding. Have ${formatEther(deployerBalance)}, need ${formatEther(totalFunding)}`);
    }
  }

  console.log("\n─── Starting deployment... ───\n");

  let tx: Addr;

  // ─────────────────────────────────────────────────────────────────────────
  // 1. RANDOM PROVIDER V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("1. Deploying RandomProviderV2...");
  const randomProvider = await viem.deployContract("RandomProviderV2", [VRF_COORDINATOR]);
  console.log("   RandomProviderV2:", randomProvider.address);

  tx = await randomProvider.write.setKeyHash([VRF_KEY_HASH], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await randomProvider.write.setSubscriptionId([VRF_SUBSCRIPTION_ID], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   VRF key hash + subscription set");

  // Add as VRF consumer
  const VRF_COORDINATOR_ABI = [{
    type: "function", name: "addConsumer", stateMutability: "nonpayable",
    inputs: [{ name: "subId", type: "uint256" }, { name: "consumer", type: "address" }],
    outputs: [],
  }] as const;

  try {
    const addTx = await deployer.writeContract({
      address: VRF_COORDINATOR, abi: VRF_COORDINATOR_ABI,
      functionName: "addConsumer", args: [VRF_SUBSCRIPTION_ID, randomProvider.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: addTx });
    console.log("   Registered as VRF consumer");
  } catch (e: any) {
    console.warn("   !! VRF consumer registration failed. Add manually via Chainlink dashboard.");
    console.warn("   ", e?.shortMessage || e?.message || e);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. PAYMENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n2. Deploying PaymentHandler...");
  const handler = await viem.deployContract("PaymentHandler", [TOKEN_ADDRESS]);
  console.log("   PaymentHandler:", handler.address);

  // ─────────────────────────────────────────────────────────────────────────
  // 3. REFERRAL SYSTEM
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n3. Deploying MultiLevelReferral...");
  const referral = await viem.deployContract("MultiLevelReferral", [TOKEN_ADDRESS, HOUSE_WALLET]);
  console.log("   MultiLevelReferral:", referral.address);

  tx = await handler.write.setReferralContract([referral.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await referral.write.setDefaultReceiver([HOUSE_WALLET], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await handler.write.setWhitelistEnabled([WHITELIST_ENABLED], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Referral configured (whitelist:", WHITELIST_ENABLED, ")");

  // ─────────────────────────────────────────────────────────────────────────
  // 4. PROGRESSIVE JACKPOT V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n4. Deploying ProgressiveJackpotV2...");
  const jackpot = await viem.deployContract("ProgressiveJackpotV2", [TOKEN_ADDRESS, randomProvider.address]);
  console.log("   ProgressiveJackpotV2:", jackpot.address);

  tx = await jackpot.write.setTierShares([TIER_SHARES], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const tierLadder = buildTierLadderV2();
  tx = await jackpot.write.setTierLadder([tierLadder], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setAllTierProbConfigs(
    [PROB_MIN_PPM, PROB_MAX_PPM, PROB_INCREMENT_PPM],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setConsolationShare([CONSOLATION_SHARE_BPS], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setConsolationProbabilities(
    [CONSOLATION_1_PROB_PPM, CONSOLATION_2_PROB_PPM],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setPaymentHandler([handler.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const jackpotOutcomes = buildJackpotOutcomes();
  tx = await jackpot.write.configureDirectBet([true, jackpotOutcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setDirectFallback([0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Jackpot fully configured");

  // ─────────────────────────────────────────────────────────────────────────
  // 5. SINGLE RANDOM ROULETTE V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n5. Deploying SingleRandomRouletteV2...");
  const roulette = await viem.deployContract("SingleRandomRouletteV2", [
    handler.address,
    randomProvider.address,
    TOKEN_ADDRESS,
  ]);
  console.log("   SingleRandomRouletteV2:", roulette.address);

  tx = await roulette.write.setJackpot([jackpot.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const tableConfig = {
    enabled: true,
    replayBps: REPLAY_BPS,
    jackpotBps: JACKPOT_BPS,
    jackpotContributionBps: JACKPOT_CONTRIB_BPS,
    minMultiplier: MIN_MULTIPLIER,
    maxMultiplier: MAX_MULTIPLIER,
    minWager: MIN_WAGER,
    maxWager: MAX_WAGER,
  };
  tx = await roulette.write.setTableConfig([tableConfig], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const scalingConfig = {
    enabled: false,
    minJackpotBps: 0,
    maxJackpotBps: 0,
    minJackpotWager: 0n,
    maxJackpotWager: 0n,
    functionId: 0,
    extraData: "0x" as Addr,
  };
  tx = await roulette.write.setJackpotScalingConfig([scalingConfig], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Roulette configured");

  // ─────────────────────────────────────────────────────────────────────────
  // 6. REGISTER GAMES IN PAYMENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n6. Registering games in PaymentHandler...");

  tx = await handler.write.registerGame(
    [roulette.address, roulette.address, HOUSE_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await handler.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Roulette registered & enabled");

  tx = await handler.write.registerGame(
    [jackpot.address, jackpot.address, HOUSE_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await handler.write.setGameStatus([jackpot.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Jackpot registered & enabled");

  // ─────────────────────────────────────────────────────────────────────────
  // 7. REGISTER CONSUMERS IN RANDOM PROVIDER V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n7. Registering consumers in RandomProviderV2...");

  tx = await randomProvider.write.setConsumerStatus(
    [roulette.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Roulette consumer registered");

  tx = await randomProvider.write.setConsumerStatus(
    [jackpot.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Jackpot consumer registered");

  // ─────────────────────────────────────────────────────────────────────────
  // 8. REGISTER ROULETTE IN JACKPOT
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n8. Registering Roulette in Jackpot...");

  tx = await jackpot.write.registerGame([roulette.address, jackpotOutcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setGameFallback([roulette.address, 0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Roulette registered & enabled in jackpot");

  // ─────────────────────────────────────────────────────────────────────────
  // 9. SEED BALANCES (optional)
  // ─────────────────────────────────────────────────────────────────────────
  if (INITIAL_JACKPOT_FUNDING > 0n || INITIAL_ROULETTE_LIQUIDITY > 0n) {
    console.log("\n9. Seeding balances...");

    const APPROVE_ABI = [{
      type: "function", name: "approve", stateMutability: "nonpayable",
      inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
      outputs: [{ name: "", type: "bool" }],
    }, {
      type: "function", name: "transfer", stateMutability: "nonpayable",
      inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
      outputs: [{ name: "", type: "bool" }],
    }] as const;

    if (INITIAL_JACKPOT_FUNDING > 0n) {
      tx = await deployer.writeContract({
        address: TOKEN_ADDRESS, abi: APPROVE_ABI, functionName: "approve",
        args: [jackpot.address, INITIAL_JACKPOT_FUNDING],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      tx = await jackpot.write.adminAddFunds([INITIAL_JACKPOT_FUNDING], { account: deployer.account });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log("   Funded jackpot with", formatEther(INITIAL_JACKPOT_FUNDING), "TRT");
    }

    if (INITIAL_ROULETTE_LIQUIDITY > 0n) {
      tx = await deployer.writeContract({
        address: TOKEN_ADDRESS, abi: APPROVE_ABI, functionName: "transfer",
        args: [roulette.address, INITIAL_ROULETTE_LIQUIDITY],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log("   Funded roulette with", formatEther(INITIAL_ROULETTE_LIQUIDITY), "TRT");
    }
  } else {
    console.log("\n9. Skipping funding (set MAINNET_JACKPOT_SEED / MAINNET_ROULETTE_SEED to fund)");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SAVE DEPLOYMENT
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\nSaving deployment...");

  const deployment = {
    version: "V5",
    deployedAt: new Date().toISOString(),
    network: networkName,
    token: TOKEN_ADDRESS,
    randomProvider: randomProvider.address,
    handler: handler.address,
    referral: referral.address,
    jackpot: jackpot.address,
    roulette: roulette.address,
    house: HOUSE_WALLET,
    deployer: deployer.account.address,
    notes: "V5: BaseGame/VRFGameBase/JackpotClient + new payment flow (player->game->handler)",
    previousV4: {
      handler: "0xce9f2e4586d674162610daec693ae9b1083c11d4",
      randomProvider: "0xc7b8e1c6baf325799f7e536fbe6c7eee65256d47",
      referral: "0xd64a1b0b213877cde3f9b4a0fa93bffa4878a71b",
      jackpot: "0x55c4bb3b11dbdb048a06b3442ac4757b57ca6874",
      roulette: "0xb3f60ca15dea4434fa7bc364563ac1f05d4ac142",
    },
    config: {
      houseEdgeBps: HOUSE_EDGE_BPS,
      referralBps: REFERRAL_BPS,
      referralLadder: [...REFERRAL_LADDER],
      whitelistEnabled: WHITELIST_ENABLED,
      tierShares: [...TIER_SHARES],
      tierCosts: TIER_COSTS.map(String),
      probabilityPrecision: 1_000_000,
      probMinPpm: PROB_MIN_PPM,
      probMaxPpm: PROB_MAX_PPM,
      probIncrementPpm: PROB_INCREMENT_PPM,
      consolationShareBps: CONSOLATION_SHARE_BPS,
      consolation1ProbPpm: CONSOLATION_1_PROB_PPM,
      consolation2ProbPpm: CONSOLATION_2_PROB_PPM,
      minWager: MIN_WAGER.toString(),
      maxWager: MAX_WAGER.toString(),
      jackpotContribBps: JACKPOT_CONTRIB_BPS,
      replayBps: REPLAY_BPS,
      jackpotBps: JACKPOT_BPS,
      jackpotScaling: "DISABLED",
    },
  };

  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const deploymentPath = new URL("arb-mainnet-v5.json", deploymentsDir);
  await fs.writeFile(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("   Saved to", deploymentPath.pathname);

  // ─────────────────────────────────────────────────────────────────────────
  // VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\nStarting verification (waiting 30s for indexing)...");
  await new Promise((r) => setTimeout(r, 30_000));

  await verifyWithRetryCli(networkName, randomProvider.address, [VRF_COORDINATOR]);
  await verifyWithRetryCli(networkName, handler.address, [TOKEN_ADDRESS]);
  await verifyWithRetryCli(networkName, referral.address, [TOKEN_ADDRESS, HOUSE_WALLET]);
  await verifyWithRetryCli(networkName, jackpot.address, [TOKEN_ADDRESS, randomProvider.address]);
  await verifyWithRetryCli(networkName, roulette.address, [handler.address, randomProvider.address, TOKEN_ADDRESS]);

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n==================================================================");
  console.log("  MAINNET DEPLOYMENT COMPLETE (V5)");
  console.log("==================================================================");
  console.log("");
  console.log("Contract Addresses:");
  console.log("  Token (TRT):           ", TOKEN_ADDRESS, "(existing)");
  console.log("  RandomProviderV2:      ", randomProvider.address);
  console.log("  PaymentHandler:        ", handler.address);
  console.log("  MultiLevelReferral:    ", referral.address);
  console.log("  ProgressiveJackpotV2:  ", jackpot.address);
  console.log("  SingleRandomRouletteV2:", roulette.address);
  console.log("");
  console.log("House wallet:            ", HOUSE_WALLET);
  console.log("Whitelist:               ", WHITELIST_ENABLED);
  console.log("");
  console.log("IMPORTANT POST-DEPLOYMENT STEPS:");
  console.log("  1. Verify RandomProviderV2 is added as consumer in Chainlink VRF dashboard");
  console.log("  2. Fund roulette with liquidity: token.transfer(roulette, amount)");
  console.log("  3. Fund jackpot: token.approve(jackpot, amount) then jackpot.adminAddFunds(amount)");
  console.log("  4. If whitelist is enabled, add allowed players via handler.setWhitelisted(player, true)");
  console.log("  5. Transfer ownership if needed (Ownable2Step: transferOwnership + acceptOwnership)");
  console.log("  6. Update frontend to approve game contracts instead of handler");
  console.log("");
  console.log("V4 → V5 Migration Notes:");
  console.log("  - Old V4 contracts remain at their addresses (can be disabled independently)");
  console.log("  - Players must re-approve the NEW game contracts (roulette, jackpot)");
  console.log("  - No backward compatibility with V4 handler (different payment flow)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
