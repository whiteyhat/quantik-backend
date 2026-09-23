import { Router, Request, Response } from "express";
import {
  approvePosition,
  getPortfolioManager,
  getCorrelationMonitor,
  getCircuitBreaker,
} from "../risk";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { requireAdmin, isAdminRequest } from "../middleware/guards";

const router = Router();

router.get("/status", async (req: Request, res: Response) => {
  try {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const cb = getCircuitBreaker();

  const cbStatus = await cb.checkAndTrip();

  // Capital, P&L and exposure cover the whole platform: operators only.
  // Everyone else still sees the breaker state and the risk configuration.
  const operator = isAdminRequest(req);
  const totalCapital = operator ? await portfolio.getTotalCapital() : 0;
  const deployed = operator ? await portfolio.getDeployedCapital() : 0;
  const available = operator ? await portfolio.getAvailableCapital() : 0;
  const dailyPnl = operator ? await portfolio.getDailyPnL() : 0;

  const themeExposure: Record<string, number> = {};
  if (operator) {
    for (const [theme, exposure] of correlation.getThemeExposure()) {
      themeExposure[theme] = exposure;
    }
  }

  // Fetch risk config from DB (real, not hardcoded)
  let gcb: { drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number } | undefined;
  let luciferRow: { var_threshold: number } | undefined;

  if (isPgEnabled()) {
    gcb = (await pgQueryOne<{ drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number }>(
      `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
       FROM global_circuit_breakers gcb
       JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 LIMIT 1`
    )) ?? undefined;

    luciferRow = (await pgQueryOne<{ var_threshold: number }>(
      `SELECT at.var_threshold
       FROM agent_thresholds at
       JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 AND at.agent_name = $1 LIMIT 1`,
      ["lucifer"]
    )) ?? undefined;
  } else {
    const db = getDb();
    gcb = db.prepare<[], { drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number }>(
      `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
       FROM global_circuit_breakers gcb
       JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 LIMIT 1`
    ).get();

    luciferRow = db.prepare<[], { var_threshold: number }>(
      `SELECT at.var_threshold
       FROM agent_thresholds at
       JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 AND at.agent_name = 'lucifer' LIMIT 1`
    ).get();
  }

  const rawMaxPos = gcb?.max_position_size_pct ?? 0.10;
  const maxPositionSizePct = rawMaxPos > 1 ? rawMaxPos / 100 : rawMaxPos;

  res.json({
    totalCapital,
    deployedCapital: deployed,
    availableCapital: available,
    exposurePct: totalCapital > 0 ? (deployed / totalCapital) * 100 : 0,
    dailyPnl,
    dailyPnlPct: totalCapital > 0 ? (dailyPnl / totalCapital) * 100 : 0,
    circuitBreaker: cbStatus.state, // Frontend expects string: "ARMED" | "WARNING" | "TRIGGERED"
    // Full object for advanced consumers; its drawdown maths reveals capital
    circuitBreakerDetail: operator ? cbStatus : { state: cbStatus.state },
    themeExposure,
    positionCount: operator ? (await portfolio.getOpenPositions()).length : 0,
    // Risk configuration (live from DB)
    maxDrawdownPct: gcb?.drawdown_limit_pct ?? 0.15,
    maxPositionSizePct,
    kellyFraction: gcb?.kelly_fraction_multiplier ?? 0.25,
    luciferVetoThreshold: luciferRow?.var_threshold ?? 0.03,
  });
  } catch (err) {
    console.error("[riskL3] /status error:", err);
    res.status(500).json({ error: "Failed to load risk status" });
  }
});

router.get("/positions", requireAdmin, async (_req: Request, res: Response) => {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const positions = await portfolio.getOpenPositions();
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

router.post("/circuit-breaker/reset", async (_req: Request, res: Response) => {
  const cb = getCircuitBreaker();
  try {
    await cb.reset();
    res.json({ message: "Circuit breaker reset to ARMED.", circuitBreaker: await cb.getStatus() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
