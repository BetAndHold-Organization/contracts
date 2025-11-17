import { Router } from "express";
import { z } from "zod";
import { db } from "../../db.js";
import { fetchBets } from "../../services/queryService.js";

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