import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

const NEW_OWNER = "0xBCA4c208a9884059E176dcBa975Fc2C4d9AA3f3D" as Addr;

async function main() {
  const deploymentRaw = await fs.readFile("scripts/testnet/deployments/arb-sepolia-v4.json", "utf8");
  const deployment = JSON.parse(deploymentRaw);

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║     TRANSFER OWNERSHIP & TOKENS - ARBITRUM SEPOLIA V4            ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Current owner:", deployer.account.address);
  console.log("New owner:    ", NEW_OWNER);
  console.log("");

  let tx: Addr;

  // ─────────────────────────────────────────────────────────────────────────
  // 1. TRANSFER ALL TRT TOKENS
  // ─────────────────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("1. Transferring TRT tokens...");

  const token = await viem.getContractAt("EverValueCoin", deployment.token);
  const balance = await token.read.balanceOf([deployer.account.address]);
  
  console.log("   Deployer balance:", (Number(balance) / 1e18).toFixed(2), "TRT");
  
  if (balance > 0n) {
    tx = await token.write.transfer([NEW_OWNER, balance], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("   ✓ Transferred", (Number(balance) / 1e18).toFixed(2), "TRT to new owner");
  } else {
    console.log("   ⚠ No tokens to transfer");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. TRANSFER RANDOM PROVIDER V2 OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("2. Transferring RandomProviderV2 ownership...");

  const randomProvider = await viem.getContractAt("RandomProviderV2", deployment.randomProvider);
  tx = await randomProvider.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 3. TRANSFER PAYMENT HANDLER OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("3. Transferring PaymentHandler ownership...");

  const handler = await viem.getContractAt("PaymentHandler", deployment.handler);
  tx = await handler.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 4. TRANSFER REFERRAL OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("4. Transferring MultiLevelReferral ownership...");

  const referral = await viem.getContractAt("MultiLevelReferral", deployment.referral);
  tx = await referral.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 5. TRANSFER JACKPOT OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("5. Transferring ProgressiveJackpotV2 ownership...");

  const jackpot = await viem.getContractAt("ProgressiveJackpotV2", deployment.jackpot);
  tx = await jackpot.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 6. TRANSFER ROULETTE OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("6. Transferring SingleRandomRouletteV2 ownership...");

  const roulette = await viem.getContractAt("SingleRandomRouletteV2", deployment.roulette);
  tx = await roulette.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 7. TRANSFER ADAPTER OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("7. Transferring PaymentOnlyGameAdapter ownership...");

  const adapter = await viem.getContractAt("PaymentOnlyGameAdapter", deployment.adapter);
  tx = await adapter.write.setOwner([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transferred (single-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                    TRANSFER COMPLETE                              ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("New owner must call acceptOwnership() on these contracts:");
  console.log("   - RandomProviderV2:    ", deployment.randomProvider);
  console.log("   - PaymentHandler:      ", deployment.handler);
  console.log("   - MultiLevelReferral:  ", deployment.referral);
  console.log("   - ProgressiveJackpotV2:", deployment.jackpot);
  console.log("   - SingleRandomRouletteV2:", deployment.roulette);
  console.log("");
  console.log("   PaymentOnlyGameAdapter: already transferred (single-step)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
