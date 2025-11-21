import { BetStatus, OutcomeType, Prisma, PrismaClient } from "@prisma/client";

function bigIntToDecimalString(value: bigint) {
  return value.toString();
}

type SpinStartedPayload = {
  requestId: bigint;
  player: `0x${string}`;
  wager: bigint;
  netStake: bigint;
  jackpotContribution: bigint;
  multiplierHundredths: number;
  blockNumber: number;
  txHash: `0x${string}`;
};

type SpinResolvedPayload = {
  requestId: bigint;
  outcome: number;
  payout: bigint;
  jackpotPayout: bigint;
  spinsConsumed: number;
  fulfillTx: `0x${string}`;
  failureReason?: string;
};

export async function upsertBet(
  db: PrismaClient,
  payload: SpinStartedPayload,
  referrer?: string
) {
  const playerAddress = payload.player.toLowerCase();
  await db.bet.upsert({
    where: { requestId: payload.requestId.toString() },
    update: {
      player: playerAddress,
      referrer: referrer?.toLowerCase() ?? undefined,
      blockNumber: BigInt(payload.blockNumber),
      txHash: payload.txHash,
      wager: payload.wager.toString(),
      netStake: payload.netStake.toString(),
      jackpotContribution: payload.jackpotContribution.toString(),
      multiplierHundredths: payload.multiplierHundredths,
      status: BetStatus.PENDING,
    },
    create: {
      requestId: payload.requestId.toString(),
      player: playerAddress,
      blockNumber: BigInt(payload.blockNumber),
      txHash: payload.txHash,
      wager: payload.wager.toString(),
      netStake: payload.netStake.toString(),
      jackpotContribution: payload.jackpotContribution.toString(),
      multiplierHundredths: payload.multiplierHundredths,
      status: BetStatus.PENDING,
      referrer: referrer?.toLowerCase(),
    },
  });

  await db.player.upsert({
    where: { address: playerAddress },
    update: {
      totalContribution: { increment: payload.jackpotContribution.toString() },
      lastContribution: new Date(),
    },
    create: {
      address: playerAddress,
      totalContribution: payload.jackpotContribution.toString(),
      lastContribution: new Date(),
    },
  });
}

export async function resolveBet(
  db: PrismaClient,
  payload: SpinResolvedPayload
) {
  const outcomeType =
    payload.outcome === 0
      ? OutcomeType.LOSE
      : payload.outcome === 1
      ? OutcomeType.MULTIPLIER
      : OutcomeType.JACKPOT;

  const status = payload.failureReason ? BetStatus.FAILED : BetStatus.RESOLVED;

  const existing = await db.bet.findUnique({
    where: { requestId: payload.requestId.toString() },
    select: { netStake: true },
  });

  const netStakeDecimal = existing?.netStake ?? new Prisma.Decimal(0);
  const netStakeBigInt = BigInt(netStakeDecimal.toString());

  const bet = await db.bet.update({
    where: { requestId: payload.requestId.toString() },
    data: {
      status,
      completedAt: new Date(),
      outcome: {
        upsert: {
          create: {
            outcome: outcomeType,
            payout: payload.payout.toString(),
            jackpotPayout: payload.jackpotPayout.toString(),
            spinsConsumed: payload.spinsConsumed,
            fulfillTx: payload.fulfillTx,
            failureReason: payload.failureReason,
          },
          update: {
            outcome: outcomeType,
            payout: payload.payout.toString(),
            jackpotPayout: payload.jackpotPayout.toString(),
            spinsConsumed: payload.spinsConsumed,
            fulfillTx: payload.fulfillTx,
            failureReason: payload.failureReason,
            resolvedAt: new Date(),
          },
        },
      },
    },
    include: { outcome: true },
  });

  const wagerString = bet.wager?.toString() ?? "0";

  await db.player.upsert({
    where: { address: bet.player },
    update: {
      totalBets: { increment: 1 },
      totalWager: { increment: wagerString },
      totalPayout: { increment: payload.payout.toString() },
      totalJackpot: { increment: payload.jackpotPayout.toString() },
      netResult: {
        increment: (
          payload.payout +
          payload.jackpotPayout -
          netStakeBigInt
        ).toString(),
      },
      lastActive: new Date(),
    },
    create: {
      address: bet.player,
      totalBets: 1,
      totalWager: wagerString,
      totalPayout: payload.payout.toString(),
      totalJackpot: payload.jackpotPayout.toString(),
      netResult: (
        payload.payout +
        payload.jackpotPayout -
        netStakeBigInt
      ).toString(),
      lastActive: new Date(),
    },
  });
}
