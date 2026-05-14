import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════════
// CRASH GAME MAINNET DEPLOYMENT — V5 INFRASTRUCTURE
// Deploys CrashGame, registers in PaymentHandler + RandomProviderV2,
// configures for 100 EVA liquidity, and deposits the operator bond.
// Does NOT fund the bankroll — fund manually after verifying the deployment.
// ═══════════════════════════════════════════════════════════════════════════

// ─── V5 Infrastructure (from arb-mainnet-v5.json) ────────────────────────
const TOKEN_ADDRESS  = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as Addr;
const HANDLER        = "0xabe66fc056dd0e116b90201e487ea102fd7df1ba" as Addr;
const RANDOM         = "0x6513baa6c53a570ec899bb1504a95f160b8d7850" as Addr;
const HOUSE_WALLET   = "0x2132c5e539F1Da6090424644576ABB5C5aDcdbbd" as Addr;

// ─── Roles ───────────────────────────────────────────────────────────────
// Admin = deployer wallet (same as PaymentHandler/RandomProvider owner)
// Operator = backend hot wallet that drives round lifecycle
const OPERATOR       = "0x9E092349b284887cd2BB80d0952F0440604eb6F9" as Addr;

// ─── Fee structure (matches V5 roulette/plinko) ──────────────────────────
const HOUSE_EDGE_BPS = 150;   // 1.5%
const REFERRAL_BPS   = 150;   // 1.5%

// ─── CrashGame uses 1 random word per round ──────────────────────────────
const CONSUMER_RANGE_LIMIT = 1n;

// ─── Config overrides for 100 EVA liquidity ──────────────────────────────
const OPERATOR_BOND        = parseEther("10");     // 10 EVA bond (down from 1,000)
const MIN_BET              = parseEther("0.1");    // 0.1 EVA
const MAX_BET              = parseEther("1");      // 1 EVA (down from 5)
const MAX_PAYOUT_PER_ROUND = parseEther("100");    // 100 EVA cap
const MAX_MULTIPLIER       = 1_000_000;            // 100.00x (down from 500x)
const RESERVATION_MULT     = 500_000;              // 50.00x (keep default)

