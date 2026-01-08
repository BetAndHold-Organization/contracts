import { network } from "hardhat";
import { parseEther } from "viem";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

async function loadWhitelist(): Promise<Addr[]> {
  const path = new URL("../referrals/whitelist-wallets.json", import.meta.url);
  const raw = await fs.readFile(path, "utf8");
  const data = JSON.parse(raw);
  return (data.whitelist as { wallet: string }[]).map((w) => w.wallet as Addr);
}

async function main() {
  const TOKEN_ADDRESS = (process.env.MAINNET_TOKEN_ADDRESS || "").trim() as Addr;
  if (!TOKEN_ADDRESS) throw new Error("Set MAINNET_TOKEN_ADDRESS in .env");

  const conn = await network.connect();
  const viem = conn.viem;
  const [sender] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const senderAddr = sender.account.address.toLowerCase();
  const skipList = new Set([
    senderAddr,
    "0xc8e31828f454f5d75b44c1c6d78641584b8c898c",
    "0x5922ad6b6eea2990820698fd173a957b4697e2f5",
  ]);
  const all = await loadWhitelist();
  const recipients = all.filter((w) => !skipList.has(w.toLowerCase()));
  const amount = parseEther("2"); // 1 EVA per wallet

  console.log("Sender:", sender.account.address);
  console.log("Token:", TOKEN_ADDRESS);
  console.log("Whitelist total:", all.length);
  console.log("Airdrop recipients (skipping deployer + extra):", recipients.length, "→", amount.toString(), "wei each");

  // Reset whitelist to match JSON (all addresses, not just recipients)
  const handler = await viem.getContractAt("PaymentHandler", (process.env.MAINNET_HANDLER_ADDRESS || "").trim() as Addr);
  await handler.write.setWhitelistEnabled([true], { account: sender.account });
  if (all.length > 0) {
    await handler.write.setWhitelist([all, true], { account: sender.account });
    console.log("Whitelist reset to JSON list (enabled).");
  }

  // Airdrop 2 EVA each
  const token = await viem.getContractAt("EverValueCoin", TOKEN_ADDRESS);
  for (const to of recipients) {
    const hash = await token.write.transfer([to, amount], { account: sender.account });
    console.log("→ tx", hash, "to", to);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});