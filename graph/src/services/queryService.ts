import { PrismaClient, BetStatus, Prisma } from "@prisma/client";

function toBigInt(
  value: Prisma.Decimal | bigint | number | string | null | undefined
): bigint {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string")
    return value.includes("e") || value.includes("E")
      ? BigInt(new Prisma.Decimal(value).toFixed(0))
      : BigInt(value);
  if (value instanceof Prisma.Decimal) {
    return BigInt(value.toFixed(0));
  }
  throw new Error(`Unsupported numeric type: ${value}`);
}

function decimalToString(
  value: Prisma.Decimal | bigint | number | string | null | undefined
): string {
  if (value == null) return "0";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return BigInt(Math.trunc(value)).toString();
  if (value instanceof Prisma.Decimal) return value.toFixed(0);
  return String(value);
}

export async function fetchMetrics(db: PrismaClient) {
  const [counts, wagerSum, payoutSum, jackpotSum, multiplierSum] =
    await Promise.all([
      db.bet.count(),
      db.bet.aggregate({
        _sum: { wager: true, jackpotContribution: true, netStake: true },
      }),
      db.betOutcome.aggregate({ _sum: { payout: true } }),
      db.betOutcome.aggregate({ _sum: { jackpotPayout: true } }),
      db.bet.aggregate({ _sum: { multiplierHundredths: true } }),
    ]);

  const totalWager = toBigInt(wagerSum._sum.wager);
  const totalJackpotContribution = toBigInt(wagerSum._sum.jackpotContribution);
  const totalNetStake = toBigInt(wagerSum._sum.netStake);
  const totalMultiplierHundredths =
    multiplierSum._sum.multiplierHundredths ?? 0n;

  return {
    totalBets: counts,
    totalWager,
    totalPayout: toBigInt(payoutSum._sum.payout),
    totalJackpotPayout: toBigInt(jackpotSum._sum.jackpotPayout),
    houseFee: totalWager - totalNetStake - totalJackpotContribution,
    referralFee: totalJackpotContribution,
    jackpotBalance: 0n,
    rouletteBalance: 0n,
    houseNet: totalNetStake,
    avgWager: counts > 0 ? Number(totalWager) / counts / 1e18 : 0,
    avgMultiplier:
      counts > 0 ? Number(totalMultiplierHundredths) / counts / 100 : 0,
  };
}

type BetFilter = {
  status?: BetStatus;
  player?: string;
  referrer?: string;
  txHash?: string;
  minBlock?: number;
  maxBlock?: number;
};

export async function fetchBets(
  db: PrismaClient,
  args: { filter?: BetFilter; cursor?: string; limit?: number }
) {
  const take = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const where: Prisma.BetWhereInput = {};
  if (args.filter?.status) where.status = args.filter.status;
  if (args.filter?.player) where.player = args.filter.player.toLowerCase();
  if (args.filter?.referrer)
    where.referrer = args.filter.referrer.toLowerCase();
  if (args.filter?.txHash) where.txHash = args.filter.txHash.toLowerCase();
  if (args.filter?.minBlock || args.filter?.maxBlock) {
    where.blockNumber = {};
    if (args.filter.minBlock)
      where.blockNumber.gte = BigInt(args.filter.minBlock);
    if (args.filter.maxBlock)
      where.blockNumber.lte = BigInt(args.filter.maxBlock);
  }

  const bets = await db.bet.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
    skip: args.cursor ? 1 : 0,
    cursor: args.cursor ? { id: args.cursor } : undefined,
    include: { outcome: true, jackpotEvents: true },
  });

  const totalCount = await db.bet.count({ where });
  const nextCursor = bets.length === take ? bets[bets.length - 1].id : null;

  return {
    nodes: bets.map((bet) => {
      const normalized = normalizeBet(bet);
      const { jackpotResult, jackpotConsolationMultiplier } =
        deriveJackpotOutcome(bet.jackpotEvents);

      return {
        ...normalized,
        outcome: bet.outcome
          ? {
              ...normalized.outcome,
              jackpotResult,
              jackpotConsolationMultiplier,
            }
          : null,
      };
    }),
    totalCount,
    nextCursor,
  };
}

