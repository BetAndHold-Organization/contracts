import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const AIRDROP_AMOUNT = parseEther("2");  // 2 EVA per wallet
const AIRDROP_FILE = "scripts/mainnet/airdrop.txt";

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const TOKEN_ADDRESS = (process.env.MAINNET_TOKEN_ADDRESS || "").trim() as Addr;
  
  if (!TOKEN_ADDRESS) {
    throw new Error("Missing MAINNET_TOKEN_ADDRESS env variable");
  }

  // Read addresses from file (handle both Windows \r\n and Unix \n line endings)
  const fileContent = await fs.readFile(AIRDROP_FILE, "utf-8");
  const addresses = fileContent
    .replace(/\r\n/g, "\n")  // Normalize Windows line endings
    .replace(/\r/g, "\n")    // Handle old Mac line endings
    .split("\n")
    .map(line => line.trim().toLowerCase())
    .filter(line => line.length > 0 && line.startsWith("0x")) as Addr[];
  
  console.log("DEBUG: File content length:", fileContent.length);
  console.log("DEBUG: First 100 chars:", JSON.stringify(fileContent.slice(0, 100)));

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                    EVA AIRDROP                                   ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Token:", TOKEN_ADDRESS);
  console.log("Amount per wallet:", "2 EVA");
  console.log("Total wallets:", addresses.length);
  console.log("Total amount:", (BigInt(addresses.length) * AIRDROP_AMOUNT).toString(), "wei");
  console.log("Total amount:", addresses.length * 2, "EVA");
  console.log("");

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("Sender:", deployer.account.address);
  console.log("");

  // Get token contract
  const token = await viem.getContractAt("EverValueCoin", TOKEN_ADDRESS);

  // Check sender balance
  const balance = await token.read.balanceOf([deployer.account.address]);
  const requiredAmount = AIRDROP_AMOUNT * BigInt(addresses.length);
  
  console.log("Sender balance:", balance.toString(), "wei");
  console.log("Required amount:", requiredAmount.toString(), "wei");
  
  if (balance < requiredAmount) {
    throw new Error(`Insufficient balance. Need ${requiredAmount}, have ${balance}`);
  }
  console.log("✓ Sufficient balance");
  console.log("");

  // Airdrop
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("Starting airdrop...");
  console.log("");

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < addresses.length; i++) {
    const recipient = addresses[i];
    try {
      const tx = await token.write.transfer([recipient, AIRDROP_AMOUNT], { account: deployer.account });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      successCount++;
      console.log(`[${i + 1}/${addresses.length}] ✓ ${recipient}`);
    } catch (e: any) {
      failCount++;
      console.log(`[${i + 1}/${addresses.length}] ✗ ${recipient} - ${e?.message || e}`);
    }
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("AIRDROP COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("Successful:", successCount);
  console.log("Failed:", failCount);
  console.log("Total EVA sent:", successCount * 2, "EVA");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

