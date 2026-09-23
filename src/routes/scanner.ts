import { Router, Request, Response } from "express";
import { getUserIdAsync } from "../middleware/auth";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";
import { MarketScanner, getScannerStatus } from "../scanner/marketScanner";
import { getDb } from "../db/schema";
import { getCircuitBreaker, getPortfolioManager } from "../risk";
import { getSettings } from "../db/queries";
import { getLatestScannerDirectionMap, resolveExecutionDirection } from "../utils/executionDirection";
import { isPgEnabled, pgQuery, pgQueryOne } from "../db/postgres";

const router = Router();
const scanner = new MarketScanner();
const SCANNER_INTERVAL_MS = 5 * 60 * 1000;

// ── POST /api/scanner/run ──────────────────────────────────────
router.post("/run", async (_req: Request, res: Response) => {
  const status = getScannerStatus();
  if (status.running) {
    res.json({ ok: false, message: "Scan already in progress" });
    return;
  }
  scanner.scan().catch((err) => console.error("[Scanner route] scan error:", err));
  res.json({ ok: true, message: "Scan started" });
});

// ── GET /api/scanner/status ────────────────────────────────────
router.get("/status", async (_req: Request, res: Response) => {
  const s = getScannerStatus();
  const cb = await getCircuitBreaker().getStatus();
  const portfolio = getPortfolioManager();
  const settings = await getSettings();

  const todayStart = new Date().setUTCHours(0, 0, 0, 0);

  let tradesToday = 0;
  if (isPgEnabled()) {
    const row = await pgQueryOne<{ tradestoday: string }>(
      "SELECT COUNT(*) AS tradestoday FROM executions WHERE executed_at >= $1 AND status != 'failed'",
      [todayStart]
    );
    tradesToday = row ? parseInt(row.tradestoday, 10) : 0;
  } else {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) AS tradesToday FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayStart) as any;
    tradesToday = row?.tradesToday || 0;
  }

  res.json({
    isRunning: s.running,
    lastScan: s.lastScan ? new Date(s.lastScan).toISOString() : null,
    scannedToday: s.scannedToday,
    alertsTriggered: s.alertsTriggered,
    marketsChecked: s.scannedToday, // approximate for UI
    tradesToday: tradesToday || 0,
    circuitBreakerTriggered: cb.triggered,
    paperMode: !!settings.paper_mode,
    scanIntervalMs: SCANNER_INTERVAL_MS,
  });
});

// ── GET /api/scanner/results ───────────────────────────────────
// ?executed=true  → returns execution log from executions table
// ?alerts=true    → returns high-confidence scanner signals only
// default         → returns all scanner results
router.get("/results", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  const since = req.query["since"] ? Number(req.query["since"]) : 0;
  const alertsOnly = req.query["alerts"] === "true";
  const executedOnly = req.query["executed"] === "true";

  // When ?executed=true, return data from executions table for the Execution Log
  if (executedOnly) {
    // Executions are private: only the caller's own agent, never everyone's
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    if (!linkedAgent) {
      res.json([]);
      return;
    }
    let execRows: any[];
    if (isPgEnabled()) {
      execRows = await pgQuery(
        "SELECT id, slug, side, direction, amount, status, executed_at, fill_price, pnl FROM executions WHERE executed_at > $1 AND agent_id = $3 ORDER BY executed_at DESC LIMIT $2",
        [since, limit, linkedAgent.agentId]
      );
    } else {
      const db = getDb();
      execRows = db.prepare(
        "SELECT id, slug, side, direction, amount, status, executed_at, fill_price, pnl FROM executions WHERE executed_at > ? AND agent_id = ? ORDER BY executed_at DESC LIMIT ?"
      ).all(since, linkedAgent.agentId, limit) as any[];
    }
    const scannerDirections = await getLatestScannerDirectionMap();

    const results = execRows.map((e: any) => ({
      id: String(e.id),
      slug: e.slug,
      direction: resolveExecutionDirection(e, scannerDirections.get(e.slug)).direction,
      amount: e.amount,
      confidence: null, // executions table doesn't store confidence
      status: (e.status ?? "").toUpperCase(),
      executedAt: new Date(e.executed_at).toISOString(),
      fillPrice: e.fill_price,
      pnl: e.pnl,
    }));

    res.json(results);
    return;
  }

  type Row = {
    id: number;
    slug: string;
    scanned_at: number;
    sigma_confidence: number;
    kelly_fraction: number;
    recommendation: string;
    probability: number;
    alert_sent: number;
    pipeline_result: string;
  };

  let rows: Row[];
  if (isPgEnabled()) {
    let query = "SELECT * FROM scanner_results WHERE scanned_at > $1";
    const params: (number | string)[] = [since];
    let paramIdx = 2;
    if (alertsOnly) {
      query += " AND sigma_confidence >= 0.70 AND kelly_fraction >= 0.40";
    }
    query += ` ORDER BY scanned_at DESC LIMIT $${paramIdx}`;
    params.push(limit);

    rows = await pgQuery<Row>(query, params);
  } else {
    const db = getDb();
    let query = "SELECT * FROM scanner_results WHERE scanned_at > ?";
    const params: (number | string)[] = [since];
    if (alertsOnly) {
      query += " AND sigma_confidence >= 0.70 AND kelly_fraction >= 0.40";
    }
    query += " ORDER BY scanned_at DESC LIMIT ?";
    params.push(limit);

    rows = db.prepare(query).all(...params) as Row[];
  }

  const results = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    scannedAt: r.scanned_at,
    sigmaConfidence: r.sigma_confidence ?? 0,
    sigma_confidence: r.sigma_confidence ?? 0,
    kellyFraction: r.kelly_fraction ?? 0,
    kelly_fraction: r.kelly_fraction ?? 0,
    recommendation: r.recommendation,
    probability: r.probability,
    alertSent: r.alert_sent === 1,
    pipelineResult: (() => {
      try { return JSON.parse(r.pipeline_result) as unknown; } catch { return null; }
    })(),
  }));

  res.json({ ok: true, count: results.length, results });
});

// ── GET /api/scanner/candidates ────────────────────────────────
router.get("/candidates", async (_req: Request, res: Response) => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  type CandRow = {
    slug: string;
    scanned_at: number;
    sigma_confidence: number;
    kelly_fraction: number;
    recommendation: string;
    probability: number;
  };

  let rows: CandRow[];
  if (isPgEnabled()) {
    rows = await pgQuery<CandRow>(`
      SELECT slug, MAX(scanned_at) as scanned_at, sigma_confidence, kelly_fraction, recommendation, probability
      FROM scanner_results
      WHERE scanned_at > $1
        AND sigma_confidence >= 0.70
        AND kelly_fraction >= 0.40
      GROUP BY slug, sigma_confidence, kelly_fraction, recommendation, probability
      ORDER BY sigma_confidence DESC
      LIMIT 20
    `, [oneDayAgo]);
  } else {
    const db = getDb();
    rows = db.prepare(`
      SELECT slug, MAX(scanned_at) as scanned_at, sigma_confidence, kelly_fraction, recommendation, probability
      FROM scanner_results
      WHERE scanned_at > ?
        AND sigma_confidence >= 0.70
        AND kelly_fraction >= 0.40
      GROUP BY slug
      ORDER BY sigma_confidence DESC
      LIMIT 20
    `).all(oneDayAgo) as CandRow[];
  }

  res.json({ ok: true, count: rows.length, candidates: rows });
});

export default router;