export async function fetchBetByIdentifiers(
  db: PrismaClient,
  args: { id?: string; requestId?: string; txHash?: string }
) {
  const orClauses: Prisma.BetWhereInput[] = [];
  if (args.id) orClauses.push({ id: args.id });
  if (args.requestId) orClauses.push({ requestId: BigInt(args.requestId) });
  if (args.txHash) orClauses.push({ txHash: args.txHash.toLowerCase() });
  const bet = await db.bet.findFirst({
    where: {
      OR: orClauses,
    },
    include: { outcome: true, jackpotEvents: true }, // NEW
  });
  if (!bet) return null;

  const normalized = normalizeBet(bet);
  const { jackpotResult, jackpotConsolationMultiplier } =
    deriveJackpotOutcome(bet.jackpotEvents);

  return bet.outcome
    ? {
        ...normalized,
        outcome: {
          ...normalized.outcome,
          jackpotResult,
          jackpotConsolationMultiplier,
        },
      }
    : normalized;
}

export async function fetchPlayer(db: PrismaClient, address: string) {
  const player = await db.player.findUnique({
    where: { address: address.toLowerCase() },
  });
  if (!player) return null;
  return {
    ...player,
  };
}

export async function fetchPlayers(
  db: PrismaClient,
  args: { cursor?: string; limit?: number }
) {
  const take = Math.min(Math.max(args.limit ?? 50, 1), 200);

  const players = await db.player.findMany({
    orderBy: [{ totalBets: "desc" }, { address: "asc" }],
    take,
    skip: args.cursor ? 1 : 0,
    cursor: args.cursor ? { address: args.cursor } : undefined,
  });

  const totalCount = await db.player.count();
  const nextCursor =
    players.length === take ? players[players.length - 1].address : null;

  return {
    nodes: players.map((player) => ({
      ...player,
      totalWager: player.totalWager.toFixed(0),
      totalPayout: player.totalPayout.toFixed(0),
      totalJackpot: player.totalJackpot.toFixed(0),
      netResult: player.netResult.toFixed(0),
      totalContribution: player.totalContribution.toFixed(0),
    })),
    totalCount,
    nextCursor,
  };
}

export async function fetchReferralRewards(db: PrismaClient) {
  const rewards = await db.referralReward.findMany({
    orderBy: { pending: "desc" },
  });
  return rewards;
}

export async function fetchReferralTree(
  db: PrismaClient,
  root: string,
  depth: number
) {
  const normalizedRoot = root.toLowerCase();

  const nodes = await db.$queryRaw<
    Array<{ address: string; referrer: string | null; level: number }>
  >`
    WITH RECURSIVE referral_tree AS (
      SELECT player AS address, referrer, 0 AS level
      FROM "ReferralEdge"
      WHERE player = ${normalizedRoot}

      UNION ALL

      SELECT e.player AS address, e.referrer, t.level + 1 AS level
      FROM "ReferralEdge" e
      JOIN referral_tree t ON e.referrer = t.address
      WHERE t.level + 1 <= ${depth}
    )
    SELECT address, referrer, level
    FROM referral_tree
  `;

  return nodes;
}

