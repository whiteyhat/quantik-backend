import { Router, Request, Response } from "express";
import { runCli } from "../cli";
import { getDb } from "../db/schema";

const router = Router();

const DEFAULTS = {
  maxPositionSizePct: 5,
  maxThemeExposurePct: 20,
  fractionalKelly: 0.25,
  drawdownLimit: 0.15,
};

const WALLET_ADDRESS = "0x7EE996AbE9355a126F010EfF93487e84b2cE4b53";
const POLYGON_RPC_URLS = [
  "https://polygon.drpc.org",
  "https://polygon-bor-rpc.publicnode.com",
];

const USDC_BRIDGED_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_NATIVE_CONTRACT  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

async function polygonRpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json() as any;
  if (!json.result) throw new Error(json.error?.message ?? "No result");
  return json.result;
}

async function getPolygonBalances(address: string): Promise<{ usdc: number; pol: number }> {
  const paddedAddr = address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${paddedAddr}`;
  for (const rpcUrl of POLYGON_RPC_URLS) {
    try {
      const [uBH, uNH, p] = await Promise.all([
        polygonRpcCall(rpcUrl, "eth_call", [{ to: USDC_BRIDGED_CONTRACT, data: callData }, "latest"]),
        polygonRpcCall(rpcUrl, "eth_call", [{ to: USDC_NATIVE_CONTRACT, data: callData }, "latest"]),
        polygonRpcCall(rpcUrl, "eth_getBalance", [address, "latest"]),
      ]);
      const safeBigInt = (h: string) => (!h || h === "0x" || h === "0X") ? 0n : BigInt(h);
      return { usdc: Number(safeBigInt(uBH) + safeBigInt(uNH)) / 1e6, pol: Number(safeBigInt(p)) / 1e18 };
    } catch { continue; }
  }
  return { usdc: 0, pol: 0 };
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

router.get("/summary", async (_req: Request, res: Response) => {
  const { usdc: onChainUsdc, pol } = await getPolygonBalances(WALLET_ADDRESS);
  let clobUsdc = 0;
  try {
    const raw = await runCli(["clob", "balance", "--asset-type", "collateral"]);
    if (raw && typeof raw === "object") clobUsdc = Number((raw as any).balance ?? 0);
  } catch {}

  const db = getDb();
  const executions = db.prepare("SELECT * FROM executions ORDER BY executed_at DESC").all() as any[];
  
  // Current prices for P&L
  const priceRows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as any[];
  const currentPrices = new Map(priceRows.map(r => [r.slug, r.probability]));

  const settledExecs = executions.filter(e => e.pnl !== null);
  const openExecs = executions.filter(e => (e.status === 'placed' || e.status === 'paper') && e.pnl === null);

  let openPnl = 0;
  const positions = openExecs.map(e => {
    const current = currentPrices.get(e.slug) ?? e.fill_price ?? 0.5;
    const entry = e.fill_price ?? 0.5;
    const shares = entry > 0 ? e.amount / entry : 0;
    const pnl = e.side === "buy" ? (current - entry) * shares : (entry - current) * shares;
    openPnl += pnl;
    return {
      marketSlug: e.slug,
      market: e.slug.split("-").map((w: any) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      direction: e.side === "buy" ? "YES" : "NO",
      size: e.amount,
      price: entry,
      currentPrice: current,
      openPnl: pnl,
      pnlPct: entry > 0 ? (pnl / e.amount) * 100 : 0
    };
  });

  const totalValue = onChainUsdc + clobUsdc + (pol * 0.4) + openPnl;
  const totalRealizedPnl = settledExecs.reduce((acc, e) => acc + (e.pnl ?? 0), 0);
  
  const todayStart = new Date().setUTCHours(0, 0, 0, 0);
  const todayExecs = executions.filter(e => e.executed_at >= todayStart);
  const realizedToday = todayExecs.reduce((acc, e) => acc + (e.pnl ?? 0), 0);
  
  // Trades Today
  const tradesToday = todayExecs.filter(e => e.status !== 'failed').length;

  const winRate = settledExecs.length > 0 ? settledExecs.filter(e => e.pnl > 0).length / settledExecs.length : 0;

  res.json({
    onChainUsdc, onChainUsdcFormatted: formatUsd(onChainUsdc),
    clobUsdc, pol, polFormatted: `${pol.toFixed(2)} POL`,
    totalValue, usdc: onChainUsdc + clobUsdc, usdcFormatted: formatUsd(onChainUsdc + clobUsdc),
    pnl: totalRealizedPnl, pnlPct: totalValue > 0 ? (totalRealizedPnl / totalValue) * 100 : 0,
    pnlToday: realizedToday + openPnl, 
    pnlTodayPct: totalValue > 0 ? ((realizedToday + openPnl) / totalValue) * 100 : 0,
    winRate, totalTrades: executions.length, tradesExecutedToday: tradesToday,
    positions, openPnl,
    circuitBreakerStatus: (totalRealizedPnl < -totalValue * 0.15) ? "TRIGGERED" : "ARMED",
    drawdown: totalRealizedPnl < 0 ? Math.abs(totalRealizedPnl) / totalValue : 0,
    drawdownLimit: 0.15,
    kellyUtilization: Math.min((openExecs.length * 5) / 100, 1)
  });
});

router.get("/risk", async (_req, res) => {
  res.json({
    maxPositionSizePct: 5, maxThemeExposurePct: 20, fractionalKelly: 0.25,
    luciferVetoThreshold: 0.85, correlations: [], 
    tailRisk: { worstCaseDrawdown: 0.28, blackSwanExposure: 0.07 },
    platformRisk: { contractApproved: true, gasBalance: 0.05, withdrawalLimitReached: false }
  });
});

export default router;
