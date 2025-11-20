import { Router } from "express";
import { z } from "zod";
import { db } from "../../db.js";
import { fetchReferralContributions, fetchReferralTree } from "../../services/queryService.js";

export const referralsRouter = Router();

const addressSchema = z.object({
  address: z.string().min(1),
});

const contributionsSchema = z.object({
  address: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

// GET /api/referrals/tree?address=0x..&depth=5
referralsRouter.get("/tree", async (req, res) => {
  try {
    const address = z.string().min(1).parse(req.query.address);
    const depth = z.coerce.number().int().min(1).max(10).default(5).parse(req.query.depth);
    const nodes = await fetchReferralTree(db, address, depth);
    res.json({ address, depth, nodes });
  } catch (e: any) {
    res.status(400).json({ error: e.message ?? "Bad request" });
  }
});

// GET /api/referrals/contributions?address=0x..&limit=50
referralsRouter.get("/contributions", async (req, res) => {
  try {
    const { address, limit } = contributionsSchema.parse(req.query);
    const data = await fetchReferralContributions(db, address, limit);

    // Include simple aggregations (totals per payer and per referrer)
    const totalsByPayer = Object.entries(
      data.asReferrer.reduce<Record<string, bigint>>((acc, e: any) => {
        acc[e.player] = (acc[e.player] ?? 0n) + BigInt(e.amount);
        return acc;
      }, {})
    ).map(([player, total]) => ({ player, total: total.toString() }));

    const totalsByReferrer = Object.entries(
      data.asPlayer.reduce<Record<string, bigint>>((acc, e: any) => {
        const key = e.referrer ?? "—";
        acc[key] = (acc[key] ?? 0n) + BigInt(e.amount);
        return acc;
      }, {})
    ).map(([referrer, total]) => ({ referrer, total: total.toString() }));

    const payload = { address, limit, data, totalsByPayer, totalsByReferrer };
    res
    .type("application/json")
    .send(JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
  } catch (e: any) {
    res.status(400).json({ error: e.message ?? "Bad request" });
  }
});

referralsRouter.get("/dashboard", async (req, res) => {
    try {
      const address = z.string().min(1).parse(req.query.address);
      const limit = z.coerce.number().int().min(1).max(5000).default(1000).parse(req.query.limit);
      const normalized = address.toLowerCase();
  
      const [reward, rows] = await Promise.all([
        db.referralReward.findUnique({ where: { address: normalized } }),
        db.referralContribution.findMany({
          where: { referrer: normalized },
          orderBy: { createdAt: "desc" },
          take: limit,
          select: { player: true, amount: true },
        }),
      ]);
  
      const pending = reward?.pending?.toFixed?.(0) ?? "0";
      const claimed = reward?.claimed?.toFixed?.(0) ?? "0";
      const totalsByPayer = Object.entries(
        rows.reduce<Record<string, bigint>>((acc, r: any) => {
          const p = String(r.player).toLowerCase();
          acc[p] = (acc[p] ?? 0n) + BigInt(r.amount.toString());
          return acc;
        }, {})
      ).map(([player, total]) => ({ player, total: total.toString() }));
  
      res.json({
        address: normalized,
        totals: {
          totalGenerated: (BigInt(pending) + BigInt(claimed)).toString(),
          pending,
          claimed,
        },
        totalsByPayer,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message ?? "Bad request" });
    }
  });