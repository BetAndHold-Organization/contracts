import "dotenv/config";
import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther } from "viem";

type Addr = `0x${string}`;

// ============================================================
// CONFIGURATION - Edit these values
// ============================================================
const TO_ADDRESS = "0xBCA4c208a9884059E176dcBa975Fc2C4d9AA3f3D" as Addr;
const AMOUNT = parseEther("10000000"); // 10,000,000 EVA

// ============================================================
// MAIN
// ============================================================
async function loadDeployment() {
  const p = new URL("./deployments/sepolia-light.json", import.meta.url);
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function main() {
  const deployment = await loadDeployment();
  const conn = await network.connect();
  const viem = conn.viem;
  const [sender] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                    TOKEN TRANSFER                             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Token:      ", deployment.token);
  console.log("From:       ", sender.account.address);
  console.log("To:         ", TO_ADDRESS);
  console.log("Amount:     ", formatEther(AMOUNT), "EVA");
  console.log("");

  const token = await viem.getContractAt("EverValueCoin", "0xf0f64954d9a44103e19c9d06f1c26a6448383940");

  // Check balance
  const balance = await token.read.balanceOf([sender.account.address]);
  console.log("Sender balance:", formatEther(balance), "EVA");

  if (balance < AMOUNT) {
    throw new Error(`Insufficient balance: have ${formatEther(balance)}, need ${formatEther(AMOUNT)}`);
  }

  // Transfer
  console.log("\nTransferring...");
  const tx = await token.write.transfer([TO_ADDRESS, AMOUNT], { account: sender.account });
  console.log("Tx:", tx);

  await publicClient.waitForTransactionReceipt({ hash: tx });

  // Verify
  const newBalance = await token.read.balanceOf([TO_ADDRESS]);
  console.log("\n✅ Transfer complete!");
  console.log("Recipient new balance:", formatEther(newBalance), "EVA");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

