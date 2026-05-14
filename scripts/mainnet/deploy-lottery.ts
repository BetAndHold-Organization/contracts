import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// ═══════════════════════════════════════════════════════════════════════════
// TICKET LOTTERY MAINNET DEPLOYMENT
// Deploys TicketLottery directly connected to Chainlink VRF (no RandomProviderV2).
// Registers the contract as a consumer on the VRF subscription.
// Does NOT fund the contract — it holds no tokens, only selects winners.
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ─── Validate environment ─────────────────────────────────────────────
  const VRF_COORDINATOR = (process.env.MAINNET_VRF_COORDINATOR || "").trim() as Addr;
  const VRF_KEY_HASH    = (process.env.MAINNET_VRF_KEY_HASH || "").trim() as `0x${string}`;
  const VRF_SUB_STR     = (process.env.MAINNET_VRF_SUBSCRIPTION_ID || "").trim();

  const missing: string[] = [];
  if (!VRF_COORDINATOR) missing.push("MAINNET_VRF_COORDINATOR");
  if (!VRF_KEY_HASH)    missing.push("MAINNET_VRF_KEY_HASH");
  if (!VRF_SUB_STR)     missing.push("MAINNET_VRF_SUBSCRIPTION_ID");

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const VRF_SUBSCRIPTION_ID = BigInt(VRF_SUB_STR);

  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const networkName = "arbitrum";

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  TICKET LOTTERY DEPLOYMENT — ARBITRUM MAINNET");
  console.log("  Direct Chainlink VRF (VRFConsumerBaseV2Plus)");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Network:        ", networkName);
  console.log("Deployer:       ", deployer.account.address);
  console.log("VRF Coordinator:", VRF_COORDINATOR);
  console.log("VRF Key Hash:   ", VRF_KEY_HASH);
  console.log("VRF Sub ID:     ", VRF_SUBSCRIPTION_ID.toString().slice(0, 20) + "...");
  console.log("");

  const deployerETH = await publicClient.getBalance({ address: deployer.account.address });
  console.log("Deployer ETH:   ", formatEther(deployerETH), "ETH");
  console.log("\n─── Starting deployment... ───\n");

  // ═════════════════════════════════════════════════════════════════════════
  // 1. DEPLOY TICKET LOTTERY
  // ═════════════════════════════════════════════════════════════════════════
  console.log("1. Deploying TicketLottery...");
  const lottery = await viem.deployContract("TicketLottery", [
    VRF_COORDINATOR,
    VRF_KEY_HASH,
    VRF_SUBSCRIPTION_ID,
  ]);
  console.log("   TicketLottery deployed:", lottery.address);

  // ═════════════════════════════════════════════════════════════════════════
  // 2. REGISTER AS VRF CONSUMER
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n2. Registering TicketLottery as VRF consumer...");

  const VRF_COORDINATOR_ABI = [{
    type: "function", name: "addConsumer", stateMutability: "nonpayable",
    inputs: [{ name: "subId", type: "uint256" }, { name: "consumer", type: "address" }],
    outputs: [],
  }] as const;

  try {
    const addTx = await deployer.writeContract({
      address: VRF_COORDINATOR,
      abi: VRF_COORDINATOR_ABI,
      functionName: "addConsumer",
      args: [VRF_SUBSCRIPTION_ID, lottery.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: addTx });
    console.log("   Registered as VRF consumer on subscription", VRF_SUBSCRIPTION_ID.toString().slice(0, 20) + "...");
  } catch (e: any) {
    console.warn("   !! VRF consumer registration failed. Add manually via Chainlink dashboard.");
    console.warn("   ", e?.shortMessage || e?.message || e);
    console.warn("   Subscription ID:", VRF_SUBSCRIPTION_ID.toString());
    console.warn("   Consumer address:", lottery.address);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. SAVE DEPLOYMENT
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n3. Saving deployment record...");

  const deployment = {
    contract: "TicketLottery",
    deployedAt: new Date().toISOString(),
    network: networkName,
    lottery: lottery.address,
    vrf: {
      coordinator: VRF_COORDINATOR,
      keyHash: VRF_KEY_HASH,
      subscriptionId: VRF_SUBSCRIPTION_ID.toString(),
      requestConfirmations: 3,
      callbackGasLimit: 2_500_000,
    },
    deployer: deployer.account.address,
  };

  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const deploymentPath = new URL("lottery-mainnet.json", deploymentsDir);
  await fs.writeFile(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("   Saved to", deploymentPath.pathname);

  // ═════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  TICKET LOTTERY DEPLOYMENT COMPLETE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  TicketLottery:    ", lottery.address);
  console.log("  VRF Coordinator: ", VRF_COORDINATOR);
  console.log("  VRF Key Hash:    ", VRF_KEY_HASH);
  console.log("  VRF Sub ID:      ", VRF_SUBSCRIPTION_ID.toString().slice(0, 20) + "...");
  console.log("  Gas Limit:        2,500,000");
  console.log("  Confirmations:    3");
  console.log("");
  console.log("  Deployment saved: lottery-mainnet.json");
  console.log("");
  console.log("  NEXT STEPS:");
  console.log("    1. Verify on Arbiscan:");
  console.log("       npx hardhat verify --network arbitrum", lottery.address, VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUBSCRIPTION_ID.toString());
  console.log("    2. If VRF consumer registration failed above, add manually:");
  console.log("       https://vrf.chain.link → your subscription → Add consumer →", lottery.address);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
