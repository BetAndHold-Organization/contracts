/**
 * Diagnose MultiLineSlots configuration and readiness
 */

import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("              DIAGNOSE MULTILINE SLOTS                              ");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Load deployment
  const deploymentPath = new URL("./deployments/arb-mainnet-public.json", import.meta.url);
  const content = await fs.readFile(deploymentPath, "utf-8");
  const deployment = JSON.parse(content);

  const slotsAddress = deployment.slots as Addr;
  const tokenAddress = deployment.token as Addr;
  const handlerAddress = deployment.handler as Addr;
  const randomProviderAddress = deployment.randomProvider as Addr;
  const jackpotAddress = deployment.jackpot as Addr;

  console.log("Contract addresses:");
  console.log("  Slots:", slotsAddress);
  console.log("  Token:", tokenAddress);
  console.log("  Handler:", handlerAddress);
  console.log("  RandomProvider:", randomProviderAddress);
  console.log("  Jackpot:", jackpotAddress);
  console.log("");

  // Connect
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  
  const playerAddress = deployer.account.address;
  console.log("Testing as player:", playerAddress);
  console.log("");

  const slots = await viem.getContractAt("MultiLineSlots", slotsAddress);
  const token = await viem.getContractAt("EverValueCoin", tokenAddress);
  const handler = await viem.getContractAt("PaymentHandler", handlerAddress);
  const randomProvider = await viem.getContractAt("RandomProvider", randomProviderAddress);

  let allGood = true;

  // ═══════════════════════════════════════════════════════════════════════
  //                         1. SLOTS CONFIG
  // ═══════════════════════════════════════════════════════════════════════
  console.log("1️⃣  SLOTS CONFIG");
  console.log("─────────────────────────────────────────────────────────────────");
  
  const slotsConfig = await slots.read.getSlotsConfig();
  console.log("  enabled:", slotsConfig.enabled);
  console.log("  activeSymbolCount:", slotsConfig.activeSymbolCount);
  console.log("  jackpotContributionBps:", slotsConfig.jackpotContributionBps);
  console.log("  minWagerPerLine:", formatEther(slotsConfig.minWagerPerLine), "EVA");
  console.log("  maxWagerPerLine:", formatEther(slotsConfig.maxWagerPerLine), "EVA");
  
  if (!slotsConfig.enabled) {
    console.log("  ❌ SLOTS NOT ENABLED!");
    allGood = false;
  } else {
    console.log("  ✅ Slots enabled");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                         2. SYMBOL CONFIG
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n2️⃣  SYMBOL CONFIG");
  console.log("─────────────────────────────────────────────────────────────────");
  
  const totalWeight = await slots.read.totalSymbolWeight();
  console.log("  totalSymbolWeight:", totalWeight);
  
  if (totalWeight === 0n) {
    console.log("  ❌ SYMBOL WEIGHTS NOT CONFIGURED!");
    allGood = false;
  } else {
    console.log("  ✅ Symbols configured");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                         3. PAYMENT HANDLER REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n3️⃣  PAYMENT HANDLER REGISTRATION");
  console.log("─────────────────────────────────────────────────────────────────");
  
  const gameConfig = await handler.read.getGameConfig([slotsAddress]);
  console.log("  enabled:", gameConfig[0]);
  console.log("  payoutTarget:", gameConfig[1]);
  console.log("  feeRecipient:", gameConfig[2]);
  console.log("  houseEdgeBps:", gameConfig[3]);
  console.log("  referralBps:", gameConfig[4]);
  
  if (!gameConfig[0]) {
    console.log("  ❌ GAME NOT ENABLED IN PAYMENT HANDLER!");
    allGood = false;
  } else {
    console.log("  ✅ Game enabled in PaymentHandler");
  }

  if (gameConfig[1].toLowerCase() !== slotsAddress.toLowerCase()) {
    console.log("  ❌ PAYOUT TARGET MISMATCH! Expected:", slotsAddress);
    allGood = false;
  } else {
    console.log("  ✅ Payout target correct");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                         4. WHITELIST CHECK
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n4️⃣  WHITELIST / BLACKLIST");
  console.log("─────────────────────────────────────────────────────────────────");
  
  const whitelistEnabled = await handler.read.whitelistEnabled();
  const blacklistEnabled = await handler.read.blacklistEnabled();
  console.log("  whitelistEnabled:", whitelistEnabled);
  console.log("  blacklistEnabled:", blacklistEnabled);
  
  if (whitelistEnabled) {
    const isWhitelisted = await handler.read.whitelist([playerAddress]);
    console.log("  Player whitelisted:", isWhitelisted);
    if (!isWhitelisted) {
      console.log("  ❌ PLAYER NOT WHITELISTED!");
      allGood = false;
    }
  } else {
    console.log("  ✅ Whitelist disabled (public access)");
  }

  if (blacklistEnabled) {
    const isBlacklisted = await handler.read.blacklist([playerAddress]);
    if (isBlacklisted) {
      console.log("  ❌ PLAYER IS BLACKLISTED!");
      allGood = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                         5. RANDOM PROVIDER REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n5️⃣  RANDOM PROVIDER REGISTRATION");
  console.log("─────────────────────────────────────────────────────────────────");
  
  try {
    const consumerStatus = await randomProvider.read.allowedConsumers([slotsAddress]);
    console.log("  Consumer allowed:", consumerStatus[0]);
    console.log("  Range limit:", consumerStatus[1]);
    
    if (!consumerStatus[0]) {
      console.log("  ❌ SLOTS NOT REGISTERED AS CONSUMER!");
      allGood = false;
    } else {
      console.log("  ✅ Slots registered in RandomProvider");
    }
  } catch (e) {
    console.log("  ⚠️ Could not check consumer status");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                         6. PLAYER BALANCE & APPROVAL
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n6️⃣  PLAYER BALANCE & APPROVAL");
  console.log("─────────────────────────────────────────────────────────────────");
  
  const playerBalance = await token.read.balanceOf([playerAddress]);
  const allowance = await token.read.allowance([playerAddress, handlerAddress]);
  
  console.log("  Player EVA balance:", formatEther(playerBalance), "EVA");
  console.log("  Allowance to Handler:", formatEther(allowance), "EVA");
  
  if (playerBalance === 0n) {
    console.log("  ❌ PLAYER HAS NO EVA TOKENS!");
    allGood = false;
  } else {
    console.log("  ✅ Player has EVA balance");
  }

  if (allowance === 0n) {
    console.log("  ❌ PLAYER HAS NOT APPROVED PAYMENT HANDLER!");
    console.log("     Player needs to call: token.approve(", handlerAddress, ", amount)");
    allGood = false;
  } else {
    console.log("  ✅ Player has approved PaymentHandler");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                         7. SLOTS LIQUIDITY
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n7️⃣  SLOTS LIQUIDITY");
  console.log("─────────────────────────────────────────────────────────────────");
  
  const slotsBalance = await token.read.balanceOf([slotsAddress]);
  const lockedExposure = await slots.read.lockedExposure();
  const availableLiquidity = await slots.read.availableLiquidity();
  
  console.log("  Slots EVA balance:", formatEther(slotsBalance), "EVA");
  console.log("  Locked exposure:", formatEther(lockedExposure), "EVA");
  console.log("  Available liquidity:", formatEther(availableLiquidity), "EVA");
  
  if (slotsBalance === 0n) {
    console.log("  ❌ SLOTS CONTRACT NOT FUNDED!");
    allGood = false;
  } else {
    console.log("  ✅ Slots contract has funds");
  }

  // Test max payout for minimum bet
  const minWager = slotsConfig.minWagerPerLine;
  const maxMultiplier = 5100n; // Tiger 51x in hundredths
  const maxPayoutFor1Line = (minWager * maxMultiplier) / 100n;
  const maxPayoutFor5Lines = maxPayoutFor1Line * 5n;
  
  console.log("\n  For min bet (", formatEther(minWager), "EVA/line):");
  console.log("    Max payout (1 line):", formatEther(maxPayoutFor1Line), "EVA");
  console.log("    Max payout (5 lines):", formatEther(maxPayoutFor5Lines), "EVA");
  
  if (availableLiquidity < maxPayoutFor1Line) {
    console.log("  ❌ NOT ENOUGH LIQUIDITY FOR EVEN 1-LINE MIN BET!");
    allGood = false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                         8. JACKPOT INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n8️⃣  JACKPOT INTEGRATION");
  console.log("─────────────────────────────────────────────────────────────────");
  
  const jackpotAddr = await slots.read.jackpot();
  console.log("  Jackpot address in slots:", jackpotAddr);
  
  if (jackpotAddr === "0x0000000000000000000000000000000000000000") {
    console.log("  ⚠️ Jackpot not set (contributions will be skipped)");
  } else {
    console.log("  ✅ Jackpot configured");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                         SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════════");
  if (allGood) {
    console.log("✅ ALL CHECKS PASSED - Slots should be ready!");
  } else {
    console.log("❌ SOME CHECKS FAILED - Fix the issues above");
  }
  console.log("═══════════════════════════════════════════════════════════════════");

  // Quick fix commands if needed
  if (allowance === 0n) {
    console.log("\n📋 TO APPROVE PAYMENT HANDLER:");
    console.log(`   Token: ${tokenAddress}`);
    console.log(`   Call: approve(${handlerAddress}, <amount>)`);
  }

  if (slotsBalance === 0n) {
    console.log("\n📋 TO FUND SLOTS:");
    console.log(`   Transfer EVA to: ${slotsAddress}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});



