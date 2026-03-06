import { Router, Request, Response } from "express";
import {
  approvePosition,
  getPortfolioManager,
  getCorrelationMonitor,
  getCircuitBreaker,
} from "../risk";
import { getUsdcBalance, getClobBalance } from "../utils/balances";

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

  res.json({
    totalCapital,
    deployedCapital: deployed,
    availableCapital: available,
    exposurePct: totalCapital > 0 ? (deployed / totalCapital) * 100 : 0,
    dailyPnl,
    dailyPnlPct: totalCapital > 0 ? (dailyPnl / totalCapital) * 100 : 0,
    circuitBreaker: cbStatus,
    themeExposure,
    positionCount: portfolio.getOpenPositions().length,
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
