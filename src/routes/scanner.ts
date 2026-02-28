import { Router, Request, Response } from "express";
import { MarketScanner, getScannerStatus } from "../scanner/marketScanner";
import { getDb } from "../db/schema";

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
  res.json({
    running: s.running,
    lastScanAt: s.lastScan,
    scannedToday: s.scannedToday,
    alertsTriggered: s.alertsTriggered,
  });
});

// ── GET /api/scanner/results ───────────────────────────────────
router.get("/results", (req: Request, res: Response) => {
  const db = getDb();
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  const since = req.query["since"] ? Number(req.query["since"]) : 0;
  const alertsOnly = req.query["alerts"] === "true";

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
    sigmaConfidence: r.sigma_confidence,
    kellyFraction: r.kelly_fraction,
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
