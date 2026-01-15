import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseAbiItem, formatEther, decodeEventLog } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

/**
 * Analyze actual VRF costs from recent transactions
 * This script fetches RandomWordsFulfilled events and analyzes gas usage patterns
 */
async function main() {
  console.log("🔬 VRF Cost Analysis\n");
  console.log("=".repeat(70));

  const conn = await network.connect();
  const viem = conn.viem;
  const client = await viem.getPublicClient();

  // Load deployment
  const deploymentPath = "scripts/mainnet/deployments/arb-mainnet-v2.json";
  const deploymentRaw = await fs.readFile(deploymentPath, "utf-8");
  const deployment = JSON.parse(deploymentRaw);

  const randomProviderAddr = deployment.randomProvider as Addr;
  const rouletteAddr = deployment.roulette as Addr;
  const jackpotAddr = deployment.jackpot as Addr;

  console.log(`\n📍 Addresses:`);
  console.log(`   RandomProvider: ${randomProviderAddr}`);
  console.log(`   Roulette: ${rouletteAddr}`);
  console.log(`   Jackpot: ${jackpotAddr}`);

  // Event signatures
  const RandomWordsFulfilledEvent = parseAbiItem(
    "event RandomWordsFulfilled(uint256 indexed requestId, uint256 randomWord, uint256[] derivedValues)"
  );
  
  const RequestCompletedEvent = parseAbiItem(
    "event RequestCompleted(uint256 indexed requestId, uint8 status)"
  );

  // Get current block
  const currentBlock = await client.getBlockNumber();
  console.log(`\n📦 Current Block: ${currentBlock}`);

  // Look back ~7 days (~200k blocks on Arbitrum at ~0.3s/block)
  const blocksPerDay = Math.floor((24 * 60 * 60) / 0.3);
  const lookbackBlocks = BigInt(blocksPerDay * 7);
  const fromBlock = currentBlock - lookbackBlocks;

  console.log(`   Looking back ${Number(lookbackBlocks).toLocaleString()} blocks (~7 days)`);
  console.log(`   From block: ${fromBlock}`);

  // Fetch RandomWordsFulfilled events
  console.log(`\n🔄 Fetching VRF fulfillment events...`);
  
  let fulfillmentLogs;
  try {
    fulfillmentLogs = await client.getLogs({
      address: randomProviderAddr,
      event: RandomWordsFulfilledEvent,
      fromBlock: fromBlock,
      toBlock: currentBlock,
    });
  } catch (e: any) {
    // If range is too large, try smaller chunks
    console.log(`   Large range, fetching in chunks...`);
    fulfillmentLogs = [];
    const chunkSize = BigInt(50000);
    for (let start = fromBlock; start < currentBlock; start += chunkSize) {
      const end = start + chunkSize > currentBlock ? currentBlock : start + chunkSize;
      try {
        const chunk = await client.getLogs({
          address: randomProviderAddr,
          event: RandomWordsFulfilledEvent,
          fromBlock: start,
          toBlock: end,
        });
        fulfillmentLogs.push(...chunk);
        process.stdout.write(`\r   Fetched ${fulfillmentLogs.length} events...`);
      } catch (e2) {
        console.log(`   Warning: Failed to fetch block range ${start}-${end}`);
      }
    }
    console.log("");
  }

  console.log(`\n📊 Found ${fulfillmentLogs.length} VRF fulfillment events`);

  if (fulfillmentLogs.length === 0) {
    console.log("\n⚠️  No fulfillment events found in the lookback period");
    return;
  }

  // Analyze each transaction
  console.log(`\n📈 Analyzing transaction details...\n`);

  interface TxAnalysis {
    requestId: bigint;
    txHash: string;
    blockNumber: bigint;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    gasCostETH: bigint;
    rangeCount: number;
    timestamp: bigint;
  }

  const analyses: TxAnalysis[] = [];
  const sampleSize = Math.min(fulfillmentLogs.length, 50); // Analyze last 50

  console.log(`   Analyzing ${sampleSize} most recent transactions...`);

  // Sort by block number descending and take recent ones
  const recentLogs = [...fulfillmentLogs]
    .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber))
    .slice(0, sampleSize);

  for (let i = 0; i < recentLogs.length; i++) {
    const log = recentLogs[i];
    process.stdout.write(`\r   Processing ${i + 1}/${recentLogs.length}...`);

    try {
      const receipt = await client.getTransactionReceipt({
        hash: log.transactionHash,
      });

      const block = await client.getBlock({
        blockNumber: log.blockNumber,
      });

      // Decode the event to get derivedValues length
      const derivedValues = log.args.derivedValues || [];

      analyses.push({
        requestId: log.args.requestId!,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        gasCostETH: receipt.gasUsed * receipt.effectiveGasPrice,
        rangeCount: derivedValues.length,
        timestamp: block.timestamp,
      });
    } catch (e) {
      // Skip failed fetches
    }
  }

  console.log(`\n\n${"=".repeat(70)}`);
  console.log(`📋 ANALYSIS RESULTS`);
  console.log(`${"=".repeat(70)}`);

  if (analyses.length === 0) {
    console.log("\n⚠️  Could not analyze any transactions");
    return;
  }

  // Calculate statistics
  const gasUsedValues = analyses.map(a => Number(a.gasUsed));
  const gasCostValues = analyses.map(a => Number(a.gasCostETH));
  const gasPriceValues = analyses.map(a => Number(a.effectiveGasPrice));

  const avgGasUsed = gasUsedValues.reduce((a, b) => a + b, 0) / gasUsedValues.length;
  const minGasUsed = Math.min(...gasUsedValues);
  const maxGasUsed = Math.max(...gasUsedValues);

  const avgGasPrice = gasPriceValues.reduce((a, b) => a + b, 0) / gasPriceValues.length;
  const minGasPrice = Math.min(...gasPriceValues);
  const maxGasPrice = Math.max(...gasPriceValues);

  const avgGasCost = gasCostValues.reduce((a, b) => a + b, 0) / gasCostValues.length;
  const minGasCost = Math.min(...gasCostValues);
  const maxGasCost = Math.max(...gasCostValues);

  console.log(`\n⛽ Gas Used (callback execution):`);
  console.log(`   Average: ${avgGasUsed.toLocaleString()} gas`);
  console.log(`   Min:     ${minGasUsed.toLocaleString()} gas`);
  console.log(`   Max:     ${maxGasUsed.toLocaleString()} gas`);
  console.log(`   Configured limit: 2,285,000 gas`);
  console.log(`   📉 Actual usage is ${((avgGasUsed / 2285000) * 100).toFixed(1)}% of limit`);

  console.log(`\n💰 Gas Price:`);
  console.log(`   Average: ${(avgGasPrice / 1e9).toFixed(4)} gwei`);
  console.log(`   Min:     ${(minGasPrice / 1e9).toFixed(4)} gwei`);
  console.log(`   Max:     ${(maxGasPrice / 1e9).toFixed(4)} gwei`);

  console.log(`\n💸 Gas Cost (ETH):`);
  console.log(`   Average: ${formatEther(BigInt(Math.floor(avgGasCost)))} ETH`);
  console.log(`   Min:     ${formatEther(BigInt(Math.floor(minGasCost)))} ETH`);
  console.log(`   Max:     ${formatEther(BigInt(Math.floor(maxGasCost)))} ETH`);

  // Group by range count
  const byRangeCount = new Map<number, TxAnalysis[]>();
  for (const a of analyses) {
    const existing = byRangeCount.get(a.rangeCount) || [];
    existing.push(a);
    byRangeCount.set(a.rangeCount, existing);
  }

  console.log(`\n📊 Breakdown by Range Count:`);
  for (const [count, txs] of byRangeCount.entries()) {
    const avgGas = txs.reduce((sum, t) => sum + Number(t.gasUsed), 0) / txs.length;
    console.log(`   ${count} ranges: ${txs.length} txs, avg ${avgGas.toLocaleString()} gas`);
  }

  // Time-based analysis
  console.log(`\n📅 Time-based Analysis:`);
  
  // Sort by timestamp
  const sortedByTime = [...analyses].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  
  if (sortedByTime.length >= 2) {
    const oldestTime = new Date(Number(sortedByTime[0].timestamp) * 1000);
    const newestTime = new Date(Number(sortedByTime[sortedByTime.length - 1].timestamp) * 1000);
    
    console.log(`   Oldest tx: ${oldestTime.toISOString()}`);
    console.log(`   Newest tx: ${newestTime.toISOString()}`);

    // Compare first half vs second half
    const halfPoint = Math.floor(sortedByTime.length / 2);
    const firstHalf = sortedByTime.slice(0, halfPoint);
    const secondHalf = sortedByTime.slice(halfPoint);

    const avgGasFirst = firstHalf.reduce((sum, t) => sum + Number(t.gasUsed), 0) / firstHalf.length;
    const avgGasSecond = secondHalf.reduce((sum, t) => sum + Number(t.gasUsed), 0) / secondHalf.length;

    const avgPriceFirst = firstHalf.reduce((sum, t) => sum + Number(t.effectiveGasPrice), 0) / firstHalf.length;
    const avgPriceSecond = secondHalf.reduce((sum, t) => sum + Number(t.effectiveGasPrice), 0) / secondHalf.length;

    console.log(`\n   First half (older):`);
    console.log(`     Avg gas used: ${avgGasFirst.toLocaleString()}`);
    console.log(`     Avg gas price: ${(avgPriceFirst / 1e9).toFixed(4)} gwei`);

    console.log(`\n   Second half (newer):`);
    console.log(`     Avg gas used: ${avgGasSecond.toLocaleString()}`);
    console.log(`     Avg gas price: ${(avgPriceSecond / 1e9).toFixed(4)} gwei`);

    const gasChange = ((avgGasSecond - avgGasFirst) / avgGasFirst) * 100;
    const priceChange = ((avgPriceSecond - avgPriceFirst) / avgPriceFirst) * 100;

    console.log(`\n   📈 Change over time:`);
    console.log(`     Gas used: ${gasChange > 0 ? "+" : ""}${gasChange.toFixed(1)}%`);
    console.log(`     Gas price: ${priceChange > 0 ? "+" : ""}${priceChange.toFixed(1)}%`);
  }

  // Show sample transactions
  console.log(`\n📝 Sample Recent Transactions:`);
  console.log(`${"─".repeat(70)}`);
  
  const recentSample = sortedByTime.slice(-10);
  for (const tx of recentSample) {
    const date = new Date(Number(tx.timestamp) * 1000);
    console.log(`   ${date.toISOString().slice(0, 19)}`);
    console.log(`     Gas: ${Number(tx.gasUsed).toLocaleString()} @ ${(Number(tx.effectiveGasPrice) / 1e9).toFixed(4)} gwei`);
    console.log(`     Cost: ${formatEther(tx.gasCostETH)} ETH | Ranges: ${tx.rangeCount}`);
    console.log(`     Tx: ${tx.txHash}`);
    console.log("");
  }

  // Key insights
  console.log(`${"=".repeat(70)}`);
  console.log(`🎯 KEY INSIGHTS`);
  console.log(`${"=".repeat(70)}`);
  
  console.log(`\n1. Actual callback gas (~${avgGasUsed.toLocaleString()}) is ${((avgGasUsed / 2285000) * 100).toFixed(0)}% of configured limit (2,285,000)`);
  console.log(`   → callbackGasLimitBase could be reduced from 2.5M to ~${Math.ceil(maxGasUsed * 1.3 / 100000) * 100000}`);

  if (gasUsedValues.some(g => g > 500000)) {
    console.log(`\n2. Some callbacks use >500k gas - investigate those specifically`);
  }

  console.log(`\n3. VRF callback gas is relatively stable - cost increases likely from:`);
  console.log(`   - L1 data posting costs (Ethereum mainnet gas)`);
  console.log(`   - Chainlink premium adjustments`);
  console.log(`   - LINK/ETH price changes`);

  console.log(`\n📝 To see LINK costs, check your Chainlink VRF subscription dashboard:`);
  console.log(`   https://vrf.chain.link/arbitrum`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

