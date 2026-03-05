import { Router, Request, Response } from "express";
import {
  approvePosition,
  getPortfolioManager,
  getCorrelationMonitor,
  getCircuitBreaker,
} from "../risk";
import { getDb } from "../db/schema";
import { runCli } from "../cli";

const router = Router();

const WALLET_ADDRESS = "0x7EE996AbE9355a126F010EfF93487e84b2cE4b53";
const POLYGON_RPC_URLS = ["https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com"];
const USDC_BRIDGED_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_NATIVE_CONTRACT  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

async function polygonRpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(8000) });
  const json = await res.json() as any;
  return json.result;
}

async function getUsdcBalance(address: string): Promise<number> {
  const paddedAddr = address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${paddedAddr}`;
  for (const rpcUrl of POLYGON_RPC_URLS) {
    try {
      const [uBH, uNH] = await Promise.all([
        polygonRpcCall(rpcUrl, "eth_call", [{ to: USDC_BRIDGED_CONTRACT, data: callData }, "latest"]),
        polygonRpcCall(rpcUrl, "eth_call", [{ to: USDC_NATIVE_CONTRACT, data: callData }, "latest"]),
      ]);
      const safeBigInt = (h: string) => (!h || h === "0x" || h === "0X") ? 0n : BigInt(h);
      return Number(safeBigInt(uBH) + safeBigInt(uNH)) / 1e6;
    } catch { continue; }
  }
  return 0;
}

router.get("/status", async (_req: Request, res: Response) => {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const cb = getCircuitBreaker();

  const cbStatus = cb.checkAndTrip();
  
  // Real capital fetch
  const onChainUsdc = await getUsdcBalance(WALLET_ADDRESS);
  let clobUsdc = 0;
  try {
    const raw = await runCli(["clob", "balance", "--asset-type", "collateral"]);
    if (raw && typeof raw === "object") clobUsdc = Number((raw as any).balance ?? 0);
  } catch {}

  const openPositions = portfolio.getOpenPositions();
  const deployed = openPositions.reduce((sum, p) => sum + p.sizeUsdc, 0);
  const openPnl = openPositions.reduce((sum, p) => sum + p.openPnl, 0);
  
  const totalCapital = onChainUsdc + clobUsdc + deployed + openPnl;
  const available = onChainUsdc + clobUsdc;
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
  const totalCapital = 3000; // Fallback for relative %

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
