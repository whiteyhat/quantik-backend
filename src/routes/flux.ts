import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { runFlux } from "../flux";
import { fetchMarketBySlug, withTimeout } from "../utils/market-fetch";

const router = Router();

// GET /api/flux/status
router.get("/status", (_req: Request, res: Response) => {
  res.json({
    agent: "flux",
    status: "active",
    mock_mode: process.env.FLUX_MOCK === "true",
  });
});

// GET /api/flux/:slug — re-runs Flux for a market
router.get("/:slug", async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  try {
    const market = await fetchMarketBySlug(slug);
    const result = await withTimeout(
      runFlux({ slug, token_id: market.token_id as string }),
      10_000
    );
    return res.json(result);
  } catch {
    // Fallback to latest DB result
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM flux_results WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1")
      .get(slug) as Record<string, unknown> | undefined;
    if (!row) {
      return res.status(404).json({ error: "No flux result found for this market" });
    }
    res.json({
      ...row,
      whale_detected: Boolean(row.whale_detected),
      grade_degrading: Boolean(row.grade_degrading),
      soft_veto: Boolean(row.soft_veto),
    });
  }
});

// POST /api/flux/run
router.post("/run", async (req: Request, res: Response) => {
  const { market } = req.body;

  if (!market || !market.slug) {
    return res.status(400).json({ error: "Missing market with slug in body" });
  }

  try {
    const result = await runFlux(market);
    res.json(result);
  } catch (error) {
    console.error("Error running Flux:", error);
    res.status(500).json({ error: "Failed to run Flux" });
  }
});

export default router;
