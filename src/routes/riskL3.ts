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
  const db = getDb();

  const cbStatus = cb.checkAndTrip();
  
  // Total Capital: On-chain + Deployed
  // Sum all trade amounts as a proxy or use fixed capital for demo
  const totalCapital = portfolio.getTotalCapital();
  const openPositions = portfolio.getOpenPositions();
  const deployed = openPositions.reduce((sum, p) => sum + p.sizeUsdc, 0);
  const available = totalCapital - deployed;
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
    positionCount: openPositions.length,
  });
});

router.get("/positions", (_req: Request, res: Response) => {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const positions = portfolio.getOpenPositions();
  const totalCapital = portfolio.getTotalCapital();

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

router.post("/approve", (req: Request, res: Response) => {
  const { slug, sizeUsdc, category } = req.body as any;
  if (!slug || typeof sizeUsdc !== "number" || sizeUsdc <= 0) {
    res.status(400).json({ error: "Required: slug, sizeUsdc" });
    return;
  }
  const approval = approvePosition(slug, sizeUsdc, category);
  res.json(approval);
});

router.post("/circuit-breaker/reset", (_req: Request, res: Response) => {
  const cb = getCircuitBreaker();
  cb.reset();
  res.json({ message: "Circuit breaker reset to ARMED.", circuitBreaker: cb.getStatus() });
});

export default router;
