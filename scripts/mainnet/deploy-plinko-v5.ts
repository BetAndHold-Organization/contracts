import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════════
// PLINKO MAINNET DEPLOYMENT — V5 INFRASTRUCTURE
// Deploys Plinko, loads multiplier tables, configures parameters,
// and registers in PaymentHandler + RandomProviderV2.
// Does NOT fund the bankroll — fund manually after verifying the deployment.
// ═══════════════════════════════════════════════════════════════════════════

// ─── V5 Infrastructure (from arb-mainnet-v5.json) ────────────────────────
const TOKEN_ADDRESS  = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as Addr;
const HANDLER        = "0xabe66fc056dd0e116b90201e487ea102fd7df1ba" as Addr;
const RANDOM         = "0x6513baa6c53a570ec899bb1504a95f160b8d7850" as Addr;
const HOUSE_WALLET   = "0x2132c5e539F1Da6090424644576ABB5C5aDcdbbd" as Addr;

// ─── Fee structure (matches V5 roulette/mines) ───────────────────────────
const HOUSE_EDGE_BPS = 150;    // 1.5% house edge → feeRecipient
const REFERRAL_BPS   = 150;    // 1.5% referral   → referral contract

// ─── Plinko VRF config ──────────────────────────────────────────────────
// Plinko requests 1 range per bet (uses raw randomWord for bit extraction)
const CONSUMER_RANGE_LIMIT = 1n;

// ─── Plinko game parameters ─────────────────────────────────────────────
const MIN_BET         = parseEther("0.1");  // 0.1 EVA minimum totalWager
const MAX_BET         = parseEther("5");    // 5 EVA maximum totalWager
const MAX_DROPS       = 10;                 // max balls per bet
const ALLOWED_ROWS    = [8, 10, 12, 14, 16] as const;
const PENDING_PER_PLAYER = 5;               // max concurrent bets per wallet
const TOTAL_PENDING   = 30;                 // system-wide pending bets cap
const BET_EXPIRY      = 3600n;              // ~15 min on Arbitrum (250 ms/block)

// ═══════════════════════════════════════════════════════════════════════════
// MULTIPLIER TABLES — RTP ~96%, MULTIPLIER_SCALE = 100
// Strictly decreasing from edge (jackpot) to center (minimum).
// All tables verified mathematically — see mainnet-configuration-guide.md §3-4.
// ═══════════════════════════════════════════════════════════════════════════

// RiskLevel enum: 0 = Low, 1 = Medium, 2 = High
const MULTIPLIER_TABLES: Array<{ rows: number; risk: number; mults: bigint[] }> = [
  // ─── 8 Rows ──────────────────────────────────────────────────────────
  { rows: 8,  risk: 0, mults: [560n, 210n, 110n, 100n, 39n, 100n, 110n, 210n, 560n] },
  { rows: 8,  risk: 1, mults: [1300n, 300n, 130n, 70n, 29n, 70n, 130n, 300n, 1300n] },
  { rows: 8,  risk: 2, mults: [1800n, 560n, 120n, 40n, 12n, 40n, 120n, 560n, 1800n] },

  // ─── 10 Rows ─────────────────────────────────────────────────────────
  { rows: 10, risk: 0, mults: [890n, 300n, 140n, 110n, 100n, 38n, 100n, 110n, 140n, 300n, 890n] },
  { rows: 10, risk: 1, mults: [2200n, 500n, 200n, 140n, 60n, 28n, 60n, 140n, 200n, 500n, 2200n] },
  { rows: 10, risk: 2, mults: [7500n, 990n, 300n, 90n, 30n, 9n, 30n, 90n, 300n, 990n, 7500n] },

  // ─── 12 Rows ─────────────────────────────────────────────────────────
  { rows: 12, risk: 0, mults: [750n, 450n, 280n, 180n, 110n, 70n, 49n, 70n, 110n, 180n, 280n, 450n, 750n] },
  { rows: 12, risk: 1, mults: [3000n, 700n, 300n, 160n, 90n, 70n, 65n, 70n, 90n, 160n, 300n, 700n, 3000n] },
  { rows: 12, risk: 2, mults: [16800n, 2400n, 800n, 200n, 70n, 15n, 11n, 15n, 70n, 200n, 800n, 2400n, 16800n] },

  // ─── 14 Rows ─────────────────────────────────────────────────────────
  { rows: 14, risk: 0, mults: [910n, 520n, 240n, 180n, 130n, 110n, 85n, 50n, 85n, 110n, 130n, 180n, 240n, 520n, 910n] },
  { rows: 14, risk: 1, mults: [5200n, 1300n, 430n, 300n, 150n, 85n, 65n, 58n, 65n, 85n, 150n, 300n, 430n, 1300n, 5200n] },
  { rows: 14, risk: 2, mults: [52400n, 7000n, 1500n, 370n, 160n, 50n, 30n, 9n, 30n, 50n, 160n, 370n, 1500n, 7000n, 52400n] },

  // ─── 16 Rows ─────────────────────────────────────────────────────────
  { rows: 16, risk: 0, mults: [2000n, 1100n, 600n, 350n, 200n, 130n, 90n, 80n, 45n, 80n, 90n, 130n, 200n, 350n, 600n, 1100n, 2000n] },
  { rows: 16, risk: 1, mults: [7800n, 1800n, 800n, 450n, 250n, 150n, 90n, 60n, 38n, 60n, 90n, 150n, 250n, 450n, 800n, 1800n, 7800n] },
  { rows: 16, risk: 2, mults: [99000n, 12900n, 2600n, 890n, 400n, 200n, 20n, 17n, 12n, 17n, 20n, 200n, 400n, 890n, 2600n, 12900n, 99000n] },
];