// ═══════════════════════════════════════════════════════════════════════════
// MAIN DEPLOYMENT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const networkName = "arbitrum";

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  CRASH GAME DEPLOYMENT — ARBITRUM MAINNET (V5 Infrastructure)");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Network:         ", networkName);
  console.log("Deployer (Admin):", deployer.account.address);
  console.log("Operator:        ", OPERATOR);
  console.log("Token (EVA):     ", TOKEN_ADDRESS);
  console.log("PaymentHandler:  ", HANDLER);
  console.log("RandomProviderV2:", RANDOM);
  console.log("House wallet:    ", HOUSE_WALLET);
  console.log("");

  const deployerETH = await publicClient.getBalance({ address: deployer.account.address });
  console.log("Deployer ETH:    ", formatEther(deployerETH), "ETH");

  console.log("\n─── Starting deployment... ───\n");

  let tx: Addr;

  // ═════════════════════════════════════════════════════════════════════════
  // 1. DEPLOY CRASH GAME
  // ═════════════════════════════════════════════════════════════════════════
  console.log("1. Deploying CrashGame...");
  const crash = await viem.deployContract("CrashGame", [
    TOKEN_ADDRESS,                // EVA token
    HANDLER,                      // PaymentHandler
    RANDOM,                       // RandomProviderV2
    deployer.account.address,     // admin = deployer
    OPERATOR,                     // operator = backend hot wallet
  ]);
  console.log("   CrashGame deployed:", crash.address);

  // ═════════════════════════════════════════════════════════════════════════
  // 2. CONFIGURE FOR 100 EVA LIQUIDITY
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n2. Configuring game parameters for 100 EVA liquidity...");

  tx = await crash.write.setOperatorBondAmount(
    [OPERATOR_BOND],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   operatorBondAmount:", formatEther(OPERATOR_BOND), "EVA");

  tx = await crash.write.setBetLimits(
    [MIN_BET, MAX_BET],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   betLimits: min =", formatEther(MIN_BET), "EVA, max =", formatEther(MAX_BET), "EVA");

  tx = await crash.write.setMaxPayoutPerRound(
    [MAX_PAYOUT_PER_ROUND],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   maxPayoutPerRound:", formatEther(MAX_PAYOUT_PER_ROUND), "EVA");

  tx = await crash.write.setMaxMultiplier(
    [MAX_MULTIPLIER],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   maxMultiplier: 100.00x");

  tx = await crash.write.setReservationMultiplier(
    [RESERVATION_MULT],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   reservationMultiplier: 50.00x");

  // ═════════════════════════════════════════════════════════════════════════
  // 3. REGISTER IN PAYMENT HANDLER
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n3. Registering CrashGame in PaymentHandler...");

  const handler = await viem.getContractAt("PaymentHandler", HANDLER);

  tx = await handler.write.registerGame(
    [crash.address, crash.address, HOUSE_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await handler.write.setGameStatus(
    [crash.address, true],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   CrashGame registered & enabled (payoutTarget = self, 1.5% + 1.5%)");

  // ═════════════════════════════════════════════════════════════════════════
  // 4. REGISTER IN RANDOM PROVIDER V2
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n4. Registering CrashGame in RandomProviderV2...");

  const random = await viem.getContractAt("RandomProviderV2", RANDOM);

  tx = await random.write.setConsumerStatus(
    [crash.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   CrashGame enabled as VRF consumer (rangeLimit =", CONSUMER_RANGE_LIMIT.toString(), ")");

  // ═════════════════════════════════════════════════════════════════════════
  // 5. DEPOSIT OPERATOR BOND (from deployer, on behalf of operator)
  // ═════════════════════════════════════════════════════════════════════════
  // NOTE: depositBond is onlyOperator. The deployer can't call it directly.
  // The operator must call depositBond(10 ether) from their own wallet.
  // We print instructions instead.
  console.log("\n5. Operator bond...");
  console.log("   Bond amount:      ", formatEther(OPERATOR_BOND), "EVA");
  console.log("   ⚠  depositBond() is onlyOperator — the operator wallet must call it:");
  console.log("   Operator wallet:  ", OPERATOR);
  console.log("   1. Operator approves CrashGame to spend EVA:");
  console.log("      evaToken.approve(", crash.address, ",", formatEther(OPERATOR_BOND), ")");
  console.log("   2. Operator deposits bond:");
  console.log("      crashGame.depositBond(", formatEther(OPERATOR_BOND), ")");

  // ═════════════════════════════════════════════════════════════════════════
  // 6. SAVE DEPLOYMENT
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n6. Saving deployment record...");

  const deployment = {
    contract: "CrashGame",
    version: "V5",
    deployedAt: new Date().toISOString(),
    network: networkName,
    crashGame: crash.address,
    infrastructure: {
      token: TOKEN_ADDRESS,
      handler: HANDLER,
      randomProvider: RANDOM,
      house: HOUSE_WALLET,
    },
    roles: {
      admin: deployer.account.address,
      operator: OPERATOR,
    },
    config: {
      houseEdgeBps: HOUSE_EDGE_BPS,
      referralBps: REFERRAL_BPS,
      operatorBondAmount: formatEther(OPERATOR_BOND) + " EVA",
      minBetAmount: formatEther(MIN_BET) + " EVA",
      maxBetAmount: formatEther(MAX_BET) + " EVA",
      maxPayoutPerRound: formatEther(MAX_PAYOUT_PER_ROUND) + " EVA",
      maxMultiplier: "100.00x",
      reservationMultiplier: "50.00x",
      roundIntervalSeconds: 40,
      bettingWindowSeconds: 30,
      revealDeadlineSeconds: 60,
      claimWindowSeconds: 604_800,
      maxBetsPerRound: 2,
    },
  };

  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const deploymentPath = new URL("crash-mainnet.json", deploymentsDir);
  await fs.writeFile(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("   Saved to", deploymentPath.pathname);

  // ═════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  CRASH GAME DEPLOYMENT COMPLETE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  CrashGame:           ", crash.address);
  console.log("  Admin:               ", deployer.account.address);
  console.log("  Operator:            ", OPERATOR);
  console.log("");
  console.log("  Configuration:");
  console.log("    operatorBond:       ", formatEther(OPERATOR_BOND), "EVA");
  console.log("    minBet:             ", formatEther(MIN_BET), "EVA");
  console.log("    maxBet:             ", formatEther(MAX_BET), "EVA");
  console.log("    maxPayoutPerRound:  ", formatEther(MAX_PAYOUT_PER_ROUND), "EVA");
  console.log("    maxMultiplier:       100.00x");
  console.log("    reservationMult:     50.00x");
  console.log("    houseEdge:           1.5% + referral 1.5% = 3% total");
  console.log("    roundInterval:       40s");
  console.log("    bettingWindow:       30s");
  console.log("");
  console.log("  Deployment saved:     crash-mainnet.json");
  console.log("");
  console.log("  NEXT STEPS:");
  console.log("    1. Verify on Arbiscan:");
  console.log("       npx hardhat verify --network arbitrum", crash.address, TOKEN_ADDRESS, HANDLER, RANDOM, deployer.account.address, OPERATOR);
  console.log("    2. Operator deposits bond (from operator wallet):");
  console.log("       evaToken.approve(crashGame, 10 EVA) → crashGame.depositBond(10 EVA)");
  console.log("    3. Fund the bankroll (from deployer):");
  console.log("       evaToken.transfer(", crash.address, ", 100 EVA)");
  console.log("    4. Operator can now createRound() to start the game");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
