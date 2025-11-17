import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";
import { parseEventLogs } from "viem";
import { encodeFunctionData } from "viem";
import { decodeErrorResult, BaseError, ContractFunctionRevertedError } from "viem";
import { randomBytes } from "node:crypto";
type DeploymentInfo = {
  token: string;
  coordinator: string;
  randomProvider: string;
  handler: string;
  referral: string;
  jackpot: string;
  roulette: string;
};

async function loadDeployment(): Promise<DeploymentInfo> {
  const p = new URL("./deployments/local.json", import.meta.url);
  return JSON.parse(await fs.readFile(p, "utf8"));
}

// Hardcoded params (edit these)
const WAGER = parseEther("100.0000000000000001");   // 10 EVA
const MULTIPLIER = 150;           // 1.50x (hundredths)
const REFERRER = "0x0000000000000000000000000000000000000000"; // optional

async function main() {
  const deployment = await loadDeployment();
  const conn = await network.connect();
  const viem = conn.viem;

  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [deployer, player] = await viem.getWalletClients();

  const token = await viem.getContractAt("EverValueCoin", deployment.token);
  const roulette = await viem.getContractAt("SingleRandomRoulette", deployment.roulette);

  // Give ETH and EVA to player and approve handler
  await testClient.setBalance({ address: deployer.account.address, value: parseEther("1000000") });
  await testClient.setBalance({ address: player.account.address, value: parseEther("1000000") });
  await token.write.transfer([player.account.address, parseEther("1000")], { account: deployer.account });
  await token.write.approve([deployment.handler, parseEther("1000")], { account: player.account });


// 1) Simulate startSpin (no state change). Decodes cleanly on revert.

try {
    // This attaches the matched custom error to err.cause.abiItem and decodes args
    await roulette.simulate.startSpin(
      [WAGER, MULTIPLIER, REFERRER],
      { account: player.account }
    );
  
    // simulate OK → send once
    const txHash = await roulette.write.startSpin(
      [WAGER, MULTIPLIER, REFERRER],
      { account: player.account }
    );
  
    // ... wait receipt, parse SpinStarted, fulfill, parse SpinResolved ...
  } catch (err: any) {
    const cause = err?.cause ?? err;
  
    if (cause?.name === "ContractFunctionRevertedError" && cause?.abiItem) {
      const name = cause.abiItem.name;                 // e.g., WagerTooHigh
      const args = Array.isArray(cause.args)
        ? cause.args.map((a: any) => a.toString()).join(", ")
        : "";
      console.error(`Reverted -> ${name}(${args})`);
    } else {
      console.error("Reverted (no abiItem on cause)");
      console.dir(err, { depth: 10 });                 // inspect structure if needed
    }
    return;
  }
  const txHash = await roulette.write.startSpin(
    [WAGER, MULTIPLIER as unknown as bigint, REFERRER],
    { account: player.account }
  );

  console.log("startSpin tx:", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const started = parseEventLogs({
        abi: roulette.abi,
        logs: receipt.logs,
        eventName: "SpinStarted",
      });
      if (started.length === 0) throw new Error("SpinStarted not found");
      const requestId = started[0].args.requestId as bigint;
      console.log("requestId:", requestId.toString());

      const coordinator = await viem.getContractAt("MockVRFCoordinatorV2Plus", deployment.coordinator);
      const randomWord = BigInt(`0x${randomBytes(32).toString("hex")}`);
      
      const fulfillHash = await coordinator.write.fulfill(
        [deployment.randomProvider, requestId, [randomWord]],
        { account: deployer.account }
      );
      const fulfillReceipt = await publicClient.waitForTransactionReceipt({ hash: fulfillHash });
      
      const resolved = parseEventLogs({
        abi: roulette.abi,
        logs: fulfillReceipt.logs,
        eventName: ["SpinResolved", "SpinFailed"],
      });
      
      if (resolved.length === 0) {
        console.log("No resolution event");
      } else if (resolved[0].eventName === "SpinResolved") {
        console.log("SpinResolved:", {
          outcome: Number(resolved[0].args.outcome),               // 0=Lose,1=Multiplier,2=Jackpot
          payout: (resolved[0].args.payout as bigint).toString(),
          spinsConsumed: Number(resolved[0].args.spinsConsumed),
          jackpotPayout: (resolved[0].args.jackpotPayout as bigint).toString(),
          tx: fulfillHash,
        });
      } else {
        console.log("SpinFailed:", {
          reason: resolved[0].args.reason,
          tx: fulfillHash,
        });
      }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});