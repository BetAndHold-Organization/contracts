import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEventLogs, parseEther, formatEther } from "viem";
import "dotenv/config";

type DeploymentInfo = {
  token: string;
  randomProvider: string;
  handler: string;
  referral: string;
  jackpot: string;
  roulette: string;
};

async function loadDeployment(): Promise<DeploymentInfo> {
  const p = new URL("./deployments/arb-sepolia.json", import.meta.url);
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const deployment = await loadDeployment();
  const conn = await network.connect();
  const viem = conn.viem;

  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const token = await viem.getContractAt("EverValueCoin", deployment.token);
  const roulette = await viem.getContractAt("SingleRandomRoulette", deployment.roulette);

  // Parameters: 1 EVA wager, 1.50x multiplier, no explicit referrer (will route to default receiver)
  const wager = parseEther("1");
  const multiplier = 150; // 1.50x (hundredths)
  const referrer = "0x0000000000000000000000000000000000000000";

  // Ensure allowance to PaymentHandler is sufficient
  const allowance = await token.read.allowance([deployer.account.address, deployment.handler]);
  if (allowance < wager) {
    const txApprove = await token.write.approve([deployment.handler, parseEther("1000")], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: txApprove });
  }

  console.log("Starting spin...");
  const startHash = await roulette.write.startSpin([wager, multiplier, referrer], { account: deployer.account });
  const startReceipt = await publicClient.waitForTransactionReceipt({ hash: startHash });

  const started = parseEventLogs({
    abi: roulette.abi,
    logs: startReceipt.logs,
    eventName: "SpinStarted",
  });
  if (started.length === 0) {
    throw new Error("SpinStarted event not found");
  }
  const requestId = started[0].args.requestId as bigint;
  console.log("requestId:", requestId.toString());

  // Poll for resolution; VRF may take time
  const fromBlock = startReceipt.blockNumber;
  const deadline = Date.now() + 10 * 60_000; // 10 minutes
  while (Date.now() < deadline) {
    const logs = await publicClient.getLogs({ address: deployment.roulette, fromBlock });
    const parsed = parseEventLogs({
      abi: roulette.abi,
      logs,
      eventName: ["SpinResolved", "SpinFailed"],
    });
    if (parsed.length > 0) {
      const ev = parsed[0];
      if (ev.eventName === "SpinResolved") {
        const payout = ev.args.payout as bigint;
        const jackpotPayout = ev.args.jackpotPayout as bigint;
        console.log("SpinResolved:", {
          outcome: Number(ev.args.outcome),
          payout: formatEther(payout),
          spinsConsumed: Number(ev.args.spinsConsumed),
          jackpotPayout: formatEther(jackpotPayout),
        });
      } else {
        console.log("SpinFailed:", { reason: ev.args.reason });
      }
      return;
    }
    await sleep(10_000);
  }

  console.log("Timeout waiting for VRF resolution; check subscription funding and consumer list.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


