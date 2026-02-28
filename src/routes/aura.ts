import { Router } from "express";
import { getDb } from "../db/schema";
import { runAura } from "../aura/index";
import { fetchMarketBySlug, withTimeout } from "../utils/market-fetch";

export const auraRouter = Router();

auraRouter.get("/status", (req, res) => {
  const db = getDb();
  const totalRuns = db.prepare("SELECT COUNT(*) as c FROM aura_results").get() as { c: number };
  const lastRun = db.prepare("SELECT scored_at FROM aura_results ORDER BY scored_at DESC LIMIT 1").get() as { scored_at: number } | undefined;

  res.json({
    exaConnected: !!process.env.EXA_API_KEY,
    newsApiConnected: !!process.env.NEWS_API_KEY,
    lastRunAt: lastRun?.scored_at || null,
    totalRuns: totalRuns.c || 0,
  });
});

auraRouter.post("/run", (req, res) => {
  const { slug, question } = req.body;
  if (!slug || !question) {
    return res.status(400).json({ error: "slug and question are required" });
  }

  // Queue run in background
  runAura({ slug, question }).catch(console.error);

  res.json({ queued: true });
});

// GET /api/aura/:slug — re-runs Aura for a market
auraRouter.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const market = await fetchMarketBySlug(slug);
    const result = await withTimeout(
      runAura({ slug, question: market.question, category: market.category }),
      10_000
    );
    return res.json(result);
  } catch {
    // Fallback to latest DB result
    const db = getDb();
    const row = db.prepare("SELECT * FROM aura_results WHERE slug = ? ORDER BY scored_at DESC LIMIT 1").get(slug) as any;
    if (!row) {
      return res.status(404).json({ error: "No aura results found for slug" });
    }
    res.json({
      slug: row.slug,
      scoredAt: row.scored_at,
      sentimentDelta: row.sentiment_delta,
      shiftDetected: !!row.shift_detected,
      shiftDirection: row.shift_direction,
      shiftVelocity: row.shift_velocity,
      shiftTrend: row.shift_trend,
      shiftPersistence: row.shift_persistence,
      twitterSentiment: row.twitter_sentiment,
      twitterVolumeDelta: row.twitter_volume_delta,
      telegramBias: row.telegram_bias,
      breakingNews: !!row.breaking_news,
      newsHeadlines: JSON.parse(row.news_headlines || "[]"),
      searchTrendSpike: !!row.search_trend_spike,
      searchTrendValue: row.search_trend_value,
      whalePosYesPct: row.whale_pos_yes_pct,
      whalePositioning: row.whale_positioning,
      echoChamberRisk: row.echo_chamber_risk,
      dataSufficiency: row.data_sufficiency,
      confidence: row.confidence,
      sourcesUsed: JSON.parse(row.sources_used || "[]"),
      sourceStatus: JSON.parse(row.source_status || "{}"),
    });
  }
});
