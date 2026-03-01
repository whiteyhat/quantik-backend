import { Router, Request, Response } from "express";
import { runLucifer } from "../lucifer/index";
import { getDb } from "../db/schema";

const router = Router();

router.get("/status", (_req: Request, res: Response) => {
  res.json({ agent: "lucifer", status: "active" });
});

router.get("/:slug", async (req: Request<{ slug: string }>, res: Response) => {
  const { slug } = req.params;
  const db = getDb();
  const clauseRow = db.prepare("SELECT * FROM clause_results WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1").get(slug) as any;
  const edgeRow = db.prepare("SELECT * FROM edge_results WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1").get(slug) as any;
  const auraRow = db.prepare("SELECT * FROM aura_results WHERE slug = ? AND is_mock = 0 ORDER BY scored_at DESC LIMIT 1").get(slug) as any;

  const agentResults: Record<string, unknown> = {
    clause: clauseRow ? { ambiguityScore: clauseRow.ambiguityScore, veto: Boolean(clauseRow.veto), riskLevel: clauseRow.riskLevel } : null,
    edge: edgeRow ? { fractional_kelly: edgeRow.fractional_kelly, kelly_recommended: edgeRow.kelly_recommended } : null,
    aura: auraRow ? { shiftDetected: Boolean(auraRow.shift_detected), shiftDirection: auraRow.shift_direction } : null,
  };

  const data_freshness = {
    clause: clauseRow ? "live" : "default",
    edge: edgeRow ? "live" : "default",
    aura: auraRow ? "live" : "default",
  };

  const result = await runLucifer(slug, agentResults);
  return res.json({ ...result?.data, slug, data_freshness });
});

export default router;
