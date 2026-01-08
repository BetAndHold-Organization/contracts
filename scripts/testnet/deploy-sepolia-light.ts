import "dotenv/config";
import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

type Addr = `0x${string}`;

// ============================================================
// CONFIGURATION
// ============================================================
const NEW_OWNER = "0x5161615d6e8FEC99ADead6deBfF6C5d9B02A892C" as Addr;
const TARGET_WALLET = NEW_OWNER; // house/fallback wallet
const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 0;   // all play (minus referral) goes to payoutTarget
const REFERRAL_BPS = 200;   // 2% to referral system
const VERIFY = true;        // set false to skip verification
const CONSUMER_RANGE_LIMIT = 7n;

// ============================================================
// VERIFICATION HELPERS
// ============================================================
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

// ============================================================
// MAIN DEPLOYMENT
// ============================================================
async function main() {
  // Load VRF env vars
  const VRF_COORDINATOR = (process.env.VRF_COORDINATOR || "").trim() as Addr | undefined;
  const VRF_KEY_HASH = (process.env.VRF_KEY_HASH || "").trim() as Addr | undefined;
  const VRF_SUBSCRIPTION_ID_STR = (process.env.VRF_SUBSCRIPTION_ID || "").trim();

  if (!VRF_COORDINATOR || !VRF_KEY_HASH || !VRF_SUBSCRIPTION_ID_STR) {
    throw new Error("Missing VRF env: set VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUBSCRIPTION_ID");
  }
  const VRF_SUBSCRIPTION_ID = BigInt(VRF_SUBSCRIPTION_ID_STR);

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║         SEPOLIA LIGHT DEPLOYMENT (No Games)                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Deployer:", deployer.account.address);
  console.log("New Owner:", NEW_OWNER);
  console.log("");

  // ────────────────────────────────────────────────────────────
  // 1. Deploy Token
  // ────────────────────────────────────────────────────────────
  console.log("1. Deploying EVA Token...");
  const token = await viem.deployContract("EverValueCoin", [], { client: { wallet: deployer } });
  console.log("   EVA Token:", token.address);

  // ────────────────────────────────────────────────────────────
  // 2. Deploy RandomProvider
  // ────────────────────────────────────────────────────────────
  console.log("\n2. Deploying RandomProvider...");
  const randomProvider = await viem.deployContract("RandomProvider", [VRF_COORDINATOR], { client: { wallet: deployer } });
  console.log("   RandomProvider:", randomProvider.address);
  
  await randomProvider.write.setKeyHash([VRF_KEY_HASH], { account: deployer.account });
  await randomProvider.write.setSubscriptionId([VRF_SUBSCRIPTION_ID], { account: deployer.account });
  console.log("   ✓ KeyHash and SubscriptionId configured");

  // Add RandomProvider as VRF consumer
  const VRF_COORDINATOR_ABI = [
    {
      type: "function",
      name: "addConsumer",
      stateMutability: "nonpayable",
      inputs: [
        { name: "subId", type: "uint256", internalType: "uint256" },
        { name: "consumer", type: "address", internalType: "address" },
      ],
      outputs: [],
    },
  ] as const;

  try {
    const txHash = await deployer.writeContract({
      address: VRF_COORDINATOR,
      abi: VRF_COORDINATOR_ABI,
      functionName: "addConsumer",
      args: [VRF_SUBSCRIPTION_ID, randomProvider.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   ✓ RandomProvider added as VRF consumer");
  } catch (e) {
    console.warn("   ⚠ addConsumer failed (already added or not subscription owner?)");
  }

  // ────────────────────────────────────────────────────────────
  // 3. Deploy PaymentHandler
  // ────────────────────────────────────────────────────────────
  console.log("\n3. Deploying PaymentHandler...");
  const handler = await viem.deployContract("PaymentHandler", [token.address], { client: { wallet: deployer } });
  console.log("   PaymentHandler:", handler.address);

  // ────────────────────────────────────────────────────────────
  // 4. Deploy MultiLevelReferral
  // ────────────────────────────────────────────────────────────
  console.log("\n4. Deploying MultiLevelReferral...");
  const referral = await viem.deployContract(
    "MultiLevelReferral",
    [token.address, TARGET_WALLET],
    { client: { wallet: deployer } }
  );
  console.log("   MultiLevelReferral:", referral.address);

  // Configure referral <-> handler
  await handler.write.setReferralContract([referral.address], { account: deployer.account });
  await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
  await referral.write.setDefaultReceiver([TARGET_WALLET], { account: deployer.account });
  await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });
  console.log("   ✓ Referral configured with levels:", REFERRAL_LADDER.join(", "));

  // ────────────────────────────────────────────────────────────
  // 5. Deploy PaymentOnlyGameAdapter
  // ────────────────────────────────────────────────────────────
  console.log("\n5. Deploying PaymentOnlyGameAdapter...");
  const adapter = await viem.deployContract(
    "PaymentOnlyGameAdapter",
    [token.address, handler.address],
    { client: { wallet: deployer } }
  );
  console.log("   PaymentOnlyGameAdapter:", adapter.address);

  // Register adapter as a game
  await handler.write.registerGame(
    [adapter.address, TARGET_WALLET, TARGET_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await handler.write.setGameStatus([adapter.address, true], { account: deployer.account });
  console.log("   ✓ Adapter registered as game (houseEdge:", HOUSE_EDGE_BPS, ", referral:", REFERRAL_BPS, ")");

  // ────────────────────────────────────────────────────────────
  // 6. Transfer all EVA tokens to new owner
  // ────────────────────────────────────────────────────────────
  console.log("\n6. Transferring all EVA tokens to", NEW_OWNER, "...");
  const deployerBalance = await token.read.balanceOf([deployer.account.address]);
  if (deployerBalance > 0n) {
    const txT = await token.write.transfer([NEW_OWNER, deployerBalance], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: txT });
    const formatted = Number(deployerBalance) / 1e18;
    console.log(`   ✓ Transferred ${formatted.toLocaleString()} EVA to new owner`);
  } else {
    console.log("   ⚠ No EVA tokens to transfer");
  }

  // ────────────────────────────────────────────────────────────
  // 7. Transfer Ownership
  // ────────────────────────────────────────────────────────────
  console.log("\n7. Transferring contract ownership to", NEW_OWNER, "...");

  // PaymentHandler uses Ownable2Step - need to call transferOwnership, then new owner accepts
  const txH = await handler.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: txH });
  console.log("   ✓ PaymentHandler: ownership transfer initiated (pending acceptance)");

  // MultiLevelReferral uses Ownable2Step
  const txR = await referral.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: txR });
  console.log("   ✓ MultiLevelReferral: ownership transfer initiated (pending acceptance)");

  // RandomProvider uses Ownable2Step
  const txRP = await randomProvider.write.transferOwnership([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: txRP });
  console.log("   ✓ RandomProvider: ownership transfer initiated (pending acceptance)");

  // PaymentOnlyGameAdapter uses simple owner pattern
  const txA = await adapter.write.setOwner([NEW_OWNER], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: txA });
  console.log("   ✓ PaymentOnlyGameAdapter: ownership transferred directly");

  // ────────────────────────────────────────────────────────────
  // 8. Save Deployment Info
  // ────────────────────────────────────────────────────────────
  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const path = new URL("sepolia-light.json", deploymentsDir);
  const deployment = {
    token: token.address,
    randomProvider: randomProvider.address,
    handler: handler.address,
    referral: referral.address,
    adapter: adapter.address,
    newOwner: NEW_OWNER,
    deployer: deployer.account.address,
    vrfCoordinator: VRF_COORDINATOR,
    vrfSubscriptionId: VRF_SUBSCRIPTION_ID_STR,
  };
  await fs.writeFile(path, JSON.stringify(deployment, null, 2));
  console.log("\n✓ Deployment info saved to", path.pathname);

  // ────────────────────────────────────────────────────────────
  // 9. Summary
  // ────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                    DEPLOYMENT SUMMARY                         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Contracts deployed:");
  console.log("  Token:            ", token.address);
  console.log("  RandomProvider:   ", randomProvider.address);
  console.log("  PaymentHandler:   ", handler.address);
  console.log("  MultiLevelReferral:", referral.address);
  console.log("  Adapter:          ", adapter.address);
  console.log("");
  const newOwnerBalance = await token.read.balanceOf([NEW_OWNER]);
  const formattedBalance = Number(newOwnerBalance) / 1e18;
  console.log("EVA tokens transferred:", formattedBalance.toLocaleString(), "EVA");
  console.log("");
  console.log("⚠️  IMPORTANT: New owner must call acceptOwnership() on:");
  console.log("    - PaymentHandler");
  console.log("    - MultiLevelReferral");
  console.log("    - RandomProvider");
  console.log("");

  // ────────────────────────────────────────────────────────────
  // 10. Verification
  // ────────────────────────────────────────────────────────────
  if (VERIFY) {
    console.log("Waiting 30s for explorer to index contracts...");
    await new Promise((r) => setTimeout(r, 30_000));

    const networkName = "arbitrumSepolia";
    await verifyWithRetryCli(networkName, token.address, []);
    await verifyWithRetryCli(networkName, randomProvider.address, [VRF_COORDINATOR]);
    await verifyWithRetryCli(networkName, handler.address, [token.address]);
    await verifyWithRetryCli(networkName, referral.address, [token.address, TARGET_WALLET]);
    await verifyWithRetryCli(networkName, adapter.address, [token.address, handler.address]);
  }

  console.log("\n✅ Deployment complete!");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

