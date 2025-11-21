import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient,
  http,
  webSocket,
  WatchContractEventReturnType,
  Log,
  Hex,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
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

type GameBetProcessedLog = Log & {
  args: {
    game: `0x${string}`;
    bettor: `0x${string}`;
    assignedReferrer: `0x${string}`;
    baseCost: bigint;
    houseFee: bigint;
    referralFee: bigint;
    netAmount: bigint;
    houseEdgeBps: number;
    referralBps: number;
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
    chain: arbitrumSepolia,
    transport: http(env.RPC_URL),
  });

  const wsTransport = env.RPC_WS_URL ? webSocket(env.RPC_WS_URL) : undefined;
  const wsClient = wsTransport
    ? createPublicClient({
        chain: arbitrumSepolia,
        transport: wsTransport,
      })
    : undefined;

  const referralService = await ReferralService.create(
    db,
    publicClient,
    contracts
  );

  const latest = await publicClient.getBlockNumber();
  const startBlock = env.START_BLOCK && /^\d+$/.test(env.START_BLOCK)
    ? BigInt(env.START_BLOCK)
    : latest;
  console.log("Latest block:", latest, "Start block:", startBlock);
  
  let watchers: WatchContractEventReturnType[] = [];
  let lastIndexedBlock = startBlock;
  let lastLogTimestamp = Date.now();
  
  const watchClient = wsClient ?? publicClient;
  
  await backfillSpins(
    publicClient,
    contracts.rouletteAddress,
    contracts.rouletteAbi,
    startBlock,
    latest,
    referralService,
    contracts.jackpotAddress,
    contracts.jackpotAbi,
  );
  await backfillPayments(publicClient, contracts, startBlock, latest);
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
              undefined
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
                where: { requestId: log.args.requestId.toString() },
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
    const paymentWatcher = watchClient.watchContractEvent({
      address: contracts.handlerAddress,
      abi: contracts.handlerAbi,
      eventName: "GameBetProcessed",
      onLogs: async (logs) => {
        const entries = castLogs<GameBetProcessedLog>(logs);
        for (const log of entries) {
          try {
            const txHash = (log.transactionHash ?? ZERO_TX) as Hex;
            const blockNumber = log.blockNumber ?? 0n;
            const assigned =
              log.args.assignedReferrer.toLowerCase() === "0x0000000000000000000000000000000000000000"
                ? null
                : log.args.assignedReferrer.toLowerCase();
    
            // 1) Snapshot payment
            const payment = await db.paymentEvent.upsert({
              where: { txHash },
              update: {},
              create: {
                txHash,
                blockNumber,
                game: log.args.game.toLowerCase(),
                bettor: log.args.bettor.toLowerCase(),
                assignedReferrer: assigned,
                baseCost: log.args.baseCost.toString(),
                houseFee: log.args.houseFee.toString(),
                referralFee: log.args.referralFee.toString(),
                netAmount: log.args.netAmount.toString(),
                houseEdgeBps: log.args.houseEdgeBps,
                referralBps: log.args.referralBps,
              },
            });
    
            // 2) If a roulette bet exists in the same tx, link the referrer onto Bet
            const bet = await db.bet.findFirst({ where: { txHash } });
            if (bet && assigned && bet.referrer !== assigned) {
              await db.bet.update({ where: { id: bet.id }, data: { referrer: assigned } });
            }
            if (bet) {
              await db.paymentEvent.update({
                where: { txHash },
                data: { source: "ROULETTE", requestId: bet.requestId },
              });
            }
    
            // 3) Allocate referral contributions from referralFee
            if (log.args.referralFee > 0n) {
              // Build chain (up-line) by reading on-chain referrers
              // Note: this is kept simple; you can also expose public wrappers in ReferralService
              const chain: Array<{ address: string; level: number; bps: bigint }> = [];
              try {
                // read level bps from contract
                const [levelCountRaw, levelBpsRaw] = (await (watchClient as any).readContract?.({
                  address: contracts.referralAddress,
                  abi: contracts.referralAbi,
                  functionName: "getLevels",
                  args: [],
                })) as [bigint, bigint[]];
    
                const levelCount = Number(levelCountRaw);
                const levelBps = Array.from({ length: levelCount }, (_, i) => BigInt(levelBpsRaw[i] ?? 0n));
    
                // Walk referrer chain
                let current = assigned;
                for (let level = 0; level < levelCount && current; level++) {
                  const bps = levelBps[level] ?? 0n;
                  if (bps > 0n) chain.push({ address: current, level, bps });
                  // climb
                  const next = (await (watchClient as any).readContract?.({
                    address: contracts.referralAddress,
                    abi: contracts.referralAbi,
                    functionName: "getReferrer",
                    args: [current as `0x${string}`],
                  })) as `0x${string}`;
                  current = !next || next.toLowerCase() === "0x0000000000000000000000000000000000000000" ? null : next.toLowerCase();
                }
    
              // Split referralFee across chain by bps (last gets remainder)
              const denom = chain.reduce((acc, e) => acc + e.bps, 0n);
              let remaining = log.args.referralFee;

              let shares: Array<{ referrer: string; level: number; amount: bigint }>;
              if (chain.length === 0) {
                // fallback receiver
                const dr = (await (watchClient as any).readContract?.({
                  address: contracts.referralAddress,
                  abi: contracts.referralAbi,
                  functionName: "defaultReceiver",
                  args: [],
                })) as `0x${string}`;
                let fb = dr && dr.toLowerCase() !== "0x0000000000000000000000000000000000000000"
                  ? dr.toLowerCase()
                  : ((await (watchClient as any).readContract?.({
                      address: contracts.referralAddress,
                      abi: contracts.referralAbi,
                      functionName: "owner",
                      args: [],
                    })) as `0x${string}`).toLowerCase();

                shares = fb
                  ? [{ referrer: fb, level: -1, amount: log.args.referralFee }]
                  : [];
              } else {
                shares = chain.map((e, idx) => {
                  let share = idx === chain.length - 1 ? remaining : (log.args.referralFee * e.bps) / (denom === 0n ? 1n : denom);
                  if (share > remaining) share = remaining;
                  remaining -= share;
                  return { referrer: e.address, level: e.level, amount: share };
                });
              }
    
                // Persist contributions and pending rewards
                await db.$transaction(async (tx) => {
                  for (const s of shares) {
                    if (s.amount <= 0n) continue;
                    await tx.referralContribution.upsert({
                      where: { paymentId_level: { paymentId: payment.id, level: s.level } },
                      update: {
                        referrer: s.referrer,
                        amount: s.amount.toString(),
                        txHash,
                        blockNumber,
                      },
                      create: {
                        paymentId: payment.id,
                        player: log.args.bettor.toLowerCase(),
                        referrer: s.referrer,
                        level: s.level,
                        amount: s.amount.toString(),
                        requestId: bet ? bet.requestId : null,
                        txHash,
                        blockNumber,
                      },
                    });
    
                    await tx.referralReward.upsert({
                      where: { address: s.referrer },
                      update: {
                        pending: { increment: s.amount.toString() },
                        updatedAt: new Date(),
                      },
                      create: {
                        address: s.referrer,
                        pending: s.amount.toString(),
                        claimed: "0",
                        updatedAt: new Date(),
                      },
                    });
                  }
    
                  // Ensure direct referrer stored on Player + edge
                  if (assigned) {
                    await tx.player.upsert({
                      where: { address: log.args.bettor.toLowerCase() },
                      update: { referrer: assigned },
                      create: { address: log.args.bettor.toLowerCase(), referrer: assigned },
                    });
                    await tx.referralEdge.upsert({
                      where: { player: log.args.bettor.toLowerCase() },
                      update: { referrer: assigned, assignedAt: new Date() },
                      create: { player: log.args.bettor.toLowerCase(), referrer: assigned },
                    });
                  }
                });
              } catch (err) {
                console.error("Failed to allocate referral shares", err);
              }
            }
    
            lastIndexedBlock = blockNumber;
            lastLogTimestamp = Date.now();
          } catch (e) {
            console.error("Failed to process GameBetProcessed", e);
          }
        }
      },
      pollingInterval: 1_000,
      onError(error) {
        console.error("GameBetProcessed watcher error", error);
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
      paymentWatcher,
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
        await backfillPayments(publicClient, contracts, lastIndexedBlock, chainTip);

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
      undefined
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
        where: { requestId: log.args.requestId.toString() },
        select: { id: true, wager: true },
      });
    
      if (bet) {
        const wagerStr = typeof bet.wager === "string" ? bet.wager : (bet.wager as any).toString();
        const wager = BigInt(wagerStr);
    
        for (const jl of receipt.logs) {
          if (jl.address?.toLowerCase() !== jackpotAddress.toLowerCase()) continue;
          try {
            const parsed = decodeEventLog({
              abi: jackpotAbi,
              data: jl.data as Hex,
              topics: jl.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
            }) as { eventName: string; args: any };
        
            if (parsed.eventName === "ConsolationPaid") {
              const payout = parsed.args.payout as bigint;
              const bps = wager > 0n ? Number((payout * 10000n) / wager) : 0;
              const exists = await db.jackpotEvent.findFirst({ where: { betId: bet.id, type: "CONSOLATION" } });
              if (!exists) {
                await db.jackpotEvent.create({
                  data: { betId: bet.id, type: "CONSOLATION", tierIndex: null, payout: payout.toString(), consolationMultiplier: bps.toString() },
                });
              }
            } else if (parsed.eventName === "TierWon") {
              const payout = parsed.args.payout as bigint;
              const tierIndex = Number(parsed.args.tierIndex);
              const exists = await db.jackpotEvent.findFirst({ where: { betId: bet.id, type: "TIER" } });
              if (!exists) {
                await db.jackpotEvent.create({
                  data: { betId: bet.id, type: "TIER", tierIndex, payout: payout.toString(), consolationMultiplier: null },
                });
              }
            } else if (parsed.eventName === "JackpotWon") {
              const payout = parsed.args.payout as bigint;
              const exists = await db.jackpotEvent.findFirst({ where: { betId: bet.id, type: "JACKPOT" } });
              if (!exists) {
                await db.jackpotEvent.create({
                  data: { betId: bet.id, type: "JACKPOT", tierIndex: null, payout: payout.toString(), consolationMultiplier: null },
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
async function backfillPayments(
  client: ReturnType<typeof createPublicClient>,
  contracts: {
    handlerAddress: `0x${string}`;
    handlerAbi: readonly any[];
    referralAddress: `0x${string}`;
    referralAbi: readonly any[];
  },
  fromBlock: bigint,
  toBlock: bigint,
) {
  const paymentLogs = castLogs<GameBetProcessedLog>(
    await client.getContractEvents({
      address: contracts.handlerAddress,
      abi: contracts.handlerAbi,
      eventName: "GameBetProcessed",
      fromBlock,
      toBlock,
    })
  );

  for (const log of paymentLogs) {
    try {
      const txHash = (log.transactionHash ?? ZERO_TX) as Hex;
      const blockNumber = log.blockNumber ?? toBlock;
      const assigned =
        log.args.assignedReferrer.toLowerCase() === "0x0000000000000000000000000000000000000000"
          ? null
          : log.args.assignedReferrer.toLowerCase();

      // 1) Snapshot payment
      const payment = await db.paymentEvent.upsert({
        where: { txHash },
        update: {},
        create: {
          txHash,
          blockNumber,
          game: log.args.game.toLowerCase(),
          bettor: log.args.bettor.toLowerCase(),
          assignedReferrer: assigned,
          baseCost: log.args.baseCost.toString(),
          houseFee: log.args.houseFee.toString(),
          referralFee: log.args.referralFee.toString(),
          netAmount: log.args.netAmount.toString(),
          houseEdgeBps: log.args.houseEdgeBps,
          referralBps: log.args.referralBps,
        },
      });

      // 2) Correlate roulette bet (same tx) and set Bet.referrer
      const bet = await db.bet.findFirst({ where: { txHash } });
      if (bet && assigned && bet.referrer !== assigned) {
        await db.bet.update({ where: { id: bet.id }, data: { referrer: assigned } });
      }
      if (bet) {
        await db.paymentEvent.update({
          where: { txHash },
          data: { source: "ROULETTE", requestId: bet.requestId },
        });
      }

      // 3) Allocate referral contributions
      if (log.args.referralFee > 0n) {
        // Load levels
        const [levelCountRaw, levelBpsRaw] = (await client.readContract({
          address: contracts.referralAddress,
          abi: contracts.referralAbi,
          functionName: "getLevels",
          args: [],
        })) as unknown as [bigint, bigint[]];

        const levelCount = Number(levelCountRaw);
        const levelBps = Array.from({ length: levelCount }, (_, i) => BigInt(levelBpsRaw[i] ?? 0n));

        // Build chain starting at assigned
        const chain: Array<{ address: string; level: number; bps: bigint }> = [];
        let current = assigned;
        for (let level = 0; level < levelCount && current; level++) {
          const bps = levelBps[level] ?? 0n;
          if (bps > 0n) chain.push({ address: current, level, bps });

          const next = (await client.readContract({
            address: contracts.referralAddress,
            abi: contracts.referralAbi,
            functionName: "getReferrer",
            args: [current as `0x${string}`],
          })) as unknown as `0x${string}`;

          current =
            !next || next.toLowerCase() === "0x0000000000000000000000000000000000000000"
              ? null
              : next.toLowerCase();
        }

        // Split referralFee across chain (last receives remainder)
        const denom = chain.reduce((acc, e) => acc + e.bps, 0n);
        let remaining = log.args.referralFee;
        let shares = chain.map((e, idx) => {
          let share =
            idx === chain.length - 1 ? remaining : (log.args.referralFee * e.bps) / (denom === 0n ? 1n : denom);
          if (share > remaining) share = remaining;
          remaining -= share;
          return { referrer: e.address, level: e.level, amount: share };
        });

        // If there is no chain (no assigned referrer / zero bps), allocate to fallback receiver
        if (chain.length === 0) {
          try {
            const dr = (await client.readContract({
              address: contracts.referralAddress,
              abi: contracts.referralAbi,
              functionName: "defaultReceiver",
              args: [],
            })) as unknown as `0x${string}`;
            let fb: string | null =
              dr && dr.toLowerCase() !== "0x0000000000000000000000000000000000000000"
                ? dr.toLowerCase()
                : null;
            if (!fb) {
              const owner = (await client.readContract({
                address: contracts.referralAddress,
                abi: contracts.referralAbi,
                functionName: "owner",
                args: [],
              })) as unknown as `0x${string}`;
              fb = owner ? owner.toLowerCase() : null;
            }
            if (fb) {
              shares = [{ referrer: fb, level: -1, amount: log.args.referralFee }];
            } else {
              shares = [];
            }
          } catch {
            shares = [];
          }
        }

        // Persist contributions and pending rewards
        await db.$transaction(async (tx) => {
          for (const s of shares) {
            if (s.amount <= 0n) continue;

            await tx.referralContribution.upsert({
              where: { paymentId_level: { paymentId: payment.id, level: s.level } },
              update: {
                referrer: s.referrer,
                amount: s.amount.toString(),
                txHash,
                blockNumber,
              },
              create: {
                paymentId: payment.id,
                player: log.args.bettor.toLowerCase(),
                referrer: s.referrer,
                level: s.level,
                amount: s.amount.toString(),
                requestId: bet ? bet.requestId : null,
                txHash,
                blockNumber,
              },
            });

            await tx.referralReward.upsert({
              where: { address: s.referrer },
              update: {
                pending: { increment: s.amount.toString() },
                updatedAt: new Date(),
              },
              create: {
                address: s.referrer,
                pending: s.amount.toString(),
                claimed: "0",
                updatedAt: new Date(),
              },
            });
          }

          // Ensure Player.referrer and ReferralEdge
          if (assigned) {
            await tx.player.upsert({
              where: { address: log.args.bettor.toLowerCase() },
              update: { referrer: assigned },
              create: { address: log.args.bettor.toLowerCase(), referrer: assigned },
            });
            await tx.referralEdge.upsert({
              where: { player: log.args.bettor.toLowerCase() },
              update: { referrer: assigned, assignedAt: new Date() },
              create: { player: log.args.bettor.toLowerCase(), referrer: assigned },
            });
          }
        });
      }
    } catch (e) {
      console.error("Failed to backfill GameBetProcessed", e);
    }
  }
}
main().catch((error) => {
  console.error("Indexer failed", error);
  process.exit(1);
});