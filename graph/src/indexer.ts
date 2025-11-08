import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient,
  http,
  webSocket,
  WatchContractEventReturnType,
  Log,
  Hex,
} from "viem";
import { hardhat } from "viem/chains";

import { env } from "./config.js";
import { db } from "./db.js";
import { loadContracts } from "./lib/contracts.js";
import { upsertBet, resolveBet } from "./lib/bets.js";
import { ReferralService } from "./lib/referrals.js";
import { decodeEventLog } from "viem";
const ZERO_TX: Hex = "0x0000000000000000000000000000000000000000";

type SpinStartedLog = Log & {
  args: {
    requestId: bigint;
    player: `0x${string}`;
    wager: bigint;
    netStake: bigint;
    multiplierHundredths: bigint;
    jackpotContribution: bigint;
  };
};

type SpinResolvedLog = Log & {
  args: {
    requestId: bigint;
    outcome: bigint;
    payout: bigint;
    jackpotPayout: bigint;
    spinsConsumed: bigint;
  };
};

type SpinFailedLog = Log & {
  args: {
    requestId: bigint;
    reason: string;
  };
};

function castLogs<T extends Log>(logs: readonly Log[]): T[] {
  return logs as T[];
}

async function main() {
  console.log("Indexer bootstrap started");

  const contracts = await loadContracts();
  await db.$connect();

  const publicClient = createPublicClient({
    chain: hardhat,
    transport: http(env.RPC_URL),
  });

  const wsTransport = env.RPC_WS_URL ? webSocket(env.RPC_WS_URL) : undefined;
  const wsClient = wsTransport
    ? createPublicClient({
        chain: hardhat,
        transport: wsTransport,
      })
    : undefined;

  const referralService = await ReferralService.create(
    db,
    publicClient,
    contracts
  );

  const latest = await publicClient.getBlockNumber();
  console.log("Latest block:", latest);

  let watchers: WatchContractEventReturnType[] = [];
  let lastIndexedBlock = latest;
  let lastLogTimestamp = Date.now();

  const watchClient = wsClient ?? publicClient;

  await backfillSpins(
    publicClient,
    contracts.rouletteAddress,
    contracts.rouletteAbi,
    0n,
    latest,
    referralService,
    contracts.jackpotAddress,
    contracts.jackpotAbi,
  );

  const registerWatcher = () => {
    console.log("Registering contract event watchers");

    const startedWatcher = watchClient.watchContractEvent({
      address: contracts.rouletteAddress,
      abi: contracts.rouletteAbi,
      eventName: "SpinStarted",
      onLogs: async (logs) => {
        const entries = castLogs<SpinStartedLog>(logs);
        for (const log of entries) {
          try {
            const context = {
              requestId: log.args.requestId,
              player: log.args.player,
              wager: log.args.wager,
              netStake: log.args.netStake,
              txHash: (log.transactionHash ?? ZERO_TX) as Hex,
              blockNumber: log.blockNumber ?? 0n,
            };

            const referrer = await referralService.processSpin(context);

            await upsertBet(
              db,
              {
                requestId: context.requestId,
                player: context.player,
                wager: context.wager,
                netStake: context.netStake,
                multiplierHundredths: Number(log.args.multiplierHundredths),
                jackpotContribution: log.args.jackpotContribution,
                blockNumber: Number(context.blockNumber),
                txHash: context.txHash,
              },
              referrer ?? undefined
            );
            lastIndexedBlock = context.blockNumber;
            lastLogTimestamp = Date.now();
          } catch (err) {
            console.error("Failed to upsert bet", log.transactionHash, err);
          }
        }
      },
      pollingInterval: 1_000,
      onError(error) {
        console.error("SpinStarted watcher error", error);
        reRegisterWatchers();
      },
    });

    const resolvedWatcher = watchClient.watchContractEvent({
      address: contracts.rouletteAddress,
      abi: contracts.rouletteAbi,
      eventName: "SpinResolved",
      onLogs: async (logs) => {
        const entries = castLogs<SpinResolvedLog>(logs);
        for (const log of entries) {
          try {
            await resolveBet(db, {
              requestId: log.args.requestId,
              outcome: Number(log.args.outcome),
              payout: log.args.payout,
              jackpotPayout: log.args.jackpotPayout,
              spinsConsumed: Number(log.args.spinsConsumed),
              fulfillTx: (log.transactionHash ?? ZERO_TX) as Hex,
            });
            if (log.transactionHash) {
              const receipt = await publicClient.getTransactionReceipt({ hash: log.transactionHash as Hex });
            
              const bet = await db.bet.findUnique({
                where: { requestId: log.args.requestId },
                select: { id: true, wager: true },
              });
            
              if (bet) {
                const wagerStr = typeof bet.wager === "string" ? bet.wager : (bet.wager as any).toString();
                const wager = BigInt(wagerStr);
            
                for (const jl of receipt.logs) {
                  if (jl.address?.toLowerCase() !== contracts.jackpotAddress.toLowerCase()) continue;
            
                  try {
                    const parsed = decodeEventLog({
                      abi: contracts.jackpotAbi,
                      data: jl.data as Hex,
                      // viem types expect a tuple: [signature, ...args]
                      topics: jl.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
                    }) as { eventName: string; args: any };
            
                    if (parsed.eventName === "ConsolationPaid") {
                      const payout = parsed.args.payout as bigint;
                      const bps = wager > 0n ? Number((payout * 10000n) / wager) : 0;
                      await db.jackpotEvent.create({
                        data: {
                          betId: bet.id,
                          type: "CONSOLATION",
                          tierIndex: null,
                          payout: payout.toString(),
                          consolationMultiplier: bps.toString(),
                        },
                      });
                    } else if (parsed.eventName === "TierWon") {
                      const payout = parsed.args.payout as bigint;
                      const tierIndex = Number(parsed.args.tierIndex);
                      await db.jackpotEvent.create({
                        data: {
                          betId: bet.id,
                          type: "TIER",
                          tierIndex,
                          payout: payout.toString(),
                          consolationMultiplier: null,
                        },
                      });
                    } else if (parsed.eventName === "JackpotWon") {
                      const payout = parsed.args.payout as bigint;
                      await db.jackpotEvent.create({
                        data: {
                          betId: bet.id,
                          type: "JACKPOT",
                          tierIndex: null,
                          payout: payout.toString(),
                          consolationMultiplier: null,
                        },
                      });
                    }
                  } catch {}
                }
              }
            }
            
            
          } catch (err) {
            console.error("Failed to resolve bet", log.transactionHash, err);
          }
        }
      },
      pollingInterval: 1_000,
      onError(error) {
        console.error("SpinResolved watcher error", error);
        reRegisterWatchers();
      },
    });

    const failedWatcher = watchClient.watchContractEvent({
      address: contracts.rouletteAddress,
      abi: contracts.rouletteAbi,
      eventName: "SpinFailed",
      onLogs: async (logs) => {
        const entries = castLogs<SpinFailedLog>(logs);
        for (const log of entries) {
          try {
            await resolveBet(db, {
              requestId: log.args.requestId,
              outcome: 3,
              payout: 0n,
              jackpotPayout: 0n,
              spinsConsumed: 0,
              fulfillTx: (log.transactionHash ?? ZERO_TX) as Hex,
              failureReason: log.args.reason,
            });
            if (log.blockNumber) {
              lastIndexedBlock = log.blockNumber;
              lastLogTimestamp = Date.now();
            }
          } catch (err) {
            console.error(
              "Failed to record failed bet",
              log.transactionHash,
              err
            );
          }
        }
      },
      pollingInterval: 1_000,
      onError(error) {
        console.error("SpinFailed watcher error", error);
        reRegisterWatchers();
      },
    });

    const referrerRecordedWatcher = watchClient.watchContractEvent({
      address: contracts.referralAddress,
      abi: contracts.referralAbi,
      eventName: "ReferrerRecorded",
      onLogs: async (logs) => {
        const entries = castLogs<
          Log & { args: { player: `0x${string}`; referrer: `0x${string}` } }
        >(logs);
        for (const log of entries) {
          try {
            await referralService.handleReferrerRecorded(
              log.args.player,
              log.args.referrer
            );
          } catch (error) {
            console.error("Failed to handle ReferrerRecorded", error);
          }
        }
      },
      pollingInterval: 5_000,
      onError(error) {
        console.error("ReferrerRecorded watcher error", error);
        reRegisterWatchers();
      },
    });

    const rewardsWithdrawnWatcher = watchClient.watchContractEvent({
      address: contracts.referralAddress,
      abi: contracts.referralAbi,
      eventName: "RewardsWithdrawn",
      onLogs: async (logs) => {
        const entries = castLogs<
          Log & { args: { referrer: `0x${string}`; amount: bigint } }
        >(logs);
        for (const log of entries) {
          try {
            await referralService.handleRewardsWithdrawn(
              log.args.referrer,
              log.args.amount
            );
          } catch (error) {
            console.error("Failed to handle RewardsWithdrawn", error);
          }
        }
      },
      pollingInterval: 5_000,
      onError(error) {
        console.error("RewardsWithdrawn watcher error", error);
        reRegisterWatchers();
      },
    });

    watchers = [
      startedWatcher,
      resolvedWatcher,
      failedWatcher,
      referrerRecordedWatcher,
      rewardsWithdrawnWatcher,
    ];
  };

  const unregisterWatchers = () => {
    for (const watcher of watchers) {
      try {
        watcher?.();
      } catch (err) {
        console.error("Failed to dispose watcher", err);
      }
    }
    watchers = [];
  };

  const reRegisterWatchers = () => {
    unregisterWatchers();
    // Small delay to avoid tight restart loops
    setTimeout(registerWatcher, 1_000);
  };

  registerWatcher();

  setInterval(async () => {
    try {
      const chainTip = await publicClient.getBlockNumber();
      const lag = Number(chainTip - lastIndexedBlock);
      const secondsSinceLastLog = (Date.now() - lastLogTimestamp) / 1000;
      if (lag > 5 || secondsSinceLastLog > 30) {
        console.warn(
          `Indexer lag detected (lag=${lag} blocks, lastLog=${secondsSinceLastLog.toFixed(
            0
          )}s ago). Re-registering watchers.`
        );
        reRegisterWatchers();
        await backfillSpins(
          publicClient,
          contracts.rouletteAddress,
          contracts.rouletteAbi,
          lastIndexedBlock,
          chainTip,
          referralService,
          contracts.jackpotAddress,
          contracts.jackpotAbi,
        );
        lastIndexedBlock = chainTip;
        lastLogTimestamp = Date.now();
      }
    } catch (err) {
      console.error("Failed during health check", err);
    }
  }, 30_000);

  console.log("Indexer listening for events");
}

