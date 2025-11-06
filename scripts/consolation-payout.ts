import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { parseEther, formatEther, parseEventLogs } from "viem";
import { network } from "hardhat";

type Deployment = {
  token: string;
  coordinator: string;
  randomProvider: string;
  handler: string;
  referral: string;
  jackpot: string;
  roulette: string;
  house?: string;
  fallback?: string;
};

async function load() {
  const p = new URL("./deployments/local.json", import.meta.url);
  return JSON.parse(await fs.readFile(p, "utf8")) as Deployment;
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  const d = await load();
  const conn = await network.connect();
  const viem = conn.viem;

  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [deployer, player] = await viem.getWalletClients();

  const token = await viem.getContractAt("EverValueCoin", d.token);
  const roulette = await viem.getContractAt("SingleRandomRoulette", d.roulette);
  const coordinator = await viem.getContractAt("MockVRFCoordinatorV2Plus", d.coordinator);
  const jackpot = await viem.getContractAt("ProgressiveJackpot", d.jackpot);

  // Ensure ETH and EVA balances + allowance for the bettor (player)
  await testClient.setBalance({ address: deployer.account.address, value: parseEther("1000000") });
  await testClient.setBalance({ address: player.account.address, value: parseEther("1000000") });
  await token.write.transfer([player.account.address, parseEther("1000")], { account: deployer.account });

  const MAX = (2n ** 256n) - 1n;
  await token.write.approve([d.handler as `0x${string}`, MAX], { account: player.account });

  // Get table limits
  const table = await roulette.read.getTableConfig();
  const minWager = (table.minWager ?? table[6] ?? 0n) as bigint;
  const minE = Number(formatEther(minWager));

  const maxAttempts = 2000;

  for (let i = 1; i <= maxAttempts; i++) {
    // Random wager in [min, 100] with 2 decimals
    const wagerE = Math.max(minE, Math.min(100, Math.random() * (100 - minE) + minE));
    const wager = parseEther(wagerE.toFixed(2));
    const multiplier = randInt(110, 200);
    const referrer = deployer.account.address;

    // Skip on simulate revert
    try {
      await roulette.simulate.startSpin([wager, multiplier, referrer], { account: player.account });
    } catch {
      continue;
    }

    // Send startSpin
    const startHash = await roulette.write.startSpin([wager, multiplier, referrer], { account: player.account });
    const startRcpt = await publicClient.waitForTransactionReceipt({ hash: startHash });

    // Parse SpinStarted
    const started = parseEventLogs({
      abi: roulette.abi,
      logs: startRcpt.logs,
      eventName: "SpinStarted",
    });
    if (started.length === 0) continue;

    const requestId = started[0].args.requestId as bigint;

    // Fulfill randomness
    const randomWord = BigInt(`0x${randomBytes(32).toString("hex")}`);
    const fulfillHash = await coordinator.write.fulfill([d.randomProvider, requestId, [randomWord]], { account: deployer.account });
    const fulfillRcpt = await publicClient.waitForTransactionReceipt({ hash: fulfillHash });

    // Check roulette outcome = Jackpot (2)
    const resolved = parseEventLogs({
      abi: roulette.abi,
      logs: fulfillRcpt.logs,
      eventName: ["SpinResolved", "SpinFailed"],
    });

    let hitJackpotPath = false;
    for (const log of resolved) {
      if (log.eventName === "SpinResolved") {
        const outcome = Number(log.args.outcome); // 0=Lose, 1=Multiplier, 2=Jackpot
        if (outcome === 2) {
          console.log("Jackpot path found");
          hitJackpotPath = true;
          break;
        }
      }
    }
    if (!hitJackpotPath) {
      // Not a jackpot path; continue searching
      continue;
    }

    // Look for jackpot ConsolationPaid in the same tx
    try {
      const jpLogs = parseEventLogs({
        abi: jackpot.abi,
        logs: fulfillRcpt.logs,
        eventName: ["ConsolationPaid", "TierWon", "EntryProcessed"],
      });
      const spinResolved = parseEventLogs({
        abi: roulette.abi,
        logs: fulfillRcpt.logs,
        eventName: "SpinResolved",
      })

      const consolation = jpLogs.find((l) => l.eventName === "ConsolationPaid");

      if (consolation) {
       // console.log("Consolation paid found:", consolation);
        const payout = consolation.args.payout as bigint;
        const multi = consolation.args.consolationMultiplier as bigint;
        console.log(payout)
        console.log(spinResolved)
        console.log("Jackpot Consolation FOUND:", {
          attempt: i,
          wager: formatEther(wager),
          multi,
          payout: formatEther(payout),
          fulfillTx: fulfillHash,
        });
        return;
      } else {
        // Jackpot path with no ConsolationPaid => likely TierWon or no payout outcome
        // You can uncomment below for more insight:
        // console.log("Jackpot path without ConsolationPaid on attempt", i, jpLogs.map(l => l.eventName));
      }
    } catch(error) {
      console.log(error)
      // No jackpot logs decoded; continue
    }
  }

  console.log(`No jackpot consolation found after ${maxAttempts} attempts. Increase attempts or adjust jackpot outcome table to raise consolation probability.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });