import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const ROULETTE = "0x29a597c324dce8f075d55acc7b0e65563ae180ab" as Addr;

const SCALING_CONFIG = {
  enabled: true,
  minJackpotBps: 100,                      // 1% at minJackpotWager
  maxJackpotBps: 600,                      // 6% at maxJackpotWager
  minJackpotWager: parseEther("0.1"),
  maxJackpotWager: parseEther("5"),
  functionId: 2,                           // Logarithmic (sqrt)
  extraData: "0x" as `0x${string}`,
};

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const roulette = await viem.getContractAt("SingleRandomRouletteV2", ROULETTE);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  UPDATE JACKPOT SCALING — maxJackpotBps → 600 (6%)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.account.address);
  console.log("Roulette:", ROULETTE);
  console.log("");

  const oldScl = await roulette.read.getJackpotScalingConfig([]);
  console.log("BEFORE: maxJackpotBps =", Number(oldScl.maxJackpotBps), "(" + (Number(oldScl.maxJackpotBps) / 100) + "%)");

  const tx = await roulette.write.setJackpotScalingConfig(
    [SCALING_CONFIG],
    { account: deployer.account }
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("TX:", tx);
  console.log("Confirmed block", receipt.blockNumber, " gas=" + receipt.gasUsed);

  const newScl = await roulette.read.getJackpotScalingConfig([]);
  console.log("");
  console.log("AFTER:");
  console.log("  enabled:         ", newScl.enabled);
  console.log("  minJackpotBps:   ", Number(newScl.minJackpotBps), "(" + (Number(newScl.minJackpotBps) / 100) + "%)");
  console.log("  maxJackpotBps:   ", Number(newScl.maxJackpotBps), "(" + (Number(newScl.maxJackpotBps) / 100) + "%)");
  console.log("  minJackpotWager: ", formatEther(newScl.minJackpotWager), "EVA");
  console.log("  maxJackpotWager: ", formatEther(newScl.maxJackpotWager), "EVA");
  console.log("  functionId:      ", Number(newScl.functionId), "(Logarithmic)");
  console.log("");
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
