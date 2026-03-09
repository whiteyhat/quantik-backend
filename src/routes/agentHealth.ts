import { Router, Request, Response } from "express";
import { getSystemHealth } from "../monitoring/agentHealth";

const router = Router();

export interface AgentHealthRouteSnapshot {
  agents: Array<{
    name: string;
    status: "live" | "idle" | "degraded" | "down";
    lastActiveAt: number;
    latencyMs: number;
    errorRate: number;
  }>;
  overall: "healthy" | "degraded" | "down";
  checkedAt: number;
}

export function buildAgentHealthSnapshot(): AgentHealthRouteSnapshot {
  return getSystemHealth();
}

// GET /api/agents/health — real-time agent health from pipeline invocation data
router.get("/health", (_req: Request, res: Response) => {
  res.json(buildAgentHealthSnapshot());
});

export default router;
