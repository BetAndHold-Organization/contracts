import "dotenv/config";
import { network } from "hardhat";
import { promises as fs } from "node:fs";

const TARGET_WALLET = "0x3e7ce6737b0cf62359ee3dd11bff8065e490e544" as const;
const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 0;   // all play (minus referral) goes to payoutTarget
const REFERRAL_BPS = 200;   // 2% to referral system; change if desired
const VERIFY = true;        // set false to skip verification

async function verify(addr: `0x${string}`, args: any[]) {
  if (!VERIFY) return;
  // wait a bit for the explorer to index
  await new Promise((r) => setTimeout(r, 30_000));
  try {
    await network.run("verify:verify", { address: addr, constructorArguments: args });
    console.log("✓ Verified", addr);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("Already Verified")) {
      console.log("✓ Already verified", addr);
    } else {
      console.warn("⚠ verify failed", addr, msg);
    }
  }
}

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();

  console.log("Deployer:", deployer.account.address);
  const publicClient = await viem.getPublicClient();

  // Deploy EVA
  const token = await viem.deployContract("EverValueCoin", [], { client: { wallet: deployer } });
  console.log("EVA token:", token.address);

  // Deploy PaymentHandler
  const handler = await viem.deployContract("PaymentHandler", [token.address], { client: { wallet: deployer } });
  console.log("PaymentHandler:", handler.address);

  // Deploy Referral
  const referral = await viem.deployContract(
    "MultiLevelReferral",
    [token.address, TARGET_WALLET],
    { client: { wallet: deployer } }
  );
  console.log("MultiLevelReferral:", referral.address);

  // Configure referral <-> handler
  await handler.write.setReferralContract([referral.address], { account: deployer.account });
  await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
  await referral.write.setDefaultReceiver([TARGET_WALLET], { account: deployer.account });
  await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: deployer.account });

  // Deploy Adapter
  const adapter = await viem.deployContract(
    "PaymentOnlyGameAdapter",
    [token.address, handler.address],
    { client: { wallet: deployer } }
  );
  console.log("PaymentOnlyGameAdapter:", adapter.address);

  // Register adapter as game: payoutTarget = TARGET_WALLET, feeRecipient = TARGET_WALLET
  await handler.write.registerGame(
    [adapter.address, TARGET_WALLET, TARGET_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await handler.write.setGameStatus([adapter.address, true], { account: deployer.account });

  // Log summary
  console.log("\nConfiguration Summary:");
  console.log("  Token:", token.address);
  console.log("  PaymentHandler:", handler.address);
  console.log("  MultiLevelReferral:", referral.address);
  console.log("  Adapter (game):", adapter.address);
  console.log("  Payout target:", TARGET_WALLET);
  console.log("  House edge bps:", HOUSE_EDGE_BPS);
  console.log("  Referral bps:", REFERRAL_BPS);
  console.log("  Referral ladder:", REFERRAL_LADDER.join(","));

  // Persist
  const deploymentsDir = new URL("./deployments/", import.meta.url);
  await fs.mkdir(deploymentsDir, { recursive: true });
  const path = new URL("adapter-sepolia.json", deploymentsDir);
  await fs.writeFile(path, JSON.stringify({
    token: token.address,
    handler: handler.address,
    referral: referral.address,
    adapter: adapter.address,
    payoutTarget: TARGET_WALLET,
  }, null, 2));
  console.log("Deployment info saved to", path.pathname);

  // Verify
  await verify(token.address, []);
  await verify(handler.address, [token.address]);
  await verify(referral.address, [token.address, TARGET_WALLET]);
  await verify(adapter.address, [token.address, handler.address]);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});






