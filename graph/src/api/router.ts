import { Router } from "express";
import { referralsRouter } from "./controllers/referrals.js";
import { playersRouter } from "./controllers/players.js";
import { betsRouter } from "./controllers/bets.js";

export const apiRouter = Router();

// Health
apiRouter.get("/health", (_req, res) => res.json({ ok: true }));

// Namespaced routes
apiRouter.use("/referrals", referralsRouter);
apiRouter.use("/players", playersRouter);
apiRouter.use("/bets", betsRouter);