import { Router } from "express";
import { z } from "zod";
import { db } from "../../db.js";
import { fetchBets } from "../../services/queryService.js";
import { fetchBetByIdentifiers, fetchBetsByGame, normalizePayment } from "../../services/queryService.js";
export const betsRouter = Router();

// GET /api/bets?player=0x..&cursor=&limit=
betsRouter.get("/", async (req, res) => {
  try {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    const cursor = z.string().optional().parse(req.query.cursor);
    const player = z.string().optional().parse(req.query.player);
    const status = z.enum(["PENDING", "RESOLVED", "FAILED"]).optional().parse(req.query.status);

    const data = await fetchBets(db, {
      cursor,
      limit,
      filter: { player: player ?? undefined, status: status ?? undefined },
    });
    res.json(data);
  } catch (e: any) {
    res.status(400).json({ error: e.message ?? "Bad request" });
  }
});

// GET /api/bets/detail?id=&requestId=&txHash=
betsRouter.get("/detail", async (req, res) => {
  try {
    const id = z.string().optional().parse(req.query.id);
    const requestId = z.string().optional().parse(req.query.requestId);
    const txHash = z.string().optional().parse(req.query.txHash);

    if (!id && !requestId && !txHash) {
      return res.status(400).json({ error: "Provide id, requestId, or txHash" });
    }

    const bet = await fetchBetByIdentifiers(db, { id: id ?? undefined, requestId: requestId ?? undefined, txHash: txHash?.toLowerCase() });
    if (bet) return res.json({ kind: "bet", data: bet });

    // fallback: if a direct (non-roulette) bet was recorded as a payment only
    if (txHash) {
      const payment = await db.paymentEvent.findUnique({ where: { txHash: txHash.toLowerCase() } });
      if (payment) return res.json({ kind: "payment", data: normalizePayment(payment) });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (e: any) {
    res.status(400).json({ error: e.message ?? "Bad request" });
  }
});

// GET /api/bets/by-game?game=0x..&cursor=&limit=
betsRouter.get("/by-game", async (req, res) => {
  try {
    const game = z.string().min(1).parse(req.query.game);
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    const cursor = z.string().optional().parse(req.query.cursor);

    const data = await fetchBetsByGame(db, { game, limit, cursor });
    res
      .type("application/json")
      .send(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch (e: any) {
    res.status(400).json({ error: e.message ?? "Bad request" });
  }
});

betsRouter.get("/result", async (req, res) => {
  try {
    const requestId = z.string().min(1).parse(req.query.requestId);
    const bet = await fetchBetByIdentifiers(db, { requestId });

    // Shape exactly like your GraphQL selection; avoid any BigInt/extra fields
    const shaped = bet
      ? {
          id: bet.id,
          requestId: bet.requestId,
          player: bet.player,
          referrer: bet.referrer ?? null,
          blockNumber: bet.blockNumber,
          txHash: bet.txHash,
          wager: bet.wager,
          netStake: bet.netStake,
          jackpotContribution: bet.jackpotContribution,
          multiplierHundredths: bet.multiplierHundredths,
          status: bet.status,
          createdAt: bet.createdAt,
          updatedAt: bet.updatedAt,
          completedAt: bet.completedAt,
          outcome: bet.outcome
            ? {
                outcome: bet.outcome.outcome,
                payout: bet.outcome.payout,                    // string
                jackpotPayout: Number(bet.outcome.jackpotPayout), // number
                jackpotResult: bet.outcome.jackpotResult,
                jackpotConsolationMultiplier: bet.outcome.jackpotConsolationMultiplier,
                spinsConsumed: bet.outcome.spinsConsumed,
                fulfillTx: bet.outcome.fulfillTx,
                failureReason: bet.outcome.failureReason,
                resolvedAt: bet.outcome.resolvedAt,
                netResult: bet.outcome.netResult,              // string
              }
            : null,
        }
      : null;

    res
      .type("application/json")
      .send(JSON.stringify({ data: { bet: shaped } }));
  } catch (e: any) {
    res.status(400).json({ error: e.message ?? "Bad request" });
  }
});