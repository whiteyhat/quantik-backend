import { Router, Request } from "express";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { AttributionEngine } from "../monitoring/attribution";
import { DriftDetection } from "../monitoring/drift";
import { ModelCalibration } from "../monitoring/calibration";
import { getUserIdAsync } from "../middleware/auth";
import { getWalletFundingSnapshot } from "../utils/balances";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";

const router = Router();
const attributionEngine = new AttributionEngine();
const driftDetection = new DriftDetection();
const modelCalibration = new ModelCalibration();

router.get("/summary", async (req: Request, res) => {
  try {
    const db = getDb();
    const todayStart = new Date().setUTCHours(0, 0, 0, 0);
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    const scopedWhere = (condition?: string) => {
      const scope = linkedAgent ? "agent_id = ?" : "";
      if (scope && condition) return `WHERE ${scope} AND ${condition}`;
      if (scope) return `WHERE ${scope}`;
      if (condition) return `WHERE ${condition}`;
      return "";
    };
    const scopedParams = (...params: unknown[]) => linkedAgent ? [linkedAgent.agentId, ...params] : params;

    // 1. Trades today
    const { tradesToday } = db.prepare(
      `SELECT COUNT(*) AS tradesToday FROM executions ${scopedWhere("executed_at >= ? AND status != 'failed'")}`
    ).get(...scopedParams(todayStart)) as any;

    // 2. P&L Stats
    const { realizedToday } = db.prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS realizedToday FROM executions ${scopedWhere("executed_at >= ? AND status != 'failed' AND pnl IS NOT NULL")}`
    ).get(...scopedParams(todayStart)) as any;
    
    // Unrealized calc
    const openExecs = db.prepare(
      `SELECT slug, side, amount, fill_price FROM executions ${scopedWhere("status IN ('placed', 'paper') AND pnl IS NULL")}`
    ).all(...scopedParams()) as any[];
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
    
    const { total, wins } = db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins FROM executions ${scopedWhere("status != 'failed' AND pnl IS NOT NULL")}`
    ).get(...scopedParams()) as any;

    // 4. RICH DATA: Best/Worst trades, cumulative volume
    const bestTrade = db.prepare(
      `SELECT slug, pnl FROM executions ${scopedWhere("pnl IS NOT NULL")} ORDER BY pnl DESC LIMIT 1`
    ).get(...scopedParams()) as any;
    const worstTrade = db.prepare(
      `SELECT slug, pnl FROM executions ${scopedWhere("pnl IS NOT NULL")} ORDER BY pnl ASC LIMIT 1`
    ).get(...scopedParams()) as any;
    const { totalVolume } = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as totalVolume FROM executions ${scopedWhere("status != 'failed'")}`
    ).get(...scopedParams()) as any;
    
    // Recent trades (fallback for Execution Log)
    const recentTradeRows = db.prepare(
      `SELECT id, slug, side, amount, status, executed_at FROM executions ${scopedWhere("status != 'failed'")} ORDER BY executed_at DESC LIMIT 20`
    ).all(...scopedParams()) as any[];
    const recentTrades = recentTradeRows.map(e => ({
      id: e.id,
      slug: e.slug,
      direction: e.side === "buy" ? "YES" : "NO",
      amount: e.amount,
      status: (e.status ?? "").toUpperCase(),
      executedAt: new Date(e.executed_at).toISOString(),
    }));

    // Win streak
    const lastTrades = db.prepare(
      `SELECT pnl FROM executions ${scopedWhere("pnl IS NOT NULL")} ORDER BY executed_at DESC LIMIT 20`
    ).all(...scopedParams()) as any[];
    let currentStreak = 0;
    if (lastTrades.length > 0) {
      const first = lastTrades[0].pnl > 0;
      for (const t of lastTrades) {
        if ((t.pnl > 0) === first) currentStreak++;
        else break;
      }
      if (!first) currentStreak = -currentStreak;
    }

    // ── WalletBalance fields for manage-agent page ────────────────
    const address = linkedAgent?.walletAddress ?? "";
    const funding = await getWalletFundingSnapshot(address || null);
    const onChainUsdc = funding.onChainUsdc;
    const pol = funding.pol;

    // All-time trade count
    const { totalTradesAll } = db.prepare(
      `SELECT COUNT(*) AS totalTradesAll FROM executions ${scopedWhere("status != 'failed'")}`
    ).get(...scopedParams()) as any;

    // Cumulative realized P&L
    const { totalRealizedPnl } = db.prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS totalRealizedPnl FROM executions ${scopedWhere("pnl IS NOT NULL")}`
    ).get(...scopedParams()) as any;

    const pnlToday = realizedToday + unrealizedToday;
    const cumulativePnl = totalRealizedPnl + unrealizedToday;

    // Deployed capital (sum of open position sizes)
    const deployedCapital = openExecs.reduce((sum, e) => sum + (e.amount ?? 0), 0);

    const trackedPortfolioValue = funding.usdcStatus === "live"
      ? Math.max(onChainUsdc + deployedCapital + unrealizedToday, 0)
      : null;
    const balanceStatus =
      !address ? "no_wallet" :
      funding.usdcStatus !== "live" ? "unavailable" :
      trackedPortfolioValue && trackedPortfolioValue > 0 ? "live" :
      "unfunded";
    const balanceMessage =
      balanceStatus === "no_wallet"
        ? "No wallet assigned to this agent yet."
        : balanceStatus === "unavailable"
          ? "Unable to read the on-chain USDC balance right now."
          : balanceStatus === "unfunded"
            ? "Wallet created but no on-chain USDC balance or tracked open positions detected yet."
            : deployedCapital > 0
              ? "Live on-chain USDC balance plus tracked open exposure."
              : "Live on-chain USDC balance available.";
    const totalValue = trackedPortfolioValue;
    const pnlPct = totalValue && totalValue > 0 ? cumulativePnl / totalValue : null;
    const pnlTodayPct = totalValue && totalValue > 0 ? pnlToday / totalValue : null;
    const winRate = total > 0 ? (wins ?? 0) / total : 0;

    // Circuit breaker status
    const cbRow = db.prepare("SELECT state, drawdown_pct FROM circuit_breaker_state WHERE id = 1").get() as { state: string; drawdown_pct: number } | undefined;
    const circuitBreakerStatus = cbRow?.state ?? "ARMED";

    // Risk config for drawdownLimit and kelly
    const gcb = db.prepare(`
      SELECT drawdown_limit_pct, kelly_fraction_multiplier
      FROM global_circuit_breakers gcb
      JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
      WHERE rc.is_active = 1 LIMIT 1
    `).get() as { drawdown_limit_pct: number; kelly_fraction_multiplier: number } | undefined;

    const kellyMultiplier = gcb?.kelly_fraction_multiplier ?? 0.25;
    const kellyUtilization = totalValue !== null && totalValue > 0 && kellyMultiplier > 0
      ? deployedCapital / (totalValue * kellyMultiplier)
      : 0;

    res.json({
      // WalletBalance fields (used by frontend api.getBalance())
      address,
      usdc: onChainUsdc,
      onChainUsdc,
      onChainUsdcFormatted: onChainUsdc.toFixed(2),
      pol,
      polFormatted: pol.toFixed(4),
      totalValue,
      pnl: cumulativePnl,
      pnlPct,
      winRate,
      totalTrades: totalTradesAll ?? 0,
      pnlToday,
      pnlTodayPct,
      circuitBreakerStatus,
      kellyUtilization,
      drawdown: cbRow?.drawdown_pct ?? 0,
      drawdownLimit: gcb?.drawdown_limit_pct ?? 0.15,
      balanceStatus,
      balanceMessage,
      fundingStatus: funding.fundingStatus,
      fundingMessage: funding.fundingMessage,
      funding_status: funding.fundingStatus,
      funding_message: funding.fundingMessage,
      liveBalanceAvailable: funding.usdcStatus === "live",
      // Existing performance fields
      realizedToday,
      unrealizedToday,
      tradesToday: tradesToday ?? 0,
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

// Trade history (moved from /api/portfolio/attribution)
router.get("/trades", async (req, res) => {
  try {
    const db = getDb();
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    const executions = linkedAgent
      ? db.prepare("SELECT * FROM executions WHERE agent_id = ? ORDER BY executed_at DESC LIMIT 500").all(linkedAgent.agentId)
      : db.prepare("SELECT * FROM executions ORDER BY executed_at DESC LIMIT 500").all() as any[];

    const priceRows2 = db.prepare(
      `SELECT s.slug, s.probability FROM scanner_results s
       INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) t
       ON s.slug = t.slug AND s.scanned_at = t.latest`
    ).all() as any[];
    const livePrice = new Map(priceRows2.map(r => [r.slug, r.probability]));

    const tradeList = executions.map(e => {
      const entry = e.fill_price ?? 0.5;
      const current = livePrice.get(e.slug) ?? entry;
      const shares = entry > 0 ? e.amount / entry : 0;
      const pnl = e.side === "buy" ? (current - entry) * shares : (entry - current) * shares;

      let outcome = "OPEN";
      if (e.pnl !== null) outcome = e.pnl > 0 ? "WIN" : "LOSS";
      else if (e.status === "failed") outcome = "LOSS";

      return {
        id: e.id,
        slug: e.slug,
        market: e.slug.split("-").map((w: any) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        direction: e.side === "buy" ? "YES" : "NO",
        size: e.amount,
        price: entry,
        outcome,
        timestamp: e.executed_at,
        pnl: e.pnl ?? pnl,
        orderId: e.order_id,
        mode: e.status,
      };
    });

    res.json({
      trades: tradeList,
      count: tradeList.length,
      winRate: tradeList.filter(t => t.outcome === "WIN").length / Math.max(tradeList.filter(t => t.outcome !== "OPEN").length, 1)
    });
  } catch (err) {
    console.error("[performance:trades] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
