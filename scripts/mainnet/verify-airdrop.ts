import { network } from "hardhat";
import { formatEther, parseAbiItem } from "viem";
import "dotenv/config";

const TOKEN = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as `0x${string}`;
const DEPLOYER = "0xe7e486f42fd93148978fe83326be7f3ce8e3a16a" as `0x${string}`;

const EXPECTED_WINNERS = new Set([
  "0xad7caef983d7785c4cc6cc8e1f3c582b8a99c195",
  "0xfbfd829a0acf02ac393ebe06136c17b67bc58a4c",
  "0x927b7232b12da00ffc34a24df7386367742c43d3",
  "0xe9fade45e618e11bd38a73803fb84e46a0cd6c62",
  "0x4f3942d58d1058e39a8fb39efa1f11d5d9d945a3",
  "0x9f157d563fbf376f90fe8b3452507649a2d6a38f",
  "0x03901c58c9252b017b0aeea6e6231b63f072c515",
  "0x9545997091e07b5696477d18a2ee9e7c75a3b3b9",
  "0xd7e4c63331698e8d69f556f8089779f61237d59c",
  "0xc7137d1427cebe3e842b621f862a6d1afaf0afc3",
]);

async function main() {
  const conn = await network.connect();
  const pub = await conn.viem.getPublicClient();

  const block = await pub.getBlockNumber();

  const logs = await pub.getLogs({
    address: TOKEN,
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
    args: { from: DEPLOYER },
    fromBlock: block - 100000n,
    toBlock: block,
  });

  // Filter to only 2 EVA transfers to expected winners
  const airdropLogs = logs.filter((l) => {
    const to = l.args.to!.toLowerCase();
    const val = formatEther(l.args.value!);
    return EXPECTED_WINNERS.has(to) && val === "2";
  });

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  AIRDROP VERIFICATION");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Found", airdropLogs.length, "matching transfers (2 EVA each)");
  console.log("");

  const seen = new Set<string>();
  for (const log of airdropLogs) {
    const to = log.args.to!.toLowerCase();
    seen.add(to);
    console.log(`  ${to}`);
    console.log(`    Amount: ${formatEther(log.args.value!)} EVA`);
    console.log(`    TX:     ${log.transactionHash}`);
    console.log(`    Block:  ${log.blockNumber}`);
    console.log("");
  }

  const missing = [...EXPECTED_WINNERS].filter((w) => !seen.has(w));
  if (missing.length > 0) {
    console.log("  ⚠ MISSING winners:");
    for (const m of missing) console.log("    ", m);
  } else {
    console.log("  ✔ All 10 winners received 2 EVA");
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
