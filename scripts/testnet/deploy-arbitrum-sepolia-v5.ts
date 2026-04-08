import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";
import { spawn } from "node:child_process";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION V5 (Base contracts + new payment flow)
// ═══════════════════════════════════════════════════════════════════════════

const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 200;       // 2%
const REFERRAL_BPS = 200;         // 2%
const VERIFY = true;

// Roulette config
const MIN_WAGER = parseEther("0.1");
const MAX_WAGER = parseEther("3");
const JACKPOT_CONTRIB_BPS = 350;  // 3.5% of net stake
const REPLAY_BPS = 500;           // 5% replay chance
const JACKPOT_BPS = 300;          // 3% FIXED jackpot chance

// Jackpot V2 config
const JACKPOT_START = parseEther("100");

const TIER_SHARES: readonly [number, number, number, number, number, number, number, number, number] =
  [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];

// Jackpot probability config (ppm = parts-per-million, 1_000_000 = 100%)
const PROB_MIN_PPM = 1_000;       // 0.1%
const PROB_MAX_PPM = 50_000;      // 5%
const PROB_INCREMENT_PPM = 300;   // 0.03% per entry

const CONSOLATION_SHARE_BPS = 500;
const CONSOLATION_1_PROB_PPM = 50_000;  // 5%
const CONSOLATION_2_PROB_PPM = 20_000;  // 2%

const TIER_COSTS = [
  parseEther("0.5"),
  parseEther("0.5"),
  parseEther("0.5"),
  parseEther("1"),
  parseEther("1"),
  parseEther("1"),
  parseEther("2"),
  parseEther("2"),
  parseEther("3"),
] as const;

