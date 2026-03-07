import { Router, Request, Response } from "express";
import { MarketScanner, getScannerStatus } from "../scanner/marketScanner";
import { getDb } from "../db/schema";
import { getCircuitBreaker, getPortfolioManager } from "../risk";
import { getSettings } from "../db/queries";

const router = Router();
const scanner = new MarketScanner();

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
router.get("/status", (_req: Request, res: Response) => {
  const s = getScannerStatus();
  const cb = getCircuitBreaker().getStatus();
  const portfolio = getPortfolioManager();
  const settings = getSettings();
  
  const todayStart = new Date().setUTCHours(0, 0, 0, 0);
  const db = getDb();
  const { tradesToday } = db.prepare("SELECT COUNT(*) AS tradesToday FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayStart) as any;

  res.json({
    isRunning: s.running,
    lastScan: s.lastScan ? new Date(s.lastScan).toISOString() : null,
    scannedToday: s.scannedToday,
    alertsTriggered: s.alertsTriggered,
    marketsChecked: s.scannedToday, // approximate for UI
    tradesToday: tradesToday || 0,
    circuitBreakerTriggered: cb.triggered,
    paperMode: !!settings.paper_mode,
  });
});

// ── GET /api/scanner/results ───────────────────────────────────
// ?executed=true  → returns execution log from executions table
// ?alerts=true    → returns high-confidence scanner signals only
// default         → returns all scanner results
router.get("/results", (req: Request, res: Response) => {
  const db = getDb();
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  const since = req.query["since"] ? Number(req.query["since"]) : 0;
  const alertsOnly = req.query["alerts"] === "true";
  const executedOnly = req.query["executed"] === "true";

  // When ?executed=true, return data from executions table for the Execution Log
  if (executedOnly) {
    const execRows = db.prepare(
      "SELECT id, slug, side, amount, status, executed_at, fill_price, pnl FROM executions WHERE executed_at > ? ORDER BY executed_at DESC LIMIT ?"
    ).all(since, limit) as any[];

    const results = execRows.map((e: any) => ({
      id: String(e.id),
      slug: e.slug,
      direction: e.side === "buy" ? "YES" : "NO",
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

  let query = "SELECT * FROM scanner_results WHERE scanned_at > ?";
  const params: (number | string)[] = [since];
  if (alertsOnly) {
    query += " AND sigma_confidence >= 0.70 AND kelly_fraction >= 0.40";
  }
  query += " ORDER BY scanned_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(query).all(...params) as Row[];

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
router.get("/candidates", (_req: Request, res: Response) => {
  const db = getDb();
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  type CandRow = {
    slug: string;
    scanned_at: number;
    sigma_confidence: number;
    kelly_fraction: number;
    recommendation: string;
    probability: number;
  };

  const rows = db.prepare(`
    SELECT slug, MAX(scanned_at) as scanned_at, sigma_confidence, kelly_fraction, recommendation, probability
    FROM scanner_results
    WHERE scanned_at > ?
      AND sigma_confidence >= 0.70
      AND kelly_fraction >= 0.40
    GROUP BY slug
    ORDER BY sigma_confidence DESC
    LIMIT 20
  `).all(oneDayAgo) as CandRow[];

  res.json({ ok: true, count: rows.length, candidates: rows });
});

export default router;
