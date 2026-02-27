import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { runEdge } from "../edge";
import { fetchMarketBySlug, withTimeout } from "../utils/market-fetch";

const router = Router();

// GET /api/edge/status
router.get("/status", (req: Request, res: Response) => {
  res.json({
    agent: "edge",
    status: "active",
    mock_mode: process.env.EDGE_MOCK === "true",
  });
});

// GET /api/edge/:slug — re-runs Edge for a market (needs latest Oracle result from DB)
router.get("/:slug", async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  try {
    const market = await fetchMarketBySlug(slug);
    const db = getDb();
    const oracleRow = db.prepare("SELECT * FROM oracle_results WHERE market_slug = ? ORDER BY scored_at DESC LIMIT 1").get(slug) as any;
    const oracleResult = oracleRow
      ? { calibrated_prob: oracleRow.calibrated_prob, raw_prob: oracleRow.raw_prob, market_implied: oracleRow.market_implied, confidence: oracleRow.confidence, days_to_resolution: oracleRow.days_to_resolution }
      : { calibrated_prob: market.yes_price, market_implied: market.yes_price, confidence: 0.5, days_to_resolution: market.days_to_resolution };
    const result = await withTimeout(runEdge({ slug }, oracleResult), 10_000);
    return res.json(result);
  } catch {
    // Fallback to latest DB result
    const db = getDb();
    const row = db.prepare("SELECT * FROM edge_results WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1").get(slug);
    if (!row) {
      return res.status(404).json({ error: "No edge result found for this market" });
    }
    const rowAny = row as any;
    res.json({
      ...rowAny,
      time_decay_watch: Boolean(rowAny.time_decay_watch),
      corr_blocked: Boolean(rowAny.corr_blocked),
      arb_opportunities: JSON.parse(rowAny.arb_opportunities as string),
    });
  }
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
