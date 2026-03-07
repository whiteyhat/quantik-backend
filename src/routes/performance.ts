import { Router } from "express";
import { getDb } from "../db/schema";
import { AttributionEngine } from "../monitoring/attribution";
import { DriftDetection } from "../monitoring/drift";
import { ModelCalibration } from "../monitoring/calibration";

const router = Router();
const attributionEngine = new AttributionEngine();
const driftDetection = new DriftDetection();
const modelCalibration = new ModelCalibration();

router.get("/summary", async (_req, res) => {
  try {
    const db = getDb();
    const todayStart = new Date().setUTCHours(0, 0, 0, 0);

    // 1. Trades today
    const { tradesToday } = db.prepare("SELECT COUNT(*) AS tradesToday FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayStart) as any;

    // 2. P&L Stats
    const { realizedToday } = db.prepare("SELECT COALESCE(SUM(pnl), 0) AS realizedToday FROM executions WHERE executed_at >= ? AND status != 'failed' AND pnl IS NOT NULL").get(todayStart) as any;
    
    // Unrealized calc
    const openExecs = db.prepare("SELECT slug, side, amount, fill_price FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL").all() as any[];
    const priceRows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as any[];
    const currentPrices = new Map(priceRows.map(r => [r.slug, r.probability]));
    
    let unrealizedToday = 0;
    for (const exec of openExecs) {
      const current = currentPrices.get(exec.slug) ?? exec.fill_price ?? 0.5;
      const entry = exec.fill_price ?? 0.5;
      const shares = entry > 0 ? exec.amount / entry : 0;
      unrealizedToday += exec.side === "buy" ? (current - entry) * shares : (entry - current) * shares;
    }

    // 3. Overall Attribution & Alpha Decay
    const attribution = attributionEngine.getAttributionBySignal();
    const alphaDecay = attributionEngine.getAlphaDecayStatus();
    
    const { total, wins } = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins FROM executions WHERE status != 'failed' AND pnl IS NOT NULL").get() as any;

    // 4. RICH DATA: Best/Worst trades, cumulative volume
    const bestTrade = db.prepare("SELECT slug, pnl FROM executions WHERE pnl IS NOT NULL ORDER BY pnl DESC LIMIT 1").get() as any;
    const worstTrade = db.prepare("SELECT slug, pnl FROM executions WHERE pnl IS NOT NULL ORDER BY pnl ASC LIMIT 1").get() as any;
    const { totalVolume } = db.prepare("SELECT COALESCE(SUM(amount), 0) as totalVolume FROM executions WHERE status != 'failed'").get() as any;
    
    // Recent trades (fallback for Execution Log)
    const recentTradeRows = db.prepare(
      "SELECT id, slug, side, amount, status, executed_at FROM executions WHERE status != 'failed' ORDER BY executed_at DESC LIMIT 20"
    ).all() as any[];
    const recentTrades = recentTradeRows.map(e => ({
      id: e.id,
      slug: e.slug,
      direction: e.side === "buy" ? "YES" : "NO",
      amount: e.amount,
      status: (e.status ?? "").toUpperCase(),
      executedAt: new Date(e.executed_at).toISOString(),
    }));

    // Win streak
    const lastTrades = db.prepare("SELECT pnl FROM executions WHERE pnl IS NOT NULL ORDER BY executed_at DESC LIMIT 20").all() as any[];
    let currentStreak = 0;
    if (lastTrades.length > 0) {
      const first = lastTrades[0].pnl > 0;
      for (const t of lastTrades) {
        if ((t.pnl > 0) === first) currentStreak++;
        else break;
      }
      if (!first) currentStreak = -currentStreak;
    }

    res.json({
      pnlToday: realizedToday + unrealizedToday,
      realizedToday,
      unrealizedToday,
      tradesToday: tradesToday ?? 0,
      winRate: total > 0 ? (wins ?? 0) / total : 0,
      openPositions: openExecs.length,
      recentTrades,
      attribution,
      alphaDecay,
      metrics: {
        bestTrade: bestTrade?.slug ?? "N/A",
        bestPnl: bestTrade?.pnl ?? 0,
        worstTrade: worstTrade?.slug ?? "N/A",
        worstPnl: worstTrade?.pnl ?? 0,
        totalVolume,
        currentStreak,
        avgTradeSize: total > 0 ? totalVolume / total : 0
      }
    });
  } catch (err) {
    console.error("[performance:summary] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/attribution", (_req, res) => {
  const data = attributionEngine.getAttributionBySignal();
  res.json(data);
});

router.get("/brier", (_req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT market_slug as slug, brier_score as score, resolved_at as timestamp FROM resolutions ORDER BY resolved_at DESC LIMIT 50").all();
  res.json(rows);
});

router.get("/drift", (_req, res) => {
  try {
    const microstructure = driftDetection.checkMicrostructureDrift();
    const concept = driftDetection.checkConceptDrift();
    res.json({
      microstructure: microstructure.detected ? "detected" : "clear",
      concept: concept.detected ? "detected" : "clear",
      lastChecked: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/calibration", (_req, res) => {
  try {
    const weights = modelCalibration.getAgentWeights();
    res.json(
      weights.map((w) => ({
        agent: w.agent,
        weight: w.weight,
        confidence: w.brierScore !== null ? Math.max(0, 1 - w.brierScore) : null,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
