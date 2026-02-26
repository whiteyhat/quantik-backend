import { Router, Request, Response } from "express";
import { getState, getCandidates, runScan } from "../orchestrator/index";

const router = Router();

// ── GET /api/orchestrator/status ────────────────────────────────

router.get("/status", (_req: Request, res: Response) => {
  const s = getState();
  res.json({
    lastScanAt: s.lastScanAt,
    nextScanAt: s.nextScanAt,
    marketsScanned: s.marketsScanned,
    candidatesFound: s.candidatesFound,
    scanIntervalMs: s.scanIntervalMs,
    status: s.status,
  });
});

// ── GET /api/orchestrator/candidates ────────────────────────────

router.get("/candidates", (_req: Request, res: Response) => {
  const result = getCandidates();
  res.json({
    candidates: result.candidates.map((c) => ({
      slug: c.slug,
      tokenId: c.tokenId,
      question: c.question,
      opportunityScore: c.opportunityScore,
      components: c.components,
      triggers: c.triggers,
      scoredAt: c.scoredAt,
    })),
    total: result.total,
    scanCycle: result.scanCycle,
  });
});

// ── POST /api/orchestrator/scan (manual trigger) ────────────────

router.post("/scan", async (_req: Request, res: Response) => {
  try {
    const result = await runScan();
    res.json({
      triggered: true,
      marketsScanned: result.marketsScanned,
      candidatesFound: result.candidatesFound,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
