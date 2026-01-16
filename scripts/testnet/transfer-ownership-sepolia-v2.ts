import { network } from "hardhat";
import { parseEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// New owner address
const NEW_OWNER = "0xBCA4c208a9884059E176dcBa975Fc2C4d9AA3f3D" as Addr;

// Deployed contract addresses from arb-sepolia-v2 deployment
const CONTRACTS = {
  token: "0x2c5d1461b63a88351210a5be53dc440b49d966fb" as Addr,
  randomProvider: "0x3960b21c6320013f520a96ae2e3cf2c70896d831" as Addr,
  handler: "0xc3914fc87253f9e3ca6935c735f3f4460da121a7" as Addr,
  referral: "0xbb557a242b87fe979899ac129b52447501ee9ff9" as Addr,
  jackpot: "0x7511382be7b3892429288cda6106c9abd28d7e3b" as Addr,
  roulette: "0xa08f7293e50d8898353ec18c5c6ed51a1e2efe97" as Addr,
  adapter: "0xead6204fc46e230fd12c99e126094e366acee133" as Addr,
};

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║     TRANSFER OWNERSHIP & TOKENS - ARBITRUM SEPOLIA V2            ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Current owner:", deployer.account.address);
  console.log("New owner:", NEW_OWNER);
  console.log("");

  let tx: Addr;

  // ─────────────────────────────────────────────────────────────────────────
  // 1. TRANSFER ALL EVA TOKENS
  // ─────────────────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("1. Transferring EVA tokens...");

  const token = await viem.getContractAt("EverValueCoin", CONTRACTS.token);
  const balance = await token.read.balanceOf([deployer.account.address]);
  
  console.log("   Deployer balance:", balance.toString(), "wei");
  
  if (balance > 0n) {
    tx = await token.write.transfer([NEW_OWNER, balance], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("   ✓ Transferred", balance.toString(), "EVA to new owner");
  } else {
    console.log("   ⚠ No tokens to transfer");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. TRANSFER RANDOM PROVIDER V2 OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("2. Transferring RandomProviderV2 ownership...");

  const randomProvider = await viem.getContractAt("RandomProviderV2", CONTRACTS.randomProvider);
  tx = await randomProvider.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 3. TRANSFER PAYMENT HANDLER OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("3. Transferring PaymentHandler ownership...");

  const handler = await viem.getContractAt("PaymentHandler", CONTRACTS.handler);
  tx = await handler.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 4. TRANSFER REFERRAL OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("4. Transferring MultiLevelReferral ownership...");

  const referral = await viem.getContractAt("MultiLevelReferral", CONTRACTS.referral);
  tx = await referral.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 5. TRANSFER JACKPOT OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("5. Transferring ProgressiveJackpotV2 ownership...");

  const jackpot = await viem.getContractAt("ProgressiveJackpotV2", CONTRACTS.jackpot);
  tx = await jackpot.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 6. TRANSFER ROULETTE OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("6. Transferring SingleRandomRouletteV2 ownership...");

  const roulette = await viem.getContractAt("SingleRandomRouletteV2", CONTRACTS.roulette);
  tx = await roulette.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   ✓ Ownership transfer initiated (2-step)");

  // ─────────────────────────────────────────────────────────────────────────
  // 7. TRANSFER ADAPTER OWNERSHIP
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("7. Transferring PaymentOnlyGameAdapter ownership...");

  const adapter = await viem.getContractAt("PaymentOnlyGameAdapter", CONTRACTS.adapter);
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
  console.log("⚠️  IMPORTANT: For contracts using Ownable2Step, the new owner must");
  console.log("   call acceptOwnership() to complete the transfer:");
  console.log("");
  console.log("   - RandomProviderV2.acceptOwnership()");
  console.log("   - PaymentHandler.acceptOwnership()");
  console.log("   - MultiLevelReferral.acceptOwnership()");
  console.log("   - ProgressiveJackpotV2.acceptOwnership()");
  console.log("   - SingleRandomRouletteV2.acceptOwnership()");
  console.log("");
  console.log("   PaymentOnlyGameAdapter uses single-step transfer (already complete)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

