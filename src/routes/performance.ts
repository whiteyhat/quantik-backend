import { Router, Request } from "express";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { AttributionEngine } from "../monitoring/attribution";
import { DriftDetection } from "../monitoring/drift";
import { ModelCalibration } from "../monitoring/calibration";
import { getUserIdAsync } from "../middleware/auth";
import { loadPortfolioSnapshot, loadToolExecutionContextByAgentId } from "../agents/snapshots";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";

const router = Router();
const attributionEngine = new AttributionEngine();
const driftDetection = new DriftDetection();
const modelCalibration = new ModelCalibration();

router.get("/summary", async (req: Request, res) => {
  try {
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    const context = linkedAgent?.agentId
      ? await loadToolExecutionContextByAgentId(linkedAgent.agentId, userId)
      : null;
    const snapshot = await loadPortfolioSnapshot(context);
    const attribution = attributionEngine.getAttributionBySignal();
    const alphaDecay = attributionEngine.getAlphaDecayStatus();

    res.json({
      ...snapshot,
      attribution,
      alphaDecay,
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
      const fillPrice = e.fill_price ?? 0.5;
      const isLiveNoBet = e.side === "sell" && e.status !== "paper";
      const entryYes = isLiveNoBet ? 1 - fillPrice : fillPrice;
      const currentYes = livePrice.get(e.slug) ?? entryYes;
      const pnl = e.side === "buy"
        ? (currentYes - entryYes) * (e.amount / Math.max(0.01, entryYes))
        : (entryYes - currentYes) * (e.amount / Math.max(0.01, 1 - entryYes));

      let outcome = "OPEN";
      if (e.pnl !== null) outcome = e.pnl > 0 ? "WIN" : "LOSS";
      else if (e.status === "failed") outcome = "LOSS";

      return {
        id: e.id,
        slug: e.slug,
        market: e.slug.split("-").map((w: any) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        direction: e.side === "buy" ? "YES" : "NO",
        size: e.amount,
        price: entryYes,
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
