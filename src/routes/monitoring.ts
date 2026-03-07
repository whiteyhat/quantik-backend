// ── /api/monitoring — L5 Monitoring & Learning routes ─────────────

import { Router, Request, Response } from "express";
import { ResolutionMonitor } from "../monitoring/resolution";
import { AttributionEngine } from "../monitoring/attribution";
import { ModelCalibration } from "../monitoring/calibration";
import { DriftDetection } from "../monitoring/drift";

const router = Router();

const resolutionMonitor = new ResolutionMonitor();
const attributionEngine = new AttributionEngine();
const modelCalibration = new ModelCalibration();
const driftDetection = new DriftDetection();

// ── GET /api/monitoring/brier — recent Brier scores ──────────────
router.get("/brier", (_req: Request, res: Response) => {
  try {
    const limit = Number(_req.query.limit) || 20;
    const scores = resolutionMonitor.getRecentBrierScores(limit);
    const avg =
      scores.length > 0
        ? scores.reduce((s, r) => s + r.brier_score, 0) / scores.length
        : 0;
    res.json({ scores, avgBrier: avg, count: scores.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/monitoring/attribution — P&L attribution by signal ──
router.get("/attribution", (_req: Request, res: Response) => {
  try {
    const attribution = attributionEngine.getAttributionBySignal();
    const decay = attributionEngine.getAlphaDecayStatus();
    res.json({ attribution, alphaDecay: decay });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/monitoring/calibration — agent weights + trends ─────
router.get("/calibration", (_req: Request, res: Response) => {
  try {
    const weights = modelCalibration.getAgentWeights().map((w) => ({
      ...w,
      confidence: w.brierScore !== null ? Math.max(0, 1 - w.brierScore) : null,
    }));
    res.json({ weights });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/monitoring/drift — drift detection status ───────────
router.get("/drift", (_req: Request, res: Response) => {
  try {
    const microstructure = driftDetection.checkMicrostructureDrift();
    const concept = driftDetection.checkConceptDrift();
    res.json({ microstructure, concept, lastChecked: Date.now() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
