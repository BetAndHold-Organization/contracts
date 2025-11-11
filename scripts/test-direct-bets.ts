import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEventLogs, formatEther, parseEther, type Address } from "viem";

type Deployment = { token: string; coordinator: string; randomProvider: string; handler: string; jackpot: string; };

async function loadDeployment(): Promise<Deployment> {
  const path = new URL("./deployments/local.json", import.meta.url);
  return JSON.parse(await fs.readFile(path, "utf8")) as Deployment;
}
async function resultFromOutcome(outcomeIndex: number, jackpotRef: any): Promise<string> {
    const outcomes = await jackpotRef.read.getDirectBetOutcomes();
    console.log({outcomeIndex});
    const o = (outcomes as any[])[outcomeIndex];
    const awardsTier = Boolean(o.awardsTier ?? o[4] ?? false);
    const consBps = Number(o.consolationMultiplier ?? o[3] ?? 0);
    if (awardsTier) return "TIER";
    if (consBps > 0) return `CONSOLATION ${(consBps / 100).toFixed(2)}x`;
    return "LOSE";
  }

// Helper 2: compute a roll that produces one of 4 outcomes
async function desiredRollFor(
  jackpot: any,
  target: "LOSE" | "CONS_1200" | "CONS_1500" | "TIER"
): Promise<bigint> {
  const outcomes = await jackpot.read.getDirectBetOutcomes();
  type Slice = { start: number; end: number; awardsTier: boolean; consBps: number };
  const slices: Slice[] = [];
  let prev = 0;
  for (const o of outcomes as any[]) {
    const cum = Number(o.cumulativeProbability ?? o[0] ?? 0);
    const awards = Boolean(o.awardsTier ?? o[4] ?? false);
    const cons = Number(o.consolationMultiplier ?? o[3] ?? 0);
    if (cum > prev) slices.push({ start: prev, end: cum, awardsTier: awards, consBps: cons });
    prev = cum;
  }
  const pick = (s: Slice) => BigInt(s.start);
  if (target === "LOSE") {
    const s = slices.find(s => !s.awardsTier && s.consBps === 0);
    if (!s) throw new Error("LOSE slice not found");
    return pick(s);
  }
  if (target === "CONS_1200") {
    const s = slices.find(s => !s.awardsTier && s.consBps === 1200);
    if (!s) throw new Error("CONS_1200 slice not found");
    return pick(s);
  }
  if (target === "CONS_1500") {
    const s = slices.find(s => !s.awardsTier && s.consBps === 1500);
    if (!s) throw new Error("CONS_1500 slice not found");
    return pick(s);
  }
  const s = slices.find(s => s.awardsTier);
  if (!s) throw new Error("TIER slice not found");
  return pick(s);
}

async function main() {
  const deployment = await loadDeployment();
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, player] = await viem.getWalletClients();

  const jackpot = await viem.getContractAt("ProgressiveJackpot", deployment.jackpot as Address);
  const coordinator = await viem.getContractAt("MockVRFCoordinatorV2Plus", deployment.coordinator as Address);
  const token = await viem.getContractAt("EverValueCoin", deployment.token as Address);

  // Approve once
  await token.write.approve([deployment.handler as Address, parseEther("1000000")], { account: player.account });

  // Track 4 settlements then exit
  let settledCount = 0;
  const targetSettlements = 4;
  const unwatch = publicClient.watchContractEvent({
    address: jackpot.address,
    abi: jackpot.abi,
    eventName: "DirectBetSettled",
    onLogs: async (logs) => {
      for (const log of logs) {
        const { requestId, player: bettor, outcomeIndex, payout } = log.args as {
          requestId: bigint; player: `0x${string}`; outcomeIndex: bigint; payout: bigint;
        };
        // Get entry data from the same tx
        const receipt = await publicClient.getTransactionReceipt({ hash: log.transactionHash });
        const [entry] = parseEventLogs({ abi: jackpot.abi, logs: receipt.logs, eventName: "EntryProcessed" });
        const entryId = entry?.args.entryId as bigint | undefined;
        const betAmount = entry?.args.betAmount as bigint | undefined;
        const tierIndex = entry?.args.tierIndex as number | undefined;

        // Decode result from outcome object at settlement block
        const outcomes = await jackpot.read.getDirectBetOutcomes({ blockNumber: log.blockNumber });
        const outcome = (outcomes as any[])[Number(outcomeIndex)];
        const result = resultFromOutcome(Number(outcomeIndex), jackpot);

        console.log("\n---- Direct bet settled ----");
        console.log("RequestId:", requestId.toString());
        console.log("Player:", bettor);
        console.log("Payout:", formatEther(payout), "EVA");
        console.log("EntryId:", entryId?.toString() ?? "?");
        console.log("BetAmount:", betAmount ? formatEther(betAmount) : "?", "EVA");
        console.log("TierIndex:", tierIndex ?? "?");
        console.log("Result:", `${result}, outcomeIndex=${Number(outcomeIndex)}`);

        settledCount += 1;
        if (settledCount >= targetSettlements) {
          setTimeout(() => unwatch(), 250); // allow final logs to flush
        }
      }
    },
  });

  // Place 4 bets; fulfill to force each outcome
  const targets: Array<"LOSE" | "CONS_1200" | "CONS_1500" | "TIER"> = ["LOSE", "CONS_1200", "CONS_1500", "TIER"];
  for (const t of targets) {
    const handlerAddr = deployment.handler as Address;

    token.write.approve([handlerAddr, parseEther("1000000")], { account: player.account });
    const submitHash = await jackpot.write.placeDirectBet(["0x0000000000000000000000000000000000000000"], { account: player.account });
    const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });
    const [req] = parseEventLogs({ abi: jackpot.abi, logs: submitReceipt.logs, eventName: "DirectBetRequested" });
    if (!req) throw new Error("DirectBetRequested not found");
    const requestId = req.args.requestId as bigint;

    const roll = await desiredRollFor(jackpot, t);
    // Fire fulfillment; listener will capture DirectBetSettled
    void coordinator.write.fulfill([deployment.randomProvider as Address, requestId, [roll]], { account: deployer.account });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});