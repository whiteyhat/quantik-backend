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

// GET /api/sigma/:slug
router.get("/:slug", (req: Request, res: Response) => {
  const { slug } = req.params;
  const db = getDb();
  const row = db.prepare("SELECT * FROM research_notes WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1").get(slug);

  if (!row) {
    return res.status(404).json({ error: "No research note found for this market" });
  }

  // Parse JSON fields
  const rowAny = row as any;
  const result = {
    ...rowAny,
    confidence_interval: JSON.parse(rowAny.confidence_interval as string),
    agent_weights: JSON.parse(rowAny.agent_weights as string),
    auto_synthesized: Boolean(rowAny.auto_synthesized),
  };

  res.json(result);
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
