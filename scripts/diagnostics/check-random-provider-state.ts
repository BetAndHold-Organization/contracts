import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

// ABI fragments for reading RandomProvider
const RANDOM_PROVIDER_ABI = [
  { name: "totalRequests", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "getPendingRequestCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "requestConfirmations", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { name: "callbackGasLimitBase", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { name: "extraGasPerWord", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { name: "keyHash", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { name: "allowedConsumers", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { name: "maxRangesAllowed", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getAllRequestIds", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
] as const;

/**
 * Diagnostic script to check RandomProvider state and identify gas growth causes
 */
async function main() {
  console.log("🔍 RandomProvider Gas Diagnostic\n");
  console.log("=".repeat(60));

  const conn = await network.connect();
  const viem = conn.viem;
  const client = await viem.getPublicClient();

  // Load deployment
  const deploymentPath = "scripts/mainnet/deployments/arb-mainnet-v2.json";
  const deploymentRaw = await fs.readFile(deploymentPath, "utf-8");
  const deployment = JSON.parse(deploymentRaw);

  const randomProviderAddr = deployment.randomProvider as Addr;

  console.log(`\n📍 RandomProvider: ${randomProviderAddr}`);

  // Helper for reading contract
  async function read<T>(name: string, args: any[] = []): Promise<T> {
    return client.readContract({
      address: randomProviderAddr,
      abi: RANDOM_PROVIDER_ABI,
      functionName: name,
      args,
    }) as Promise<T>;
  }

  // 1. Check totalRequests
  const totalRequests = await read<bigint>("totalRequests");
  console.log(`\n📊 Total Requests Ever: ${totalRequests.toString()}`);

  // 2. Check pending requests count
  const pendingCount = await read<bigint>("getPendingRequestCount");
  console.log(`⏳ Pending Requests: ${pendingCount.toString()}`);

  // 3. Check config
  const requestConfirmations = await read<number>("requestConfirmations");
  const callbackGasLimitBase = await read<number>("callbackGasLimitBase");
  const extraGasPerWord = await read<number>("extraGasPerWord");
  const keyHash = await read<string>("keyHash");

  console.log(`\n⚙️  Configuration:`);
  console.log(`   - Request Confirmations: ${requestConfirmations}`);
  console.log(`   - Callback Gas Limit Base: ${callbackGasLimitBase.toLocaleString()}`);
  console.log(`   - Extra Gas Per Word: ${extraGasPerWord.toLocaleString()}`);
  console.log(`   - Key Hash: ${keyHash}`);

  // 4. Calculate gas used in _removeFromPending for current pending count
  // Each iteration = 1 SLOAD (2100 gas cold) + comparison
  const pendingSearchGas = Number(pendingCount) * 2100;
  console.log(`\n🔥 Gas Impact Analysis:`);
  console.log(`   - _removeFromPending worst case: ~${pendingSearchGas.toLocaleString()} gas`);

  // 5. Check allRequestIds length (this never gets cleaned!)
  try {
    const allRequestIds = await read<bigint[]>("getAllRequestIds");
    console.log(`\n📚 Historical Data (NEVER CLEANED):`);
    console.log(`   - allRequestIds.length: ${allRequestIds.length}`);
    
    // Estimate storage used
    const storageUsed = allRequestIds.length * 32; // 32 bytes per uint256
    console.log(`   - Storage used: ${(storageUsed / 1024).toFixed(2)} KB`);
  } catch (e) {
    console.log(`\n⚠️  Could not fetch allRequestIds (might be too large or gas-intensive)`);
  }

  // 6. Check consumer status for known consumers
  const rouletteAddr = deployment.roulette as Addr;
  const jackpotAddr = deployment.jackpot as Addr;
  
  const rouletteAllowed = await read<boolean>("allowedConsumers", [rouletteAddr]);
  const jackpotAllowed = await read<boolean>("allowedConsumers", [jackpotAddr]);
  const rouletteMaxRanges = await read<bigint>("maxRangesAllowed", [rouletteAddr]);
  const jackpotMaxRanges = await read<bigint>("maxRangesAllowed", [jackpotAddr]);

  console.log(`\n👥 Registered Consumers:`);
  console.log(`   - Roulette: ${rouletteAllowed ? "✅" : "❌"} (maxRanges: ${rouletteMaxRanges})`);
  console.log(`   - Jackpot: ${jackpotAllowed ? "✅" : "❌"} (maxRanges: ${jackpotMaxRanges})`);

  // 7. Calculate actual gas needed vs configured
  const ROULETTE_RANGES = 7; // MAX_ROLLS + 1
  const JACKPOT_RANGES = 1;
  
  const rouletteCallbackGas = callbackGasLimitBase - (callbackGasLimitBase / 10) + (ROULETTE_RANGES * extraGasPerWord);
  const jackpotCallbackGas = callbackGasLimitBase - (callbackGasLimitBase / 10) + (JACKPOT_RANGES * extraGasPerWord);

  console.log(`\n📐 Callback Gas Limits Being Requested:`);
  console.log(`   - Roulette (7 ranges): ${rouletteCallbackGas.toLocaleString()} gas`);
  console.log(`   - Jackpot (1 range): ${jackpotCallbackGas.toLocaleString()} gas`);

  // Estimate actual needs
  const ESTIMATED_BASE_CALLBACK = 300_000; // Base callback gas
  const ESTIMATED_PER_RANGE = 40_000; // Storage + processing per range
  
  const estimatedRouletteActual = ESTIMATED_BASE_CALLBACK + (ROULETTE_RANGES * ESTIMATED_PER_RANGE);
  const estimatedJackpotActual = ESTIMATED_BASE_CALLBACK + (JACKPOT_RANGES * ESTIMATED_PER_RANGE);

  console.log(`\n💡 Estimated Actual Gas Needed:`);
  console.log(`   - Roulette: ~${estimatedRouletteActual.toLocaleString()} gas`);
  console.log(`   - Jackpot: ~${estimatedJackpotActual.toLocaleString()} gas`);
  
  const rouletteOverhead = ((rouletteCallbackGas - estimatedRouletteActual) / estimatedRouletteActual * 100).toFixed(1);
  const jackpotOverhead = ((jackpotCallbackGas - estimatedJackpotActual) / estimatedJackpotActual * 100).toFixed(1);
  
  console.log(`\n⚠️  Configured Gas Overhead:`);
  console.log(`   - Roulette: ${rouletteOverhead}% over actual needs`);
  console.log(`   - Jackpot: ${jackpotOverhead}% over actual needs`);

  // 8. Summary and recommendations
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📋 DIAGNOSIS SUMMARY`);
  console.log(`${"=".repeat(60)}`);

  const issues: string[] = [];
  
  if (Number(pendingCount) > 10) {
    issues.push(`❌ HIGH: ${pendingCount} pending requests causing O(n) gas growth`);
  }
  
  if (callbackGasLimitBase > 1_000_000) {
    issues.push(`⚠️  MEDIUM: callbackGasLimitBase (${callbackGasLimitBase.toLocaleString()}) is very high`);
  }

  if (issues.length === 0) {
    console.log(`\n✅ No major on-chain issues detected.`);
    console.log(`\n🔎 The cost increase is likely due to:`);
    console.log(`   1. Arbitrum L1 gas price increases (data posting costs)`);
    console.log(`   2. LINK/ETH exchange rate changes`);
    console.log(`   3. Chainlink VRF premium adjustments`);
  } else {
    console.log(`\n🚨 Issues Found:`);
    issues.forEach(issue => console.log(`   ${issue}`));
  }

  console.log(`\n📝 RECOMMENDED OPTIMIZATIONS:`);
  console.log(`   1. Reduce callbackGasLimitBase from ${callbackGasLimitBase.toLocaleString()} to ~600,000`);
  console.log(`   2. Remove allRequestIds tracking (saves ~20k gas per request)`);
  console.log(`   3. Replace pendingRequestIds array with mapping for O(1) operations`);
  console.log(`   4. Consider deploying optimized RandomProviderV2`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

