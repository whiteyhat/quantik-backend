import { Router } from "express";
import { getDb } from "../db/schema";
import { runClause, ClauseResult, ClauseMarketInput } from "../clause";
import { fetchMarketBySlug, withTimeout } from "../utils/market-fetch";

const router = Router();

// GET /api/clause/status
router.get("/status", (req, res) => {
  try {
    const db = getDb();
    const countRow = db.prepare("SELECT count(*) as count FROM clause_results").get() as { count: number };
    const latestRow = db.prepare("SELECT MAX(scoredAt) as lastScoredAt FROM clause_results").get() as { lastScoredAt: number | null };

    res.json({
      status: "active",
      totalMarketsScored: countRow.count,
      lastScoredAt: latestRow.lastScoredAt || null,
      mockMode: process.env.CLAUSE_MOCK === "true",
      engine: "gemini-3.5-flash-lite"
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/clause/:slug — re-runs Clause for a market
router.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const market = await fetchMarketBySlug(slug);
    const input: ClauseMarketInput = {
      slug,
      question: market.question,
      description: market.description,
      days_to_resolution: market.days_to_resolution,
    };
    const result = await withTimeout(runClause(input), 30_000);
    return res.json(result);
  } catch {
    // Fallback to latest DB result
    try {
      const db = getDb();
      const row = db.prepare("SELECT * FROM clause_results WHERE marketSlug = ?").get(slug) as any;
      if (!row) {
        return res.status(404).json({ error: "Market not scored by Clause yet" });
      }
      const result: ClauseResult = {
        marketSlug: row.marketSlug,
        scoredAt: row.scoredAt,
        ambiguityScore: row.ambiguityScore,
        riskLevel: row.riskLevel,
        veto: Boolean(row.veto),
        ambiguityFlags: JSON.parse(row.ambiguityFlags),
        technicality_risks: JSON.parse(row.technicality_risks),
        resolutionCriteria: row.resolutionCriteria,
        disputeHistory: Boolean(row.disputeHistory),
        urgent: Boolean(row.urgent),
        confidence: row.confidence
      };
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST /api/clause/run
router.post("/run", async (req, res) => {
  try {
    const { slug, question, description, days_to_resolution } = req.body;

    if (!slug || !question) {
      return res.status(400).json({ error: "Missing required fields: slug, question" });
    }

    const market: ClauseMarketInput = {
      slug,
      question,
      description: description || "",
      days_to_resolution: days_to_resolution || 30 // default if missing
    };

    const result = await runClause(market);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
