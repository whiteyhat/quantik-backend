import { Router, Request, Response } from "express";
import {
  approvePosition,
  getPortfolioManager,
  getCorrelationMonitor,
  getCircuitBreaker,
} from "../risk";
import { getDb } from "../db/schema";

const router = Router();

router.get("/status", async (_req: Request, res: Response) => {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const cb = getCircuitBreaker();

  const cbStatus = await cb.checkAndTrip();

  const totalCapital = await portfolio.getTotalCapital();
  const deployed = portfolio.getDeployedCapital();
  const available = await portfolio.getAvailableCapital();
  const dailyPnl = portfolio.getDailyPnL();

  const themeExposure: Record<string, number> = {};
  for (const [theme, exposure] of correlation.getThemeExposure()) {
    themeExposure[theme] = exposure;
  }

  // Fetch risk config from DB (real, not hardcoded)
  const db = getDb();
  const gcb = db.prepare<[], { drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number }>(
    `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
     FROM global_circuit_breakers gcb
     JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
     WHERE rc.is_active = 1 LIMIT 1`
  ).get();

  const rawMaxPos = gcb?.max_position_size_pct ?? 0.10;
  const maxPositionSizePct = rawMaxPos > 1 ? rawMaxPos / 100 : rawMaxPos;

  const luciferRow = db.prepare<[], { var_threshold: number }>(
    `SELECT at.var_threshold
     FROM agent_thresholds at
     JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
     WHERE rc.is_active = 1 AND at.agent_name = 'lucifer' LIMIT 1`
  ).get();

  res.json({
    totalCapital,
    deployedCapital: deployed,
    availableCapital: available,
    exposurePct: totalCapital > 0 ? (deployed / totalCapital) * 100 : 0,
    dailyPnl,
    dailyPnlPct: totalCapital > 0 ? (dailyPnl / totalCapital) * 100 : 0,
    circuitBreaker: cbStatus.state, // Frontend expects string: "ARMED" | "WARNING" | "TRIGGERED"
    circuitBreakerDetail: cbStatus,  // Full object for advanced consumers
    themeExposure,
    positionCount: portfolio.getOpenPositions().length,
    // Risk configuration (live from DB)
    maxDrawdownPct: gcb?.drawdown_limit_pct ?? 0.15,
    maxPositionSizePct,
    kellyFraction: gcb?.kelly_fraction_multiplier ?? 0.25,
    luciferVetoThreshold: luciferRow?.var_threshold ?? 0.03,
  });
});

router.get("/positions", async (_req: Request, res: Response) => {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const positions = portfolio.getOpenPositions();
  const totalCapital = await portfolio.getTotalCapital();

  const enriched = positions.map((p) => ({
    ...p,
    portfolioPct: totalCapital > 0 ? (p.sizeUsdc / totalCapital) * 100 : 0,
    category: correlation.categorize(p.slug),
  }));

  res.json({
    positions: enriched,
    count: enriched.length,
    totalDeployed: positions.reduce((sum, p) => sum + p.sizeUsdc, 0),
  });
});

router.post("/approve", async (req: Request, res: Response) => {
  const { slug, sizeUsdc, category } = req.body as any;
  if (!slug || typeof sizeUsdc !== "number" || sizeUsdc <= 0) {
    res.status(400).json({ error: "Required: slug, sizeUsdc" });
    return;
  }
  // approvePosition might also need to be async if it calls PortfolioManager
  const approval = await approvePosition(slug, sizeUsdc, category);
  res.json(approval);
});

router.post("/circuit-breaker/reset", (_req: Request, res: Response) => {
  const cb = getCircuitBreaker();
  cb.reset();
  res.json({ message: "Circuit breaker reset to ARMED.", circuitBreaker: cb.getStatus() });
});

export default router;
