import { Router, Request, Response } from "express";
import { getSystemHealth } from "../monitoring/agentHealth";

const router = Router();

// GET /api/agents/health — real-time agent health from pipeline invocation data
router.get("/health", (_req: Request, res: Response) => {
  res.json(getSystemHealth());
});

export default router;
