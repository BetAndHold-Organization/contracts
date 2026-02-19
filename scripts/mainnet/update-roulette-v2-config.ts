import { network } from "hardhat";
import { parseEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// Load deployment addresses
import deploymentV2 from "./deployments/arb-mainnet-v2.json";

// ═══════════════════════════════════════════════════════════════════════════
// NEW CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const NEW_REPLAY_BPS = 500;           // 5% replay chance (was 10%)
const JACKPOT_CONTRIB_BPS = 350;      // Keep 3.5%
const MIN_WAGER = parseEther("0.1");
const MAX_WAGER = parseEther("3");

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  UPDATING ROULETTE V2 TABLE CONFIG");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.account.address);
  console.log("Roulette V2:", deploymentV2.roulette);
  console.log("");

  const roulette = await viem.getContractAt("SingleRandomRouletteV2", deploymentV2.roulette as Addr);

  // Get current config
  const currentConfig = await roulette.read.getTableConfig();
  console.log("Current config:");
  console.log("  - enabled:", currentConfig.enabled);
  console.log("  - replayBps:", currentConfig.replayBps, `(${Number(currentConfig.replayBps) / 100}%)`);
  console.log("  - jackpotBps:", currentConfig.jackpotBps);
  console.log("  - jackpotContributionBps:", currentConfig.jackpotContributionBps);
  console.log("  - minMultiplier:", currentConfig.minMultiplier);
  console.log("  - maxMultiplier:", currentConfig.maxMultiplier);
  console.log("  - minWager:", currentConfig.minWager.toString());
  console.log("  - maxWager:", currentConfig.maxWager.toString());
  console.log("");

  // New config with 5% replay
  const newTableConfig = {
    enabled: true,
    replayBps: NEW_REPLAY_BPS,
    jackpotBps: 0,                          // Scaled via JackpotScalingConfig
    jackpotContributionBps: JACKPOT_CONTRIB_BPS,
    minMultiplier: 101,                     // 1.01x minimum
    maxMultiplier: 10_000,                  // 100x maximum
    minWager: MIN_WAGER,
    maxWager: MAX_WAGER,
  };

  console.log("New config:");
  console.log("  - replayBps:", NEW_REPLAY_BPS, `(${NEW_REPLAY_BPS / 100}%)`);
  console.log("");

  // Update config
  console.log("Updating table config...");
  const tx = await roulette.write.setTableConfig([newTableConfig], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("✓ Table config updated!");
  console.log("  Tx:", tx);

  // Verify
  const updatedConfig = await roulette.read.getTableConfig();
  console.log("");
  console.log("Verified new config:");
  console.log("  - replayBps:", updatedConfig.replayBps, `(${Number(updatedConfig.replayBps) / 100}%)`);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DONE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});



