import { Router } from "express";
import { getDb } from "../db/schema";
import { AttributionEngine } from "../monitoring/attribution";

const router = Router();
const attributionEngine = new AttributionEngine();

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

    res.json({
      pnlToday: realizedToday + unrealizedToday,
      realizedToday,
      unrealizedToday,
      tradesToday: tradesToday ?? 0,
      winRate: total > 0 ? (wins ?? 0) / total : 0,
      openPositions: openExecs.length,
      attribution,
      alphaDecay,
    });
  } catch (err) {
    console.error("[performance:summary] error:", err);
    res.json({ pnlToday: 0, tradesToday: 0, winRate: 0, openPositions: 0 });
  }
});

export default router;