const CONSUMER_RANGE_LIMIT = 7n;

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

  outcomes.push({ enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false });
  outcomes.push({ enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false });
  outcomes.push({ enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false });

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
  const VRF_COORDINATOR = (process.env.VRF_COORDINATOR || "").trim() as Addr | undefined;
  const VRF_KEY_HASH = (process.env.VRF_KEY_HASH || "").trim() as Addr | undefined;
  const VRF_SUBSCRIPTION_ID_STR = (process.env.VRF_SUBSCRIPTION_ID || "").trim();

  if (!VRF_COORDINATOR || !VRF_KEY_HASH || !VRF_SUBSCRIPTION_ID_STR) {
    throw new Error("Missing VRF env: VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUBSCRIPTION_ID");
  }

  const VRF_SUBSCRIPTION_ID = BigInt(VRF_SUBSCRIPTION_ID_STR);

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const networkName = "arbitrumSepolia";

  const HOUSE_FALLBACK_WALLET = deployer.account.address;

  console.log("==================================================================");
  console.log("  ARBITRUM SEPOLIA V5 DEPLOYMENT");
  console.log("  Base contracts + new payment flow (player -> game -> handler)");
  console.log("  Games: Roulette + Jackpot only");
  console.log("==================================================================");
  console.log("");
  console.log("Network:", networkName);
  console.log("Deployer:", deployer.account.address);
  console.log("");

  const publicClient = await viem.getPublicClient();
  let tx: Addr;

  // ─────────────────────────────────────────────────────────────────────────
  // 1. TOKEN (TRT)
  // ─────────────────────────────────────────────────────────────────────────
  console.log("1. Deploying EverValueCoin (TRT)...");
  const token = await viem.deployContract("EverValueCoin");
  console.log("   Token (TRT):", token.address);

  // ─────────────────────────────────────────────────────────────────────────
  // 2. RANDOM PROVIDER V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n2. Deploying RandomProviderV2...");
  const randomProvider = await viem.deployContract("RandomProviderV2", [VRF_COORDINATOR]);
  console.log("   RandomProviderV2:", randomProvider.address);

  await randomProvider.write.setKeyHash([VRF_KEY_HASH], { account: deployer.account });
  await randomProvider.write.setSubscriptionId([VRF_SUBSCRIPTION_ID], { account: deployer.account });
  console.log("   Key hash + subscription set");

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
    console.log("   Added as VRF consumer");
  } catch (e: any) {
    console.warn("   VRF consumer registration may need manual action:", e?.message || e);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. PAYMENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n3. Deploying PaymentHandler...");
  const handler = await viem.deployContract("PaymentHandler", [token.address]);
  console.log("   PaymentHandler:", handler.address);

  // ─────────────────────────────────────────────────────────────────────────
  // 4. REFERRAL SYSTEM
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n4. Deploying MultiLevelReferral...");
  const referral = await viem.deployContract("MultiLevelReferral", [token.address, HOUSE_FALLBACK_WALLET]);
  console.log("   MultiLevelReferral:", referral.address);

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
  console.log("   Referral configured");

  // ─────────────────────────────────────────────────────────────────────────
  // 5. PROGRESSIVE JACKPOT V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n5. Deploying ProgressiveJackpotV2...");
  const jackpot = await viem.deployContract("ProgressiveJackpotV2", [token.address, randomProvider.address]);
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

  // setPaymentHandler now also approves the handler to pull from jackpot
  tx = await jackpot.write.setPaymentHandler([handler.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const jackpotOutcomes = buildJackpotOutcomes();
  tx = await jackpot.write.configureDirectBet([true, jackpotOutcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setDirectFallback([0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Jackpot fully configured");

  // ─────────────────────────────────────────────────────────────────────────
  // 6. SINGLE RANDOM ROULETTE V2 (inherits VRFGameBase + JackpotClient)
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n6. Deploying SingleRandomRouletteV2...");
  const roulette = await viem.deployContract("SingleRandomRouletteV2", [
    handler.address,
    randomProvider.address,
    token.address,
  ]);
  console.log("   SingleRandomRouletteV2:", roulette.address);

  // setJackpot now goes through JackpotClient._setJackpot (handles approval)
  tx = await roulette.write.setJackpot([jackpot.address], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const tableConfig = {
    enabled: true,
    replayBps: REPLAY_BPS,
    jackpotBps: JACKPOT_BPS,
    jackpotContributionBps: JACKPOT_CONTRIB_BPS,
    minMultiplier: 101,
    maxMultiplier: 10000,
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
  console.log("   Roulette configured (3% fixed jackpot)");

  // ─────────────────────────────────────────────────────────────────────────
  // 7. REGISTER GAMES IN PAYMENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n7. Registering games in PaymentHandler...");

  // Roulette: payoutTarget = roulette (funds stay in game)
  tx = await handler.write.registerGame(
    [roulette.address, roulette.address, HOUSE_FALLBACK_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await handler.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Roulette registered & enabled");

  // Jackpot direct bets: payoutTarget = jackpot
  tx = await handler.write.registerGame(
    [jackpot.address, jackpot.address, HOUSE_FALLBACK_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await handler.write.setGameStatus([jackpot.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Jackpot registered & enabled");

  // ─────────────────────────────────────────────────────────────────────────
  // 8. REGISTER CONSUMERS IN RANDOM PROVIDER V2
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n8. Registering consumers in RandomProviderV2...");

  tx = await randomProvider.write.setConsumerStatus(
    [roulette.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Roulette registered (maxRanges:", CONSUMER_RANGE_LIMIT.toString(), ")");

  tx = await randomProvider.write.setConsumerStatus(
    [jackpot.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Jackpot registered (maxRanges:", CONSUMER_RANGE_LIMIT.toString(), ")");

  // ─────────────────────────────────────────────────────────────────────────
  // 9. REGISTER ROULETTE IN JACKPOT
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n9. Registering Roulette in Jackpot...");

  tx = await jackpot.write.registerGame([roulette.address, jackpotOutcomes], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setGameStatus([roulette.address, true], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await jackpot.write.setGameFallback([roulette.address, 0], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Roulette registered & enabled in jackpot");

  // ─────────────────────────────────────────────────────────────────────────
  // 10. SEED BALANCES
  //
  // NEW PAYMENT FLOW: Players approve GAME contracts (roulette, jackpot),
  // NOT the PaymentHandler. Games pull from player, then handler pulls from game.
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n10. Seeding balances...");

  // Fund jackpot
  tx = await token.write.approve([jackpot.address, JACKPOT_START], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await jackpot.write.adminAddFunds([JACKPOT_START], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Funded jackpot with 100 TRT");

  // Fund roulette liquidity
  tx = await token.write.transfer([roulette.address, parseEther("1000")], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Funded roulette with 1000 TRT liquidity");

  // Approve GAME CONTRACTS for deployer testing (new flow: approve games, not handler)
  tx = await token.write.approve([roulette.address, parseEther("100000")], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Approved roulette for 100,000 TRT (deployer testing)");

  tx = await token.write.approve([jackpot.address, parseEther("100000")], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Approved jackpot for 100,000 TRT (deployer testing)");

  // ─────────────────────────────────────────────────────────────────────────
  // SAVE DEPLOYMENT
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\nSaving deployment...");

  const deployment = {
    version: "V5",
    deployedAt: new Date().toISOString(),
    network: networkName,
    token: token.address,
    randomProvider: randomProvider.address,
    handler: handler.address,
    referral: referral.address,
    jackpot: jackpot.address,
    roulette: roulette.address,
    house: HOUSE_FALLBACK_WALLET,
    deployer: deployer.account.address,
    notes: "Base contracts (BaseGame/VRFGameBase/JackpotClient) + new payment flow (player->game->handler)",
    config: {
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
  const deploymentPath = new URL("arb-sepolia-v5.json", deploymentsDir);
  await fs.writeFile(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("   Saved to", deploymentPath.pathname);

  // ─────────────────────────────────────────────────────────────────────────
  // VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\nStarting verification (waiting 30s for indexing)...");
  await new Promise((r) => setTimeout(r, 30_000));

  await verifyWithRetryCli(networkName, token.address, []);
  await verifyWithRetryCli(networkName, randomProvider.address, [VRF_COORDINATOR]);
  await verifyWithRetryCli(networkName, handler.address, [token.address]);
  await verifyWithRetryCli(networkName, referral.address, [token.address, HOUSE_FALLBACK_WALLET]);
  await verifyWithRetryCli(networkName, jackpot.address, [token.address, randomProvider.address]);
  await verifyWithRetryCli(networkName, roulette.address, [handler.address, randomProvider.address, token.address]);

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n==================================================================");
  console.log("  DEPLOYMENT COMPLETE (V5)");
  console.log("==================================================================");
  console.log("");
  console.log("Contract Addresses:");
  console.log("  Token (TRT):          ", token.address);
  console.log("  RandomProviderV2:     ", randomProvider.address);
  console.log("  PaymentHandler:       ", handler.address);
  console.log("  MultiLevelReferral:   ", referral.address);
  console.log("  ProgressiveJackpotV2: ", jackpot.address);
  console.log("  SingleRandomRouletteV2:", roulette.address);
  console.log("");
  console.log("Key V5 Changes:");
  console.log("  - Roulette/Jackpot use BaseGame/VRFGameBase/JackpotClient");
  console.log("  - New payment flow: player approves GAME, not handler");
  console.log("  - Games pull tokens from player then handler pulls from game");
  console.log("  - setPaymentHandler manages ERC20 approvals automatically");
  console.log("");
  console.log("Initial Funding:");
  console.log("  Jackpot: 100 TRT  |  Roulette: 1000 TRT");
  console.log("");
  console.log("VRF Note:");
  console.log("  If VRF consumer registration failed, manually add");
  console.log("  RandomProviderV2 as consumer in Chainlink VRF dashboard");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