async function backfillSpins(
  client: ReturnType<typeof createPublicClient>,
  address: `0x${string}`,
  abi: readonly any[],
  fromBlock: bigint,
  toBlock: bigint,
  referralService: ReferralService,
  jackpotAddress: `0x${string}`,
  jackpotAbi: readonly any[],
  
) {
  const startedLogs = castLogs<SpinStartedLog>(
    await client.getContractEvents({
      address,
      abi,
      eventName: "SpinStarted",
      fromBlock,
      toBlock,
    })
  );

  for (const log of startedLogs) {
    const context = {
      requestId: log.args.requestId,
      player: log.args.player,
      wager: log.args.wager,
      netStake: log.args.netStake,
      txHash: (log.transactionHash ?? ZERO_TX) as Hex,
      blockNumber: log.blockNumber ?? toBlock,
    };

    const referrer = await referralService.processSpin(context);

    await upsertBet(
      db,
      {
        requestId: context.requestId,
        player: context.player,
        wager: context.wager,
        netStake: context.netStake,
        jackpotContribution: log.args.jackpotContribution,
        multiplierHundredths: Number(log.args.multiplierHundredths),
        blockNumber: Number(context.blockNumber),
        txHash: context.txHash,
      },
      referrer ?? undefined
    );
  }

  const resolvedLogs = castLogs<SpinResolvedLog>(
    await client.getContractEvents({
      address,
      abi,
      eventName: "SpinResolved",
      fromBlock,
      toBlock,
    })
  );

  for (const log of resolvedLogs) {
    await resolveBet(db, {
      requestId: log.args.requestId,
      outcome: Number(log.args.outcome),
      payout: log.args.payout,
      jackpotPayout: log.args.jackpotPayout,
      spinsConsumed: Number(log.args.spinsConsumed),
      fulfillTx: (log.transactionHash ?? ZERO_TX) as Hex,
    });
    try {
      const receipt = await client.getTransactionReceipt({ hash: log.transactionHash as Hex });
    
      const bet = await db.bet.findUnique({
        where: { requestId: log.args.requestId },
        select: { id: true, wager: true },
      });
    
      if (bet) {
        const wagerStr = typeof bet.wager === "string" ? bet.wager : (bet.wager as any).toString();
        const wager = BigInt(wagerStr);
    
        for (const jl of receipt.logs) {
          if (jl.address?.toLowerCase() !== address.toLowerCase().replace( // reuse jackpot addr if you have it in scope
            address.toLowerCase(), jackpotAddress.toLowerCase()
          )) {
            // NOTE: replace this line with a simple check:
            // if (jl.address?.toLowerCase() !== contracts.jackpotAddress.toLowerCase()) continue;
          }
    
          try {
            const parsed = decodeEventLog({
              abi: jackpotAbi,
              data: jl.data as Hex,
              topics: jl.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
            }) as { eventName: string; args: any };
    
            if (parsed.eventName === "ConsolationPaid") {
              const payout = parsed.args.payout as bigint;
              const bps = wager > 0n ? Number((payout * 10000n) / wager) : 0;
    
              // idempotency: skip if a CONSOLATION already exists for this bet
              const exists = await db.jackpotEvent.findFirst({
                where: { betId: bet.id, type: "CONSOLATION" },
              });
              if (!exists) {
                await db.jackpotEvent.create({
                  data: {
                    betId: bet.id,
                    type: "CONSOLATION",
                    tierIndex: null,
                    payout: payout.toString(),
                    consolationMultiplier: bps.toString(),
                  },
                });
              }
            } else if (parsed.eventName === "TierWon") {
              const payout = parsed.args.payout as bigint;
              const tierIndex = Number(parsed.args.tierIndex);
    
              const exists = await db.jackpotEvent.findFirst({
                where: { betId: bet.id, type: "TIER" },
              });
              if (!exists) {
                await db.jackpotEvent.create({
                  data: {
                    betId: bet.id,
                    type: "TIER",
                    tierIndex,
                    payout: payout.toString(),
                    consolationMultiplier: null,
                  },
                });
              }
            } else if (parsed.eventName === "JackpotWon") {
              const payout = parsed.args.payout as bigint;
    
              const exists = await db.jackpotEvent.findFirst({
                where: { betId: bet.id, type: "JACKPOT" },
              });
              if (!exists) {
                await db.jackpotEvent.create({
                  data: {
                    betId: bet.id,
                    type: "JACKPOT",
                    tierIndex: null,
                    payout: payout.toString(),
                    consolationMultiplier: null,
                  },
                });
              }
            }
          } catch {
            // skip unrecognized logs
          }
        }
      }
    } catch (e) {
      // optional: log but don't fail backfill
      console.warn("backfill jackpot parse error", e);
    }
  }

  const failedLogs = castLogs<SpinFailedLog>(
    await client.getContractEvents({
      address,
      abi,
      eventName: "SpinFailed",
      fromBlock,
      toBlock,
    })
  );

  for (const log of failedLogs) {
    await resolveBet(db, {
      requestId: log.args.requestId,
      outcome: 3,
      payout: 0n,
      jackpotPayout: 0n,
      spinsConsumed: 0,
      fulfillTx: (log.transactionHash ?? ZERO_TX) as Hex,
      failureReason: log.args.reason,
    });
  }
}

main().catch((error) => {
  console.error("Indexer failed", error);
  process.exit(1);
});