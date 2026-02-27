import { Router, Request, Response } from "express";
import {
  approvePosition,
  getPortfolioManager,
  getCorrelationMonitor,
  getCircuitBreaker,
} from "../risk";

const router = Router();

// ── GET /api/risk/status ───────────────────────────────────────
// Portfolio exposure, daily P&L, circuit breaker state

router.get("/status", (_req: Request, res: Response) => {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const cb = getCircuitBreaker();

  const cbStatus = cb.checkAndTrip();
  const totalCapital = portfolio.getTotalCapital();
  const deployed = portfolio.getDeployedCapital();
  const available = portfolio.getAvailableCapital();
  const dailyPnl = portfolio.getDailyPnL();

  // Theme exposure as plain object
  const themeExposure: Record<string, number> = {};
  for (const [theme, exposure] of correlation.getThemeExposure()) {
    themeExposure[theme] = exposure;
  }

  res.json({
    totalCapital,
    deployedCapital: deployed,
    availableCapital: available,
    exposurePct: totalCapital > 0 ? deployed / totalCapital : 0,
    dailyPnl,
    dailyPnlPct: totalCapital > 0 ? dailyPnl / totalCapital : 0,
    circuitBreaker: cbStatus,
    themeExposure,
    positionCount: portfolio.getOpenPositions().length,
  });
});

// ── GET /api/risk/positions ────────────────────────────────────
// Open positions with risk metadata

router.get("/positions", (_req: Request, res: Response) => {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const positions = portfolio.getOpenPositions();
  const totalCapital = portfolio.getTotalCapital();

  const enriched = positions.map((p) => ({
    ...p,
    portfolioPct: totalCapital > 0 ? p.sizeUsdc / totalCapital : 0,
    category: correlation.categorize(p.slug),
  }));

  res.json({
    positions: enriched,
    count: enriched.length,
    totalDeployed: positions.reduce((sum, p) => sum + p.sizeUsdc, 0),
  });
});

// ── POST /api/risk/approve ─────────────────────────────────────
// Run full risk check on a proposed trade

router.post("/approve", (req: Request, res: Response) => {
  const { slug, sizeUsdc, category } = req.body as {
    slug?: string;
    sizeUsdc?: number;
    category?: string;
  };

  if (!slug || typeof sizeUsdc !== "number" || sizeUsdc <= 0) {
    res.status(400).json({
      error: "Required: slug (string), sizeUsdc (positive number)",
    });
    return;
  }

  const approval = approvePosition(slug, sizeUsdc, category);
  res.json(approval);
});

// ── POST /api/risk/circuit-breaker/reset ───────────────────────
// Manual reset (admin only)

router.post("/circuit-breaker/reset", (_req: Request, res: Response) => {
  const cb = getCircuitBreaker();
  cb.reset();
  const status = cb.getStatus();

  res.json({
    message: "Circuit breaker reset to ARMED.",
    circuitBreaker: status,
  });
});

export default router;
