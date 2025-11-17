import { Router } from "express";
import { z } from "zod";
import { db } from "../../db.js";
import { fetchPlayers, fetchPlayer } from "../../services/queryService.js";

export const playersRouter = Router();

// GET /api/players?cursor=&limit=
playersRouter.get("/", async (req, res) => {
  try {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    const cursor = z.string().optional().parse(req.query.cursor);
    const data = await fetchPlayers(db, { cursor, limit });
    res.json(data);
  } catch (e: any) {
    res.status(400).json({ error: e.message ?? "Bad request" });
  }
});

// GET /api/players/:address
playersRouter.get("/:address", async (req, res) => {
  try {
    const address = z.string().min(1).parse(req.params.address);
    const player = await fetchPlayer(db, address);
    if (!player) return res.status(404).json({ error: "Not found" });
    res.json(player);
  } catch (e: any) {
    res.status(400).json({ error: e.message ?? "Bad request" });
  }
});