import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { runOracle } from "../oracle";
import { detectCombinatorial } from "../oracle/arb-detector";

const router = Router();

// GET /api/oracle/:slug
router.get("/:slug", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const db = getDb();
    const row = db.prepare("SELECT * FROM oracle_results WHERE market_slug = ? ORDER BY scored_at DESC LIMIT 1").get(slug);
    const result: any = row;
    
    if (!result) {
      return res.status(404).json({ error: "No oracle result found for this market" });
    }

    // Parse JSON columns
    if (result.cross_market_signals) {
      result.cross_market_signals = JSON.parse(result.cross_market_signals as string);
    }
    // Convert integers back to booleans
    result.cross_market_divergence = !!result.cross_market_divergence;
    result.arb_detected = !!result.arb_detected;
    result.longshot_adjusted = !!result.longshot_adjusted;

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/oracle/run
router.post("/run", async (req: Request, res: Response) => {
  try {
    const market = req.body;
    if (!market || !market.slug) {
      return res.status(400).json({ error: "market.slug is required" });
    }
    const result = await runOracle(market);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/oracle/arb
router.get("/arb/:slug", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const result = await detectCombinatorial(slug);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/oracle/status
router.get("/status", (req: Request, res: Response) => {
  try {
    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) as count FROM oracle_results").get() as { count: number };
    res.json({
      status: "running",
      results_count: count.count,
      mock_mode: process.env.ORACLE_MOCK === "true",
      timestamp: Date.now()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
