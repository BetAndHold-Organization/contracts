/**
 * Test spin on MultiLineSlots
 * This script attempts to execute a spin and captures any errors
 */

import { network } from "hardhat";
import { parseEther, formatEther, decodeErrorResult } from "viem";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("              TEST SPIN ON MULTILINE SLOTS                          ");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Load deployment
  const deploymentPath = new URL("./deployments/arb-mainnet-public.json", import.meta.url);
  const content = await fs.readFile(deploymentPath, "utf-8");
  const deployment = JSON.parse(content);

  const slotsAddress = deployment.slots as Addr;
  const tokenAddress = deployment.token as Addr;
  const handlerAddress = deployment.handler as Addr;

  console.log("Slots:", slotsAddress);
  console.log("Token:", tokenAddress);
  console.log("Handler:", handlerAddress);

  // Connect
  const conn = await network.connect();
  const viem = conn.viem;
  const [player] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("\nPlayer:", player.account.address);

  const slots = await viem.getContractAt("MultiLineSlots", slotsAddress);
  const token = await viem.getContractAt("EverValueCoin", tokenAddress);

  // Spin parameters
  const wagerPerLine = parseEther("0.0001"); // Minimum bet
  const paylineCount = 1; // Just 1 line for testing
  const potentialReferrer = "0x0000000000000000000000000000000000000000";

  console.log("\n─────────────────────────────────────────────────────────────────");
  console.log("SPIN PARAMETERS:");
  console.log("  Wager per line:", formatEther(wagerPerLine), "EVA");
  console.log("  Paylines:", paylineCount);
  console.log("  Total bet:", formatEther(wagerPerLine * BigInt(paylineCount)), "EVA");
  console.log("─────────────────────────────────────────────────────────────────\n");

  // Pre-flight checks
  console.log("PRE-FLIGHT CHECKS:");
  
  const balance = await token.read.balanceOf([player.account.address]);
  console.log("  Player balance:", formatEther(balance), "EVA");
  
  const allowance = await token.read.allowance([player.account.address, handlerAddress]);
  console.log("  Allowance to handler:", formatEther(allowance), "EVA");

  const slotsConfig = await slots.read.getSlotsConfig();
  console.log("  Slots enabled:", slotsConfig.enabled);
  console.log("  Min wager:", formatEther(slotsConfig.minWagerPerLine), "EVA");

  const availableLiq = await slots.read.availableLiquidity();
  console.log("  Available liquidity:", formatEther(availableLiq), "EVA");

  // Calculate expected max payout
  const maxPayout = (wagerPerLine * 5100n * BigInt(paylineCount)) / 100n; // 51x max
  console.log("  Max possible payout:", formatEther(maxPayout), "EVA");

  if (availableLiq < maxPayout) {
    console.log("\n❌ NOT ENOUGH LIQUIDITY!");
    return;
  }

  console.log("\n─────────────────────────────────────────────────────────────────");
  console.log("ATTEMPTING SPIN...");
  console.log("─────────────────────────────────────────────────────────────────\n");

  try {
    // First, try to simulate the call
    console.log("1. Simulating transaction...");
    
    const { request } = await publicClient.simulateContract({
      address: slotsAddress,
      abi: slots.abi,
      functionName: "startSpin",
      args: [wagerPerLine, paylineCount, potentialReferrer],
      account: player.account,
    });
    
    console.log("   ✅ Simulation successful!");
    console.log("   Gas estimate:", request.gas?.toString());

    // Execute the actual transaction
    console.log("\n2. Sending transaction...");
    
    const txHash = await player.writeContract(request);
    console.log("   Tx hash:", txHash);

    console.log("\n3. Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    
    console.log("   Status:", receipt.status);
    console.log("   Gas used:", receipt.gasUsed.toString());
    console.log("   Block:", receipt.blockNumber.toString());

    if (receipt.status === "success") {
      console.log("\n═══════════════════════════════════════════════════════════════════");
      console.log("✅ SPIN STARTED SUCCESSFULLY!");
      console.log("═══════════════════════════════════════════════════════════════════");
      
      // Try to get the request ID from logs
      console.log("\nLogs:", receipt.logs.length);
      for (const log of receipt.logs) {
        console.log("  Topic 0:", log.topics[0]);
      }
    } else {
      console.log("\n❌ Transaction reverted");
    }

  } catch (error: any) {
    console.log("\n═══════════════════════════════════════════════════════════════════");
    console.log("❌ ERROR CAUGHT!");
    console.log("═══════════════════════════════════════════════════════════════════\n");
    
    // Try to decode the error
    if (error.cause?.data) {
      console.log("Error data:", error.cause.data);
      
      // Try to decode with slots ABI
      try {
        const decoded = decodeErrorResult({
          abi: slots.abi,
          data: error.cause.data,
        });
        console.log("\nDecoded error:", decoded.errorName);
        console.log("Args:", decoded.args);
      } catch {
        console.log("Could not decode with slots ABI");
      }
    }

    // Print full error details
    console.log("\nFull error message:");
    console.log(error.message || error);
    
    if (error.shortMessage) {
      console.log("\nShort message:", error.shortMessage);
    }
    
    if (error.metaMessages) {
      console.log("\nMeta messages:", error.metaMessages);
    }

    // Check if it's a specific revert reason
    const errorStr = String(error);
    
    if (errorStr.includes("SlotsDisabled")) {
      console.log("\n→ CAUSE: Slots game is disabled");
    } else if (errorStr.includes("InvalidPaylineCount")) {
      console.log("\n→ CAUSE: Invalid payline count (must be 1, 3, or 5)");
    } else if (errorStr.includes("WagerTooLow")) {
      console.log("\n→ CAUSE: Wager per line is below minimum");
    } else if (errorStr.includes("WagerTooHigh")) {
      console.log("\n→ CAUSE: Wager per line is above maximum");
    } else if (errorStr.includes("InvalidSymbolConfig")) {
      console.log("\n→ CAUSE: Symbol weights not configured (totalWeight = 0)");
    } else if (errorStr.includes("PaymentHandlerMisconfigured")) {
      console.log("\n→ CAUSE: Payment handler payout target mismatch");
    } else if (errorStr.includes("LiquidityShortfall")) {
      console.log("\n→ CAUSE: Not enough liquidity to cover max payout");
    } else if (errorStr.includes("NotWhitelisted")) {
      console.log("\n→ CAUSE: Player is not whitelisted in PaymentHandler");
    } else if (errorStr.includes("Blacklisted")) {
      console.log("\n→ CAUSE: Player is blacklisted in PaymentHandler");
    } else if (errorStr.includes("UnauthorizedCaller")) {
      console.log("\n→ CAUSE: Slots not registered as consumer in RandomProvider");
    } else if (errorStr.includes("insufficient allowance")) {
      console.log("\n→ CAUSE: Player hasn't approved enough tokens to PaymentHandler");
    } else if (errorStr.includes("transfer amount exceeds balance")) {
      console.log("\n→ CAUSE: Player doesn't have enough EVA tokens");
    }
  }
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exitCode = 1;
});

