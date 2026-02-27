import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { runEdge } from "../edge";

const router = Router();

// GET /api/edge/status
router.get("/status", (req: Request, res: Response) => {
  res.json({
    agent: "edge",
    status: "active",
    mock_mode: process.env.EDGE_MOCK === "true",
  });
});

// GET /api/edge/:slug
router.get("/:slug", (req: Request, res: Response) => {
  const { slug } = req.params;
  const db = getDb();
  const row = db.prepare("SELECT * FROM edge_results WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1").get(slug);

  if (!row) {
    return res.status(404).json({ error: "No edge result found for this market" });
  }

  // Parse JSON fields
  const rowAny = row as any;
  const result = {
    ...rowAny,
    time_decay_watch: Boolean(rowAny.time_decay_watch),
    corr_blocked: Boolean(rowAny.corr_blocked),
    arb_opportunities: JSON.parse(rowAny.arb_opportunities as string),
  };

  res.json(result);
});

// POST /api/edge/run
router.post("/run", async (req: Request, res: Response) => {
  const { market, oracleResult } = req.body;

  if (!market || !market.slug) {
    return res.status(400).json({ error: "Missing market with slug in body" });
  }

  try {
    const result = await runEdge(market, oracleResult);
    res.json(result);
  } catch (error) {
    console.error("Error running Edge:", error);
    res.status(500).json({ error: "Failed to run Edge" });
  }
});

export default router;
