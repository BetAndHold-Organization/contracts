import { network } from "hardhat";
import { parseEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const CRASH = "0x9c8b6b866013fd51d52a0d3245c64e1af4d34984" as Addr;

const CRASH_ABI = [
  {
    type: "function", name: "setBetLimits", stateMutability: "nonpayable",
    inputs: [{ name: "minBet", type: "uint256" }, { name: "maxBet", type: "uint256" }],
    outputs: [],
  },
] as const;

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();

  console.log("Updating bet limits to 0.01 - 0.1 EVA...");
  const tx = await deployer.writeContract({
    address: CRASH, abi: CRASH_ABI,
    functionName: "setBetLimits",
    args: [parseEther("0.01"), parseEther("0.1")],
  });
  await pub.waitForTransactionReceipt({ hash: tx });
  console.log("Done. TX:", tx);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
