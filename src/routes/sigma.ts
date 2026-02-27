import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { runSigma, SigmaInputs } from "../sigma";

const router = Router();

// GET /api/sigma/status
router.get("/status", (req: Request, res: Response) => {
  res.json({
    agent: "sigma",
    status: "active",
    mock_mode: process.env.SIGMA_MOCK === "true",
  });
});

// GET /api/sigma/:slug — returns last Sigma result from research_notes or pipeline history
router.get("/:slug", (req: Request, res: Response) => {
  const { slug } = req.params;
  const db = getDb();

  // Primary: research_notes table
  const row = db.prepare("SELECT * FROM research_notes WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1").get(slug);
  if (row) {
    const rowAny = row as any;
    return res.json({
      ...rowAny,
      confidence_interval: JSON.parse(rowAny.confidence_interval as string),
      agent_weights: JSON.parse(rowAny.agent_weights as string),
      auto_synthesized: Boolean(rowAny.auto_synthesized),
    });
  }

  // Fallback: pipeline_runs sigma_output
  const pipelineRow = db.prepare("SELECT sigma_output, market_slug, completed_at FROM pipeline_runs WHERE market_slug = ? AND sigma_output IS NOT NULL ORDER BY completed_at DESC LIMIT 1").get(slug) as any;
  if (pipelineRow?.sigma_output) {
    try {
      const sigma = JSON.parse(pipelineRow.sigma_output);
      return res.json({ ...sigma, marketSlug: slug, source: "pipeline" });
    } catch { /* ignore parse error */ }
  }

  res.status(404).json({ error: "No sigma result found for this market" });
});

// POST /api/sigma/run
router.post("/run", async (req: Request, res: Response) => {
  const body = req.body as SigmaInputs;

  if (!body.market || !body.market.slug) {
    return res.status(400).json({ error: "Missing market with slug in body" });
  }

  try {
    const result = await runSigma(body);
    res.json(result);
  } catch (error) {
    console.error("Error running Sigma:", error);
    res.status(500).json({ error: "Failed to run Sigma" });
  }
});

export default router;
