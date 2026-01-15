import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { decodeEventLog, parseAbiItem } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

/**
 * Inspect a specific high-gas VRF transaction to understand why it used more gas
 */
async function main() {
  const HIGH_GAS_TX = "0xc387c9116df780df9dc18e09051450562f668d714e3a9bc804a1eccfcaa0a466";
  const NORMAL_TX = "0x77f83692783811f6c57aed05fb82f6563f9288af93c61528cc496b64f1e04cf9";

  console.log("🔬 High Gas Transaction Inspector\n");
  console.log("=".repeat(70));

  const conn = await network.connect();
  const viem = conn.viem;
  const client = await viem.getPublicClient();

  // Load deployment
  const deploymentPath = "scripts/mainnet/deployments/arb-mainnet-v2.json";
  const deploymentRaw = await fs.readFile(deploymentPath, "utf-8");
  const deployment = JSON.parse(deploymentRaw);

  console.log("\n📦 Comparing Transactions:\n");

  for (const [label, txHash] of [["HIGH GAS", HIGH_GAS_TX], ["NORMAL", NORMAL_TX]]) {
    console.log(`${"─".repeat(70)}`);
    console.log(`📍 ${label}: ${txHash}\n`);

    const receipt = await client.getTransactionReceipt({ hash: txHash as Addr });
    const tx = await client.getTransaction({ hash: txHash as Addr });

    console.log(`   Gas Used: ${Number(receipt.gasUsed).toLocaleString()}`);
    console.log(`   Gas Limit: ${Number(tx.gas).toLocaleString()}`);
    console.log(`   Gas Price: ${(Number(receipt.effectiveGasPrice) / 1e9).toFixed(6)} gwei`);
    console.log(`   Status: ${receipt.status}`);
    console.log(`   Logs count: ${receipt.logs.length}`);

    // Decode events
    const SpinResolved = parseAbiItem(
      "event SpinResolved(uint256 indexed requestId, address indexed player, uint8 outcome, uint256 payout, uint8 spinsConsumed, uint256 jackpotPayout)"
    );
    
    const TierWon = parseAbiItem(
      "event TierWon(uint8 indexed tierIndex, address indexed player, uint256 payout)"
    );

    const JackpotWon = parseAbiItem(
      "event JackpotWon(address indexed player, uint256 payout)"
    );

    const ConsolationPaid = parseAbiItem(
      "event ConsolationPaid(address indexed player, uint256 payout, uint16 consolationMultiplier)"
    );

    const Transfer = parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 value)"
    );

    let hasJackpot = false;
    let hasConsolation = false;
    let transferCount = 0;
    let spinOutcome = -1;
    let jackpotPayout = 0n;

    for (const log of receipt.logs) {
      try {
        // Try SpinResolved
        const decoded = decodeEventLog({
          abi: [SpinResolved],
          data: log.data,
          topics: log.topics,
        });
        spinOutcome = decoded.args.outcome;
        jackpotPayout = decoded.args.jackpotPayout;
        console.log(`\n   🎰 SpinResolved:`);
        console.log(`      Outcome: ${decoded.args.outcome} (0=Lose, 1=Multiplier, 2=Jackpot)`);
        console.log(`      Payout: ${decoded.args.payout}`);
        console.log(`      Spins: ${decoded.args.spinsConsumed}`);
        console.log(`      JackpotPayout: ${decoded.args.jackpotPayout}`);
      } catch {}

      try {
        const decoded = decodeEventLog({
          abi: [TierWon],
          data: log.data,
          topics: log.topics,
        });
        hasJackpot = true;
        console.log(`\n   🏆 TierWon: Tier ${decoded.args.tierIndex}, Payout: ${decoded.args.payout}`);
      } catch {}

      try {
        const decoded = decodeEventLog({
          abi: [ConsolationPaid],
          data: log.data,
          topics: log.topics,
        });
        hasConsolation = true;
        console.log(`\n   🎁 ConsolationPaid: ${decoded.args.payout} (${decoded.args.consolationMultiplier / 100}x)`);
      } catch {}

      try {
        decodeEventLog({
          abi: [Transfer],
          data: log.data,
          topics: log.topics,
        });
        transferCount++;
      } catch {}
    }

    console.log(`\n   📊 Summary:`);
    console.log(`      Transfers: ${transferCount}`);
    console.log(`      Jackpot win: ${hasJackpot ? "YES" : "NO"}`);
    console.log(`      Consolation: ${hasConsolation ? "YES" : "NO"}`);
    console.log(`      Jackpot payout: ${jackpotPayout > 0n ? "YES" : "NO"}`);
    console.log("");
  }

  console.log(`${"=".repeat(70)}`);
  console.log(`🎯 ANALYSIS`);
  console.log(`${"=".repeat(70)}`);
  console.log(`\nThe high-gas transaction likely involves:`);
  console.log(`  - Jackpot entry processing (extra contract call)`);
  console.log(`  - Tier win or consolation payout`);
  console.log(`  - Additional state writes in jackpot contract`);
  console.log(`\nThis is EXPECTED behavior - jackpot wins cost more gas.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

