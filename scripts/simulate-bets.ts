import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

import { decodeErrorResult, encodeFunctionData, formatEther, parseEventLogs, parseEther } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { network } from "hardhat";

const HARDFORK_MNEMONIC = "test test test test test test test test test test test junk";
const ACCOUNT_PATH_PREFIX = "m/44'/60'/0'/0";

const TOTAL_PLAYERS = 100;
const TOTAL_BETS = 1000;
const OUTPUT_DIR = new URL("./output/", import.meta.url);

type DeploymentInfo = {
  token: string;
  coordinator: string;
  randomProvider: string;
  handler: string;
  referral: string;
  jackpot: string;
  roulette: string;
};

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice<T>(list: readonly T[]): T {
  return list[randomInt(0, list.length - 1)];
}

async function loadDeployment(): Promise<DeploymentInfo> {
  const deploymentsPath = new URL("./deployments/local.json", import.meta.url);
  const raw = await fs.readFile(deploymentsPath, "utf8");
  return JSON.parse(raw) as DeploymentInfo;
}

async function main() {
  const deployment = await loadDeployment();
  const connection = await network.connect();
  const viem = connection.viem;
  const walletClients = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  const deployer = walletClients[0];
  const token = await viem.getContractAt("EverValueCoin", deployment.token);
  const roulette = await viem.getContractAt("SingleRandomRoulette", deployment.roulette);
  const coordinator = await viem.getContractAt("MockVRFCoordinatorV2Plus", deployment.coordinator);
  const tableConfig = await roulette.read.getTableConfig();

  const derivedAccounts = Array.from({ length: TOTAL_PLAYERS * 2 }, (_, index) => {
    const account = mnemonicToAccount(HARDFORK_MNEMONIC, {
      path: `${ACCOUNT_PATH_PREFIX}/${index}`,
    });
    return account;
  });

  const players = derivedAccounts.filter((account) => {
    const lower = account.address.toLowerCase();
    return lower !== deployment.house.toLowerCase() && lower !== deployment.fallback.toLowerCase();
  }).slice(0, TOTAL_PLAYERS);

  if (players.length < TOTAL_PLAYERS) {
    throw new Error(`Insufficient funded players: required ${TOTAL_PLAYERS}, got ${players.length}`);
  }

  const output = [];
  let totalWager = 0n;
  let totalNetStake = 0n;
  let totalPayout = 0n;
  let totalJackpot = 0n;
  let failedSpins = 0;
  let jackpotWins = 0;

  await testClient.setBalance({ address: deployer.account.address, value: parseEther("1000000") });

  for (const account of players) {
    await testClient.setBalance({ address: account.address, value: parseEther("1000000") });
    await token.write.approve([deployment.handler, parseEther("10000")], { account });
  }

  const minWagerBigInt = tableConfig.minWager as bigint;
  const maxWagerBigInt = parseEther("100");
  const minWagerEther = Number(formatEther(minWagerBigInt));
  const maxWagerEther = 100;

  for (let i = 0; i < TOTAL_BETS; i += 1) {
    const playerIndex = randomInt(0, players.length - 1);
    const player = players[playerIndex];
    const fallbackReferrer = players[(playerIndex + 1) % players.length];

    let startHash: `0x${string}`;
    let startReceipt;
    let spinStarted;
    let wager: bigint;
    let multiplier: number;
    let referrerAddress: string;
    let attempts = 0;

    while (true) {
      attempts += 1;
      if (attempts > 10) {
        throw new Error(`Unable to start spin after ${attempts} attempts`);
      }

      const wagerEtherRaw = Math.random() * (maxWagerEther - minWagerEther) + minWagerEther;
      const wagerEther = Math.max(minWagerEther, Math.min(maxWagerEther, wagerEtherRaw)).toFixed(2);
      wager = parseEther(wagerEther);
      if (wager < minWagerBigInt) {
        wager = minWagerBigInt;
      } else if (wager > maxWagerBigInt) {
        wager = maxWagerBigInt;
      }
      multiplier = randomInt(110, 200);
      referrerAddress = fallbackReferrer.address === player.address
        ? players[(playerIndex + 2) % players.length].address
        : fallbackReferrer.address;

      try {
        await roulette.simulate.startSpin([
          wager,
          multiplier,
          referrerAddress,
        ], { account: player });

        startHash = await roulette.write.startSpin([
          wager,
          multiplier,
          referrerAddress,
        ], { account: player });

        startReceipt = await publicClient.waitForTransactionReceipt({ hash: startHash });
        const startLogs = parseEventLogs({
          abi: roulette.abi,
          logs: startReceipt.logs,
          eventName: "SpinStarted",
        });

        if (startLogs.length === 0) {
          throw new Error("SpinStarted event not found");
        }

        spinStarted = startLogs[0];
        break;
      } catch (error) {
        const message = String(error);
        let decoded: string | undefined;
        const cause: any = error && typeof error === "object" ? (error as any).cause ?? error : undefined;
        const revertDataOriginal = cause?.data ?? cause?.cause?.data;
        let revertData: `0x${string}` | undefined = typeof revertDataOriginal === "string" ? revertDataOriginal as `0x${string}` : undefined;

        if (!revertData) {
          const calldata = encodeFunctionData({
            abi: roulette.abi,
            functionName: "startSpin",
            args: [wager, multiplier, referrerAddress],
          });

          try {
            if (typeof (network.provider as any)?.request === "function") {
              await network.provider.request({
                method: "eth_call",
                params: [
                  {
                    from: player.address,
                    to: roulette.address,
                    data: calldata,
                  },
                  "latest",
                ],
              });
            }
          } catch (callError) {
            const directCause: any = callError && typeof callError === "object" ? callError : undefined;
            const maybeData = directCause?.data ?? directCause?.error?.data ?? directCause?.cause?.data;
            if (typeof maybeData === "string" && maybeData.startsWith("0x")) {
              revertData = maybeData as `0x${string}`;
            } else {
              console.warn("eth_call revert payload", directCause);
            }
          }
        }

        if (revertData) {
          try {
            const decodedError = decodeErrorResult({
              abi: roulette.abi,
              data: revertData,
            });
            decoded = `${decodedError.errorName}(${decodedError.args?.map((arg) => arg.toString()).join(", ") ?? ""})`;
          } catch (decodeError) {
            decoded = `Failed to decode revert data: ${decodeError}`;
          }
        }

        console.warn(
          `simulate.startSpin attempt ${attempts} reverted for player ${player.address} with wager ${formatEther(wager)} EVA and multiplier ${multiplier}`
          + (decoded ? ` -> ${decoded}` : "")
        );

        if (decoded?.includes("WagerTooHigh") || decoded?.includes("LiquidityShortfall")) {
          continue;
        }

        throw error;
      }
    }

    const requestId = spinStarted.args.requestId as bigint;
    const netStake = spinStarted.args.netStake as bigint;
    const jackpotContribution = spinStarted.args.jackpotContribution as bigint;

    const randomWord = BigInt(`0x${randomBytes(32).toString("hex")}`);
    const fulfillHash = await coordinator.write.fulfill([
      deployment.randomProvider,
      requestId,
      [randomWord],
    ], { account: deployer.account });

    const fulfillReceipt = await publicClient.waitForTransactionReceipt({ hash: fulfillHash });
    const resolvedLogs = parseEventLogs({
      abi: roulette.abi,
      logs: fulfillReceipt.logs,
      eventName: ["SpinResolved", "SpinFailed"],
    });

    totalWager += wager;
    totalNetStake += netStake;

    let outcome: number | null = null;
    let payout = 0n;
    let spinsConsumed = 0;
    let jackpotPayout = 0n;
    let failureReason: string | null = null;

    for (const log of resolvedLogs) {
      if (log.eventName === "SpinResolved") {
        outcome = Number(log.args.outcome);
        payout = log.args.payout as bigint;
        spinsConsumed = Number(log.args.spinsConsumed);
        jackpotPayout = log.args.jackpotPayout as bigint;
      } else if (log.eventName === "SpinFailed") {
        failureReason = (log.args.reason as string) ?? "Unknown";
      }
    }

    if (failureReason) {
      failedSpins += 1;
    } else {
      totalPayout += payout;
      totalJackpot += jackpotPayout;
      if (jackpotPayout > 0n) {
        jackpotWins += 1;
      }
    }

    output.push({
      type: "bet",
      index: i,
      requestId: requestId.toString(),
      player: player.address,
      referrer: referrerAddress,
      wager: wager.toString(),
      netStake: netStake.toString(),
      multiplier,
      jackpotContribution: jackpotContribution.toString(),
      outcome,
      payout: payout.toString(),
      jackpotPayout: jackpotPayout.toString(),
      spinsConsumed,
      failureReason,
      startTx: startHash!,
      fulfillTx: fulfillHash,
    });
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const filename = new URL(`roulette-sim-${Date.now()}.jsonl`, OUTPUT_DIR);
  const summary = {
    type: "summary" as const,
    totalBets: TOTAL_BETS,
    distinctPlayers: players.length,
    totalWager: totalWager.toString(),
    totalNetStake: totalNetStake.toString(),
    totalPayout: totalPayout.toString(),
    totalJackpot: totalJackpot.toString(),
    failedSpins,
    jackpotWins,
    houseRetention: (totalWager - totalNetStake).toString(),
    netHouseResult: (totalWager - totalPayout - totalJackpot).toString(),
  };

  await fs.writeFile(
    filename,
    [...output.map((row) => JSON.stringify(row)), JSON.stringify(summary)].join("\n")
  );
  console.log("Simulation results saved to", filename.pathname);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


