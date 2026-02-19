/**
 * Deploy MultiLineSlots to Arbitrum Mainnet
 * 
 * This script deploys the MultiLineSlots contract and connects it with
 * the existing deployed infrastructure (PaymentHandler, RandomProvider, ProgressiveJackpot).
 * 
 * Prerequisites:
 * - Existing deployment in scripts/mainnet/deployments/arb-mainnet-public.json
 * - .env with MAINNET_DEPLOYER_PRIVATE_KEY
 * 
 * This script does NOT fund the contract - do that separately after deployment.
 */

import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";
import { spawn } from "node:child_process";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════
//                          CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const VERIFY = true;
const CONSUMER_RANGE_LIMIT = 9n; // 9 random values for 3x3 grid

// Game settings
const HOUSE_EDGE_BPS = 200;      // 2% house edge (same as roulette)
const REFERRAL_BPS = 200;        // 2% referral fee (same as roulette)
const JACKPOT_CONTRIB_BPS = 350; // 3.5% jackpot contribution
const MIN_WAGER_PER_LINE = parseEther("0.1");
const MAX_WAGER_PER_LINE = parseEther("3");

// Symbol configurations (RTP ~92.84% to match 7.36% effective edge)
// Indices: 0=Cherry, 1=Lemon, 2=Orange, 3=Diamond, 4=Tiger, 5=Wild, 6-7=unused
const SYMBOL_CONFIGS = [
  { // 0: Cherry 🍒 (30%)
    weightBps: 3000,
    threeMatchPayout: 405,  // 4.05x
    twoMatchPayout: 53,     // 0.53x
    isWild: false,
    enabled: true,
  },
  { // 1: Lemon 🍋 (27%)
    weightBps: 2700,
    threeMatchPayout: 510,  // 5.1x
    twoMatchPayout: 63,     // 0.63x
    isWild: false,
    enabled: true,
  },
  { // 2: Orange 🍊 (20%)
    weightBps: 2000,
    threeMatchPayout: 815,  // 8.15x
    twoMatchPayout: 107,    // 1.07x
    isWild: false,
    enabled: true,
  },
  { // 3: Diamond 💎 (13%)
    weightBps: 1300,
    threeMatchPayout: 1830, // 18.3x
    twoMatchPayout: 215,    // 2.15x
    isWild: false,
    enabled: true,
  },
  { // 4: Tiger 🐯 (8%)
    weightBps: 800,
    threeMatchPayout: 5100, // 51.0x
    twoMatchPayout: 420,    // 4.2x
    isWild: false,
    enabled: true,
  },
  { // 5: Wild Star 🌟 (2%)
    weightBps: 200,
    threeMatchPayout: 0,    // Wild doesn't have own payout
    twoMatchPayout: 0,
    isWild: true,
    enabled: true,
  },
  { // 6: Unused
    weightBps: 0,
    threeMatchPayout: 0,
    twoMatchPayout: 0,
    isWild: false,
    enabled: false,
  },
  { // 7: Unused
    weightBps: 0,
    threeMatchPayout: 0,
    twoMatchPayout: 0,
    isWild: false,
    enabled: false,
  },
] as const;