const RISK_NAMES = ["Low", "Medium", "High"] as const;

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
  console.log("  PLINKO DEPLOYMENT — ARBITRUM MAINNET (V5 Infrastructure)");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Network:         ", networkName);
  console.log("Deployer:        ", deployer.account.address);
  console.log("Token (EVA):     ", TOKEN_ADDRESS);
  console.log("PaymentHandler:  ", HANDLER);
  console.log("RandomProviderV2:", RANDOM);
  console.log("House wallet:    ", HOUSE_WALLET);
  console.log("");

  // ─── Pre-flight: check deployer ETH balance ─────────────────────────

  const deployerETH = await publicClient.getBalance({ address: deployer.account.address });
  console.log("Deployer ETH:    ", formatEther(deployerETH), "ETH");

  console.log("\n─── Starting deployment... ───\n");

  let tx: Addr;

  // ═════════════════════════════════════════════════════════════════════════
  // 1. DEPLOY PLINKO CONTRACT
  // ═════════════════════════════════════════════════════════════════════════
  console.log("1. Deploying Plinko...");
  const plinko = await viem.deployContract("Plinko", [
    HANDLER,         // PaymentHandler
    RANDOM,          // RandomProviderV2
    TOKEN_ADDRESS,   // EVA token
    0n,              // minBet (set later via setBetLimits)
    0n,              // maxBet (set later via setBetLimits)
  ]);
  console.log("   Plinko deployed:", plinko.address);

  // ═════════════════════════════════════════════════════════════════════════
  // 2. SET MULTIPLIER TABLES (15 calls)
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n2. Setting multiplier tables (15 tables, RTP ~96%)...");

  for (const table of MULTIPLIER_TABLES) {
    tx = await plinko.write.setMultipliers(
      [table.rows, table.risk, table.mults],
      { account: deployer.account },
    );
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`   ${table.rows} rows, ${RISK_NAMES[table.risk]} risk: set`);
  }
  console.log("   All 15 multiplier tables configured");

  // ═════════════════════════════════════════════════════════════════════════
  // 3. CONFIGURE GAME PARAMETERS
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n3. Configuring game parameters...");

  tx = await plinko.write.setAllowedRows(
    [ALLOWED_ROWS],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   allowedRows:", ALLOWED_ROWS.join(", "));

  tx = await plinko.write.setBetLimits(
    [MIN_BET, MAX_BET],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   betLimits: min =", formatEther(MIN_BET), "EVA, max =", formatEther(MAX_BET), "EVA");

  tx = await plinko.write.setMaxDropsPerBet(
    [MAX_DROPS],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   maxDropsPerBet:", MAX_DROPS);

  tx = await plinko.write.setMaxPendingBetsPerPlayer(
    [PENDING_PER_PLAYER],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   maxPendingBetsPerPlayer:", PENDING_PER_PLAYER);

  tx = await plinko.write.setMaxTotalPendingBets(
    [BigInt(TOTAL_PENDING)],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   maxTotalPendingBets:", TOTAL_PENDING);

  tx = await plinko.write.setBetExpiryBlocks(
    [BET_EXPIRY],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   betExpiryBlocks:", BET_EXPIRY.toString(), "(~15 min on Arbitrum)");

  // ═════════════════════════════════════════════════════════════════════════
  // 4. REGISTER IN PAYMENT HANDLER
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n4. Registering Plinko in PaymentHandler...");

  const handler = await viem.getContractAt("PaymentHandler", HANDLER);

  tx = await handler.write.registerGame(
    [plinko.address, plinko.address, HOUSE_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });

  tx = await handler.write.setGameStatus(
    [plinko.address, true],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Plinko registered & enabled (payoutTarget = self, 1.5% + 1.5%)");

  // ═════════════════════════════════════════════════════════════════════════
  // 5. REGISTER IN RANDOM PROVIDER V2
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n5. Registering Plinko in RandomProviderV2...");

  const random = await viem.getContractAt("RandomProviderV2", RANDOM);

  tx = await random.write.setConsumerStatus(
    [plinko.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Plinko enabled as VRF consumer (rangeLimit =", CONSUMER_RANGE_LIMIT.toString(), ")");

  // ═════════════════════════════════════════════════════════════════════════
  // 6. SAVE DEPLOYMENT
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n6. Saving deployment record...");

  const deployment = {
    contract: "Plinko",
    version: "V5",
    deployedAt: new Date().toISOString(),
    network: networkName,
    plinko: plinko.address,
    infrastructure: {
      token: TOKEN_ADDRESS,
      handler: HANDLER,
      randomProvider: RANDOM,
      house: HOUSE_WALLET,
    },
    deployer: deployer.account.address,
    config: {
      houseEdgeBps: HOUSE_EDGE_BPS,
      referralBps: REFERRAL_BPS,
      minBet: MIN_BET.toString(),
      maxBet: MAX_BET.toString(),
      maxDropsPerBet: MAX_DROPS,
      allowedRows: [...ALLOWED_ROWS],
      maxPendingBetsPerPlayer: PENDING_PER_PLAYER,
      maxTotalPendingBets: TOTAL_PENDING,
      betExpiryBlocks: BET_EXPIRY.toString(),
      multiplierScale: 100,
      rtp: "~96%",
      multiplierTables: MULTIPLIER_TABLES.map((t) => ({
        rows: t.rows,
        risk: RISK_NAMES[t.risk],
        maxMult: Number(t.mults.reduce((a, b) => (a > b ? a : b), 0n)),
      })),
    },
  };

  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const deploymentPath = new URL("plinko-mainnet-v5.json", deploymentsDir);
  await fs.writeFile(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("   Saved to", deploymentPath.pathname);

  // ═════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  PLINKO DEPLOYMENT COMPLETE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Plinko:              ", plinko.address);
  console.log("  Token (EVA):         ", TOKEN_ADDRESS);
  console.log("  PaymentHandler:      ", HANDLER);
  console.log("  RandomProviderV2:    ", RANDOM);
  console.log("  House wallet:        ", HOUSE_WALLET);
  console.log("");
  console.log("  Configuration:");
  console.log("    minBet:            ", formatEther(MIN_BET), "EVA");
  console.log("    maxBet:            ", formatEther(MAX_BET), "EVA");
  console.log("    maxDropsPerBet:    ", MAX_DROPS);
  console.log("    allowedRows:       ", ALLOWED_ROWS.join(", "));
  console.log("    pendingPerPlayer:  ", PENDING_PER_PLAYER);
  console.log("    totalPendingCap:   ", TOTAL_PENDING);
  console.log("    betExpiryBlocks:   ", BET_EXPIRY.toString());
  console.log("    houseEdge:          1.5% + referral 1.5% = 3% total");
  console.log("    RTP:               ~96% (bankroll grows ~+1% per wager)");
  console.log("    multiplier tables:  15 (5 rows × 3 risk levels)");
  console.log("");
  console.log("  Deployment saved:     plinko-mainnet-v5.json");
  console.log("");
  console.log("  NEXT STEPS:");
  console.log("    1. Verify on Arbiscan:");
  console.log("       npx hardhat verify --network arbitrum", plinko.address, HANDLER, RANDOM, TOKEN_ADDRESS, "0 0");
  console.log("    2. Fund the bankroll:");
  console.log("       evaToken.transfer(", plinko.address, ", amount)");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
