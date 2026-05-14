/**
 * Testnet CORE deploy script — Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/testnet/deploy-core.ts --network arbitrumSepolia
 *
 * Deploys ONLY the platform core (no games). This is the entry point for a
 * new game team that wants to plug a single game into a fresh platform
 * environment without deploying every existing game alongside it.
 *
 * What this deploys:
 *   - EverValueCoin                   (ERC20)
 *   - AuthHub                         (operator allowlist + player session keys)
 *   - MultiLevelReferral              (with PaymentHandler wiring)
 *   - PaymentHandler                  (bet routing + fee splits)
 *   - RandomProvider                  (Chainlink VRF wrapper on the real coordinator)
 *   - ProgressiveJackpot              (registered + seeded + wired to PaymentHandler)
 *
 * What it does NOT deploy:
 *   - Any game contract. The point of this script is to leave the slot open.
 *
 * Output:
 *   - deployments/arbitrumSepolia-core.json   (separate from arbitrumSepolia.json
 *     which `deploy.ts` produces; both files can coexist)
 *
 * After this script lands, a new game contract can be deployed in three steps:
 *   1. Construct the game with addresses from `arbitrumSepolia-core.json`:
 *        new MyGame(
 *          coreDeployment.contracts.evaToken,
 *          coreDeployment.contracts.paymentHandler,
 *          coreDeployment.contracts.randomProvider,
 *          coreDeployment.contracts.authHub,
 *          "MyGame", "1",
 *          coreDeployment.wallets.operator,
 *        );
 *   2. Register on PaymentHandler:
 *        paymentHandler.registerGame(game, payoutTarget, feeRecipient, houseEdgeBps, referralBps, jackpotBps);
 *   3. Register as RandomProvider consumer (VRF games only) + AuthHub spend tracker:
 *        randomProvider.setConsumerStatus(game, true, maxRanges);
 *        authHub.setSpendTracker(game, true);
 *
 * See `docs/GAME_AUTHOR_GUIDE.md` for the full integration walkthrough and
 * `scripts/testnet/deploy.ts` for a worked example that wires every platform
 * game using exactly this pattern.
 */

import { network } from "hardhat";
import { parseEther } from "viem";

import {
  loadTestnetEnv,
  deriveTestnetWallets,
  summarizeWallets,
  saveCoreDeployment,
  type CoreDeployment,
} from "./lib.js";

type Addr = `0x${string}`;

// ─────────────────────────────────────────────────────────────────────────
// CONFIG — kept identical to deploy.ts so the core a new team gets matches
// the production-shape the platform team uses
// ─────────────────────────────────────────────────────────────────────────

const MLR_LEVELS: readonly number[] = [4000, 3000, 2000]; // 40% / 30% / 20% upline split

// ProgressiveJackpot defaults
const PJ_TIER_COUNT = 9;
const PJ_TIER_COST = parseEther("1");
const PJ_PROB_BASE = 1000;
const PJ_PROB_MAX = 50_000;
const PJ_PROB_INCREMENT = 30;
const PJ_POT_SEED = parseEther("10");