// ═══════════════════════════════════════════════════════════════════════
//                          VERIFICATION HELPER
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
//                              MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("              DEPLOY MULTILINE SLOTS TO ARBITRUM MAINNET           ");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Load existing deployment
  const deploymentPath = new URL("./deployments/arb-mainnet-public.json", import.meta.url);
  let existingDeployment: any;
  try {
    const content = await fs.readFile(deploymentPath, "utf-8");
    existingDeployment = JSON.parse(content);
  } catch (e) {
    throw new Error("Could not read existing deployment. Run deploy-arbitrum-mainnet-public.ts first.");
  }

  const tokenAddress = existingDeployment.token as Addr;
  const randomProviderAddress = existingDeployment.randomProvider as Addr;
  const handlerAddress = existingDeployment.handler as Addr;
  const jackpotAddress = existingDeployment.jackpot as Addr;
  const houseAddress = existingDeployment.house as Addr;

  console.log("Existing deployment loaded:");
  console.log("  Token:", tokenAddress);
  console.log("  RandomProvider:", randomProviderAddress);
  console.log("  PaymentHandler:", handlerAddress);
  console.log("  ProgressiveJackpot:", jackpotAddress);
  console.log("  House wallet:", houseAddress);
  console.log("");

  // Connect to network
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("Deployer:", deployer.account.address);
  console.log("");

  // Get contract instances
  const randomProvider = await viem.getContractAt("RandomProvider", randomProviderAddress);
  const handler = await viem.getContractAt("PaymentHandler", handlerAddress);
  const jackpot = await viem.getContractAt("ProgressiveJackpot", jackpotAddress);

  // ═══════════════════════════════════════════════════════════════════════
  //                         DEPLOY MULTILINE SLOTS
  // ═══════════════════════════════════════════════════════════════════════

  console.log("Deploying MultiLineSlots...");
  const slots = await viem.deployContract("MultiLineSlots", [
    handlerAddress,
    randomProviderAddress,
    tokenAddress,
  ]);
  console.log("✓ MultiLineSlots deployed:", slots.address);
  console.log("");

  // ═══════════════════════════════════════════════════════════════════════
  //                    REGISTER IN RANDOM PROVIDER
  // ═══════════════════════════════════════════════════════════════════════

  console.log("Registering in RandomProvider...");
  const rpTx = await randomProvider.write.setConsumerStatus(
    [slots.address, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: rpTx });
  console.log("✓ MultiLineSlots registered as RandomProvider consumer");

  // ═══════════════════════════════════════════════════════════════════════
  //                    REGISTER IN PAYMENT HANDLER
  // ═══════════════════════════════════════════════════════════════════════

  console.log("Registering in PaymentHandler...");
  const phRegTx = await handler.write.registerGame(
    [slots.address, slots.address, houseAddress, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: phRegTx });
  console.log("✓ MultiLineSlots registered in PaymentHandler");

  const phEnTx = await handler.write.setGameStatus(
    [slots.address, true],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: phEnTx });
  console.log("✓ MultiLineSlots enabled in PaymentHandler");

  // ═══════════════════════════════════════════════════════════════════════
  //                    REGISTER IN PROGRESSIVE JACKPOT
  // ═══════════════════════════════════════════════════════════════════════

  // Note: MultiLineSlots only CONTRIBUTES to jackpot, doesn't have entry.
  // We need to register it as a game so it can call addFunds()
  console.log("Registering in ProgressiveJackpot...");
  
  // Create minimal outcomes for the slots (just a fallback lose outcome)
  // The slots don't participate in jackpot draws, but need to be registered to addFunds
  const SCALING_LINEAR = 0;
  const minimalOutcomes = [{
    scaling: {
      enabled: true,
      minJackpotBps: 0,
      maxJackpotBps: 0,
      minJackpotWager: 0n,
      maxJackpotWager: 1n,
      functionId: SCALING_LINEAR,
      extraData: "0x" as `0x${string}`,
    },
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 0,
    awardsTier: false,
  }];

  const jpRegTx = await jackpot.write.registerGame(
    [slots.address, minimalOutcomes],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: jpRegTx });
  console.log("✓ MultiLineSlots registered in ProgressiveJackpot");

  const jpEnTx = await jackpot.write.setGameStatus(
    [slots.address, true],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: jpEnTx });
  console.log("✓ MultiLineSlots enabled in ProgressiveJackpot");

  // ═══════════════════════════════════════════════════════════════════════
  //                    CONFIGURE SLOTS CONTRACT
  // ═══════════════════════════════════════════════════════════════════════

  console.log("\nConfiguring MultiLineSlots...");

  // Set jackpot address
  const setJpTx = await slots.write.setJackpot([jackpotAddress], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: setJpTx });
  console.log("✓ Jackpot address set");

  // Configure all symbols
  console.log("Configuring symbols...");
  const symbolsTx = await slots.write.setAllSymbols([SYMBOL_CONFIGS], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: symbolsTx });
  console.log("✓ All symbols configured");

  // Display symbol config
  console.log("\nSymbol Configuration:");
  console.log("┌────────┬────────┬───────────┬──────────┬───────┐");
  console.log("│ ID     │ Weight │ 3-Match   │ 2-Match  │ Wild  │");
  console.log("├────────┼────────┼───────────┼──────────┼───────┤");
  const names = ["Cherry", "Lemon", "Orange", "Diamond", "Tiger", "Wild", "-", "-"];
  for (let i = 0; i < SYMBOL_CONFIGS.length; i++) {
    const s = SYMBOL_CONFIGS[i];
    if (!s.enabled) continue;
    const name = names[i].padEnd(6);
    const weight = `${(s.weightBps / 100).toFixed(0)}%`.padStart(5);
    const p3 = s.threeMatchPayout > 0 ? `${(s.threeMatchPayout / 100).toFixed(2)}x`.padStart(7) : "  -    ";
    const p2 = s.twoMatchPayout > 0 ? `${(s.twoMatchPayout / 100).toFixed(2)}x`.padStart(6) : "  -   ";
    const wild = s.isWild ? " YES " : "  -  ";
    console.log(`│ ${i}: ${name} │ ${weight} │ ${p3} │ ${p2} │ ${wild} │`);
  }
  console.log("└────────┴────────┴───────────┴──────────┴───────┘");

  // Set slots config (enable the game)
  const slotsConfigTx = await slots.write.setSlotsConfig([{
    enabled: true,
    activeSymbolCount: 6,
    jackpotContributionBps: JACKPOT_CONTRIB_BPS,
    minWagerPerLine: MIN_WAGER_PER_LINE,
    maxWagerPerLine: MAX_WAGER_PER_LINE,
  }], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: slotsConfigTx });
  console.log("\n✓ Slots config set and enabled");

  // ═══════════════════════════════════════════════════════════════════════
  //                         SAVE DEPLOYMENT INFO
  // ═══════════════════════════════════════════════════════════════════════

  // Update existing deployment with slots address
  const updatedDeployment = {
    ...existingDeployment,
    slots: slots.address,
  };

  await fs.writeFile(deploymentPath, JSON.stringify(updatedDeployment, null, 2));
  console.log("\n✓ Deployment info updated:", deploymentPath.pathname);

  // Also save slots-specific deployment
  const slotsDeploymentPath = new URL("./deployments/arb-mainnet-slots.json", import.meta.url);
  const slotsDeployment = {
    slots: slots.address,
    token: tokenAddress,
    randomProvider: randomProviderAddress,
    handler: handlerAddress,
    jackpot: jackpotAddress,
    house: houseAddress,
    config: {
      houseEdgeBps: HOUSE_EDGE_BPS,
      referralBps: REFERRAL_BPS,
      jackpotContribBps: JACKPOT_CONTRIB_BPS,
      minWagerPerLine: MIN_WAGER_PER_LINE.toString(),
      maxWagerPerLine: MAX_WAGER_PER_LINE.toString(),
    },
    deployedAt: new Date().toISOString(),
  };
  await fs.writeFile(slotsDeploymentPath, JSON.stringify(slotsDeployment, null, 2));
  console.log("✓ Slots deployment info saved:", slotsDeploymentPath.pathname);

  // ═══════════════════════════════════════════════════════════════════════
  //                              SUMMARY
  // ═══════════════════════════════════════════════════════════════════════

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("                        DEPLOYMENT COMPLETE                         ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");
  console.log("MultiLineSlots:", slots.address);
  console.log("");
  console.log("Configuration:");
  console.log("  House Edge:           ", HOUSE_EDGE_BPS / 100, "%");
  console.log("  Referral Fee:         ", REFERRAL_BPS / 100, "%");
  console.log("  Jackpot Contribution: ", JACKPOT_CONTRIB_BPS / 100, "%");
  console.log("  Min Wager/Line:       ", MIN_WAGER_PER_LINE.toString(), "wei");
  console.log("  Max Wager/Line:       ", MAX_WAGER_PER_LINE.toString(), "wei");
  console.log("  Paylines:              5 (3 horizontal + 2 diagonal)");
  console.log("  Active Symbols:        6");
  console.log("");
  console.log("⚠️  IMPORTANT: The contract is NOT funded!");
  console.log("   Fund the slots contract before players can spin:");
  console.log(`   Transfer EVA tokens to: ${slots.address}`);
  console.log("");
  console.log("   Max payout per spin (5 lines × 3 EVA × 51x Tiger):");
  console.log("   = 765 EVA per spin worst case");
  console.log("");

  // ═══════════════════════════════════════════════════════════════════════
  //                            VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════

  console.log("Waiting 30s before verification...");
  await new Promise((r) => setTimeout(r, 30_000));

  await verifyWithRetryCli("arbitrum", slots.address, [
    handlerAddress,
    randomProviderAddress,
    tokenAddress,
  ]);

  console.log("\n✅ All done!");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});



