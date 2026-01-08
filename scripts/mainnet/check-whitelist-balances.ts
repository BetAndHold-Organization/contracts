import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { formatEther } from "viem";
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
  const publicClient = await viem.getPublicClient();

  const token = await viem.getContractAt("EverValueCoin", TOKEN_ADDRESS);
  const whitelist = await loadWhitelist();

  console.log("Token:", TOKEN_ADDRESS);
  console.log("Whitelist count:", whitelist.length);

  for (const w of whitelist) {
    const bal = await token.read.balanceOf([w]);
    console.log(`${w} : ${formatEther(bal)} EVA`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});