// PJ direct-bet fee split (re-routed through PaymentHandler like every other game)
const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 100;

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function banner(s: string) {
  console.log("\n" + "═".repeat(70));
  console.log(s);
  console.log("═".repeat(70));
}
function step(s: string) { console.log(`\n→ ${s}`); }
function ok(s: string)   { console.log(`  ✓ ${s}`); }

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadTestnetEnv();

  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (networkName !== "arbitrumSepolia") {
    throw new Error(
      `This script targets arbitrumSepolia; got "${networkName}". ` +
        `Run with: npx hardhat run scripts/testnet/deploy-core.ts --network arbitrumSepolia`,
    );
  }

  const [deployerWallet] = await viem.getWalletClients();
  const deployer = deployerWallet.account.address;
  const deployerBal = await publicClient.getBalance({ address: deployer });

  const wallets = deriveTestnetWallets(env.testnetSeed);
  const walletAddrs = summarizeWallets(wallets);

  banner("BURNING GAMES — Core deploy (Arbitrum Sepolia)");
  console.log("Network:                ", networkName, `(chainId ${chainId})`);
  console.log("Deployer:               ", deployer);
  console.log("Deployer balance:       ", parseFloat((Number(deployerBal) / 1e18).toFixed(6)), "ETH");
  console.log("VRF coordinator:        ", env.vrfCoordinator);
  console.log("VRF key hash:           ", env.vrfKeyHash);
  console.log("VRF subscription:       ", env.vrfSubscriptionId.toString());

  // ── 1. Token + Auth ──────────────────────────────────────────────────────
  banner("1. EverValueCoin + AuthHub");

  step("Deploying EverValueCoin");
  const token = await viem.deployContract("EverValueCoin");
  ok(`EverValueCoin: ${token.address}`);

  step("Deploying AuthHub");
  const authHub = await viem.deployContract("AuthHub");
  ok(`AuthHub: ${authHub.address}`);

  // ── 2. Referral + PaymentHandler ─────────────────────────────────────────
  banner("2. MultiLevelReferral + PaymentHandler");

  step(`Deploying MultiLevelReferral (defaultReceiver = ${walletAddrs.defaultReceiver})`);
  const mlr = await viem.deployContract("MultiLevelReferral", [
    token.address as Addr,
    walletAddrs.defaultReceiver,
  ]);
  ok(`MultiLevelReferral: ${mlr.address}`);

  step(`Setting MLR levels: ${MLR_LEVELS.join(" / ")} bps`);
  await mlr.write.setLevels([MLR_LEVELS.length, [...MLR_LEVELS]]);

  step("Deploying PaymentHandler");
  const paymentHandler = await viem.deployContract("PaymentHandler", [token.address as Addr]);
  ok(`PaymentHandler: ${paymentHandler.address}`);

  step("Wiring MLR ↔ PaymentHandler (both directions)");
  await mlr.write.setPaymentHandler([paymentHandler.address]);
  await paymentHandler.write.setReferralContract([mlr.address]);

  // ── 3. RandomProvider ────────────────────────────────────────────────────
  banner("3. RandomProvider (Chainlink VRF wrapper)");

  step("Deploying RandomProvider");
  const randomProvider = await viem.deployContract("RandomProvider", [env.vrfCoordinator]);
  ok(`RandomProvider: ${randomProvider.address}`);

  step("Setting VRF key hash + subscription ID");
  await randomProvider.write.setKeyHash([env.vrfKeyHash]);
  await randomProvider.write.setSubscriptionId([env.vrfSubscriptionId]);

  // ── 4. ProgressiveJackpot ────────────────────────────────────────────────
  banner("4. ProgressiveJackpot");

  step("Deploying ProgressiveJackpot");
  const pj = await viem.deployContract("ProgressiveJackpot", [
    token.address as Addr,
    randomProvider.address,
    authHub.address,
  ]);
  ok(`ProgressiveJackpot: ${pj.address}`);

  step("Wiring PJ ↔ PaymentHandler (both directions)");
  await pj.write.setPaymentHandler([paymentHandler.address]);
  await paymentHandler.write.setJackpot([pj.address]);

  step("Registering PJ as a RandomProvider consumer (maxRanges = 1)");
  await randomProvider.write.setConsumerStatus([pj.address, true, 1n]);

  step(`Configuring PJ tier ladder (${PJ_TIER_COUNT} tiers @ ${PJ_TIER_COST} EVA each)`);
  const tiers = Array.from({ length: PJ_TIER_COUNT }, (_, i) => ({
    prizeMetric: 0n,
    isTerminal: i === PJ_TIER_COUNT - 1,
    isPercent: false,
    fixedBetCost: PJ_TIER_COST,
    useDynamicCost: false,
    costBps: 0,
  }));
  await pj.write.setTierLadder([tiers]);
  await pj.write.setAllTierProbConfigs([PJ_PROB_BASE, PJ_PROB_MAX, PJ_PROB_INCREMENT]);

  step("Configuring PJ direct-bet outcomes (lose + 2 consolation + 9 tier awards)");
  const directOutcomes: Array<{
    enabled: boolean;
    tierAdvance: number;
    tierResetTo: number;
    consolationMultiplier: number;
    awardsTier: boolean;
  }> = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
  ];
  for (let i = 0; i < PJ_TIER_COUNT; i++) {
    directOutcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  }
  await pj.write.configureDirectBet([true, directOutcomes]);
  await pj.write.setDirectFallback([0]);

  step("Registering PJ as a PaymentHandler game (so direct bets route through fees)");
  await paymentHandler.write.registerGame([
    pj.address, pj.address, walletAddrs.feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([pj.address, true]);

  step(`Seeding PJ pots (consolation + ${PJ_TIER_COUNT} tiers × ${PJ_POT_SEED} EVA)`);
  const totalSeed = PJ_POT_SEED * BigInt(PJ_TIER_COUNT + 1);
  await token.write.approve([pj.address, totalSeed]);
  await pj.write.seedConsolationPot([PJ_POT_SEED]);
  for (let i = 0; i < PJ_TIER_COUNT; i++) {
    await pj.write.seedTierPot([i, PJ_POT_SEED]);
  }
  ok("Pots seeded");

  // ── 5. AuthHub operator allowlist ────────────────────────────────────────
  banner("5. AuthHub operator allowlist");
  step(`Adding ${walletAddrs.operator} to AuthHub operator allowlist`);
  await authHub.write.setOperator([walletAddrs.operator, true]);
  ok("Operator allowlisted");

  // ── 6. Save deployment ───────────────────────────────────────────────────
  banner("6. Save deployment");

  const deployment: CoreDeployment = {
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer,
    vrf: {
      coordinator: env.vrfCoordinator,
      keyHash: env.vrfKeyHash,
      subscriptionId: env.vrfSubscriptionId.toString(),
    },
    wallets: walletAddrs,
    contracts: {
      evaToken: token.address as Addr,
      authHub: authHub.address as Addr,
      mlr: mlr.address as Addr,
      paymentHandler: paymentHandler.address as Addr,
      randomProvider: randomProvider.address as Addr,
      progressiveJackpot: pj.address as Addr,
    },
  };

  const filePath = await saveCoreDeployment(deployment);
  ok(`Wrote ${filePath}`);

  // ── 7. Summary + next steps ──────────────────────────────────────────────
  banner("CORE DEPLOY COMPLETE");
  console.log("");
  console.log("Core contracts:");
  for (const [name, addr] of Object.entries(deployment.contracts)) {
    console.log(`  ${name.padEnd(20)} ${addr}`);
  }
  console.log("");
  console.log("Reserved wallets (from TESTNET_SEED):");
  for (const [role, addr] of Object.entries(deployment.wallets)) {
    console.log(`  ${role.padEnd(18)} ${addr}`);
  }
  console.log("");
  console.log("─".repeat(70));
  console.log("NEXT — connect your game to the platform:");
  console.log("─".repeat(70));
  console.log("");
  console.log(" 1. Add the RandomProvider as a Chainlink VRF subscription consumer.");
  console.log("    (One-time, at vrf.chain.link — pass the RandomProvider address.)");
  console.log("");
  console.log(" 2. Deploy your game pointing at the addresses above:");
  console.log("       new MyGame(");
  console.log(`         "${deployment.contracts.evaToken}",      // EVA token`);
  console.log(`         "${deployment.contracts.paymentHandler}",  // PaymentHandler`);
  console.log(`         "${deployment.contracts.randomProvider}",  // RandomProvider (VRF games)`);
  console.log(`         "${deployment.contracts.authHub}",         // AuthHub`);
  console.log(`         "MyGame", "1",                            // EIP-712 domain`);
  console.log(`         operator                                   // initial gameOperator`);
  console.log("       );");
  console.log("");
  console.log(" 3. Register your game on PaymentHandler + RandomProvider + AuthHub:");
  console.log("       paymentHandler.registerGame(game, payoutTarget, feeRecipient, ...);");
  console.log("       randomProvider.setConsumerStatus(game, true, maxRanges);  // VRF games");
  console.log("       authHub.setSpendTracker(game, true);                      // *For games");
  console.log("");
  console.log(" 4. Configure game-specific state (table configs, multipliers, etc.)");
  console.log(" 5. Bankroll the game with EVA (transfer to the game address).");
  console.log("");
  console.log("See docs/GAME_AUTHOR_GUIDE.md for the full integration walkthrough.");
}

main().catch((e) => {
  console.error("\n✖ Core deploy failed:", e);
  process.exit(1);
});