export async function fetchReferralContributions(
  db: PrismaClient,
  address: string,
  limit: number
) {
  const normalized = address.toLowerCase();

  const [asPlayer, asReferrer] = await Promise.all([
    db.referralContribution.findMany({
      where: { player: normalized },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    db.referralContribution.findMany({
      where: { referrer: normalized },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ]);

  return { asPlayer, asReferrer };
}

export async function fetchJackpotEvents(db: PrismaClient, limit: number) {
  const events = await db.jackpotEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return events.map((event) => ({
    ...event,
    consolationMultiplier: event.consolationMultiplier
      ? Number(event.consolationMultiplier)
      : null,
  }));
}

function normalizeBet(bet: any) {
  const netStake = BigInt(decimalToString(bet.netStake));
  const outcomeData = bet.outcome
    ? {
        ...bet.outcome,
        payout: decimalToString(bet.outcome.payout),
        jackpotPayout: decimalToString(bet.outcome.jackpotPayout),
      }
    : null;
  const payout = outcomeData ? BigInt(outcomeData.payout) : 0n;
  const jackpot = outcomeData ? BigInt(outcomeData.jackpotPayout) : 0n;
  const netResult = payout + jackpot - netStake;

  return {
    ...bet,
    requestId: bet.requestId.toString(),
    blockNumber: Number(bet.blockNumber),
    wager: decimalToString(bet.wager),
    netStake: netStake.toString(),
    jackpotContribution: decimalToString(bet.jackpotContribution),
    outcome: outcomeData
      ? {
          ...outcomeData,
          netResult: netResult.toString(),
        }
      : null,
  };
}

function deriveJackpotOutcome(
  events: Array<{
    type: "TIER" | "JACKPOT" | "CONSOLATION";
    consolationMultiplier: any | null;
  }>
): { jackpotResult: string; jackpotConsolationMultiplier: number } {
  if (!events || events.length === 0) {
    return { jackpotResult: "LOSE", jackpotConsolationMultiplier: 0 };
  }

  const hasConsolation = events.find((e) => e.type === "CONSOLATION");
  if (hasConsolation) {
    const mulRaw = hasConsolation.consolationMultiplier;
    const mul =
      mulRaw == null
        ? 0
        : typeof mulRaw === "string"
        ? Number(mulRaw)
        : Number((mulRaw as any).toString?.() ?? mulRaw);
    return {
      jackpotResult: "CONSOLATION",
      jackpotConsolationMultiplier: mul,
    };
  }

  const hasTier = events.find((e) => e.type === "TIER" || e.type === "JACKPOT");
  if (hasTier) {
    return { jackpotResult: "TIER", jackpotConsolationMultiplier: 0 };
  }

  return { jackpotResult: "LOSE", jackpotConsolationMultiplier: 0 };
}
export function normalizePayment(p: any) {
  return {
    ...p,
    blockNumber: Number(p.blockNumber),
    baseCost: decimalToString(p.baseCost),
    houseFee: decimalToString(p.houseFee),
    referralFee: decimalToString(p.referralFee),
    netAmount: decimalToString(p.netAmount),
  };
}
export async function fetchBetsByGame(
  db: PrismaClient,
  args: { game: string; cursor?: string; limit?: number }
) {
  const take = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const game = args.game.toLowerCase();

  const payments = await db.paymentEvent.findMany({
    where: { game },
    orderBy: { createdAt: "desc" },
    take,
    skip: args.cursor ? 1 : 0,
    cursor: args.cursor ? { id: args.cursor } : undefined,
  });

  const totalCount = await db.paymentEvent.count({ where: { game } });
  const nextCursor = payments.length === take ? payments[payments.length - 1].id : null;

  const txHashes = payments.map((p) => p.txHash);
  const bets = await db.bet.findMany({
    where: { txHash: { in: txHashes } },
    include: { outcome: true, jackpotEvents: true },
  });

  const betByTx = new Map(bets.map((b) => [b.txHash, b]));

  const nodes = payments.map((p) => {
    const payment = normalizePayment(p);
    const bet = betByTx.get(p.txHash);
    if (!bet) {
      return { payment, bet: null };
    }
    const normalized = normalizeBet(bet as any);
    const { jackpotResult, jackpotConsolationMultiplier } = deriveJackpotOutcome(bet.jackpotEvents as any);
    return {
      payment,
      bet: bet.outcome
        ? { ...normalized, outcome: { ...normalized.outcome, jackpotResult, jackpotConsolationMultiplier } }
        : normalized,
    };
  });

  return { nodes, totalCount, nextCursor };
}