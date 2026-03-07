import { Router, Request, Response } from "express";
import { getState, getCandidates, runScan, SCAN_COOLDOWN_MS } from "../orchestrator/index";

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
// Note: tokenId is Polymarket conditionId (not CLOB token ID)

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

let lastManualScanAt = 0;

router.post("/scan", async (_req: Request, res: Response) => {
  const now = Date.now();
  const s = getState();

  // Rate limit: reject if already scanning or cooldown hasn't elapsed
  if (s.status === "scanning") {
    res.status(429).json({ error: "Scan already in progress", triggered: false });
    return;
  }
  if (now - lastManualScanAt < SCAN_COOLDOWN_MS) {
    const retryAfter = Math.ceil((SCAN_COOLDOWN_MS - (now - lastManualScanAt)) / 1000);
    res.status(429).json({ error: `Rate limited — retry in ${retryAfter}s`, triggered: false });
    return;
  }

  try {
    lastManualScanAt = now;
    const result = await runScan();
    res.json({
      triggered: true,
      marketsScanned: result.marketsScanned,
      candidatesFound: result.candidatesFound,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
