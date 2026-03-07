import { Router, Request, Response } from "express";
import { runCli } from "../cli";
import { getDb } from "../db/schema";

const router = Router();

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

  // totalValue = on-chain USDC + CLOB collateral + deployed capital + open P&L
  const deployedCapital = openExecs.reduce((acc, e) => acc + (e.amount ?? 0), 0);
  const totalValue = onChainUsdc + clobUsdc + deployedCapital + openPnl;
  const totalRealizedPnl = settledExecs.reduce((acc, e) => acc + (e.pnl ?? 0), 0);

  const todayStart = new Date().setUTCHours(0, 0, 0, 0);
  const todaySettled = settledExecs.filter(e => e.executed_at >= todayStart);
  const realizedToday = todaySettled.reduce((acc, e) => acc + (e.pnl ?? 0), 0);
  const tradesToday = executions.filter(e => e.executed_at >= todayStart && e.status !== 'failed').length;
  const winRate = settledExecs.length > 0 ? settledExecs.filter(e => e.pnl > 0).length / settledExecs.length : 0;

  // Daily P&L = today's realized closes + unrealized on ALL open positions
  const pnlToday = realizedToday + openPnl;

  // Drawdown: intraday loss as percentage (only when daily P&L is negative)
  const drawdownPct = totalValue > 0 && pnlToday < 0 ? (Math.abs(pnlToday) / totalValue) * 100 : 0;

  // Drawdown limit from DB config
  const gcbRow = db.prepare<[], { drawdown_limit_pct: number; kelly_fraction_multiplier: number }>(
    `SELECT gcb.drawdown_limit_pct, gcb.kelly_fraction_multiplier FROM global_circuit_breakers gcb
     JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
     WHERE rc.is_active = 1 LIMIT 1`
  ).get();
  const drawdownLimit = gcbRow?.drawdown_limit_pct ?? 0.15;
  const kellyMultiplier = gcbRow?.kelly_fraction_multiplier ?? 0.25;

  // Kelly utilization: deployed capital / (totalValue * kellyMultiplier)
  // Represents how much of the Kelly-optimal allocation is being used
  const kellyOptimal = totalValue * kellyMultiplier;
  const kellyUtilization = kellyOptimal > 0 ? Math.min(deployedCapital / kellyOptimal, 1) : 0;

  res.json({
    address: WALLET_ADDRESS,
    onChainUsdc, onChainUsdcFormatted: formatUsd(onChainUsdc),
    clobUsdc, pol, polFormatted: `${pol.toFixed(2)} POL`,
    totalValue, usdc: onChainUsdc + clobUsdc, usdcFormatted: formatUsd(onChainUsdc + clobUsdc),
    pnl: totalRealizedPnl + openPnl,
    pnlPct: totalValue > 0 ? ((totalRealizedPnl + openPnl) / totalValue) * 100 : 0,
    pnlToday,
    pnlTodayPct: totalValue > 0 ? (pnlToday / totalValue) * 100 : 0,
    winRate, totalTrades: settledExecs.length, tradesExecutedToday: tradesToday,
    positions, openPnl,
    circuitBreakerStatus: (() => {
      const cbRow = db.prepare<[], { state: string }>("SELECT state FROM circuit_breaker_state WHERE id = 1").get();
      return cbRow?.state ?? "ARMED";
    })(),
    drawdown: drawdownPct,
    drawdownLimit: drawdownLimit * 100, // Convert to percentage (e.g. 0.15 → 15.0)
    kellyUtilization,
  });
});

router.get("/risk", async (_req, res) => {
  const db = getDb();

  // Read real config from DB
  const gcb = db.prepare<[], { drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number }>(
    `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
     FROM global_circuit_breakers gcb
     JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
     WHERE rc.is_active = 1 LIMIT 1`
  ).get();

  const rawMaxPos = gcb?.max_position_size_pct ?? 0.10;
  const maxPosPct = rawMaxPos > 1 ? rawMaxPos / 100 : rawMaxPos;

  const luciferRow = db.prepare<[], { var_threshold: number }>(
    `SELECT at.var_threshold
     FROM agent_thresholds at
     JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
     WHERE rc.is_active = 1 AND at.agent_name = 'lucifer' LIMIT 1`
  ).get();

  // Compute real drawdown & exposure from executions
  const executions = db.prepare("SELECT * FROM executions ORDER BY executed_at DESC").all() as any[];
  const openExecs = executions.filter((e: any) => (e.status === 'placed' || e.status === 'paper') && e.pnl === null);
  const settledExecs = executions.filter((e: any) => e.pnl !== null);

  const totalRealizedPnl = settledExecs.reduce((acc: number, e: any) => acc + (e.pnl ?? 0), 0);
  const { usdc: onChainUsdc, pol } = await getPolygonBalances(WALLET_ADDRESS);
  let clobUsdc = 0;
  try {
    const raw = await runCli(["clob", "balance", "--asset-type", "collateral"]);
    if (raw && typeof raw === "object") clobUsdc = Number((raw as any).balance ?? 0);
  } catch {}

  const deployedUsdc = openExecs.reduce((sum: number, e: any) => sum + (e.amount ?? 0), 0);
  const totalValue = onChainUsdc + clobUsdc + deployedUsdc + (pol * 0.4);

  // Worst-case drawdown: largest peak-to-trough in realized PnL history
  let peak = 0;
  let worstDrawdown = 0;
  let running = 0;
  for (const e of settledExecs.slice().reverse()) {
    running += e.pnl ?? 0;
    if (running > peak) peak = running;
    const dd = peak > 0 ? (peak - running) / peak : 0;
    if (dd > worstDrawdown) worstDrawdown = dd;
  }

  // Correlation pairs from open positions
  const slugs = [...new Set(openExecs.map((e: any) => e.slug))];
  const correlations: { pair: string[]; score: number }[] = [];
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const words1 = new Set(slugs[i].toLowerCase().split("-"));
      const words2 = new Set(slugs[j].toLowerCase().split("-"));
      let shared = 0;
      for (const w of words1) if (words2.has(w)) shared++;
      const totalUnique = new Set([...words1, ...words2]).size;
      const score = totalUnique > 0 ? shared / totalUnique : 0;
      if (score > 0.1) correlations.push({ pair: [slugs[i], slugs[j]], score: parseFloat(score.toFixed(3)) });
    }
  }

  const currentDrawdown = totalValue > 0 && totalRealizedPnl < 0 ? Math.abs(totalRealizedPnl) / totalValue : 0;
  const drawdownLimit = gcb?.drawdown_limit_pct ?? 0.15;

  let status: "NORMAL" | "WARNING" | "CRITICAL" = "NORMAL";
  if (currentDrawdown >= drawdownLimit) status = "CRITICAL";
  else if (currentDrawdown >= drawdownLimit * 0.5) status = "WARNING";

  res.json({
    maxPositionSizePct: parseFloat((maxPosPct * 100).toFixed(1)),
    maxThemeExposurePct: 20,
    fractionalKelly: gcb?.kelly_fraction_multiplier ?? 0.25,
    luciferVetoThreshold: luciferRow?.var_threshold ?? 0.03,
    correlations,
    tailRisk: {
      worstCaseDrawdown: parseFloat(worstDrawdown.toFixed(4)),
      currentDrawdown: parseFloat(currentDrawdown.toFixed(4)),
    },
    platformRisk: {
      gasBalance: parseFloat(pol.toFixed(4)),
      gasOk: pol > 0.01,
    },
    status,
  });
});

router.get("/attribution", (_req: Request, res: Response) => {
  const db = getDb();
  const executions = db.prepare("SELECT * FROM executions ORDER BY executed_at DESC LIMIT 500").all() as any[];
  
  const priceRows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as any[];
  const livePrice = new Map(priceRows.map(r => [r.slug, r.probability]));

  const tradeList = executions.map(e => {
    const entry = e.fill_price ?? 0.5;
    const current = livePrice.get(e.slug) ?? entry;
    const shares = entry > 0 ? e.amount / entry : 0;
    const pnl = e.side === "buy" ? (current - entry) * shares : (entry - current) * shares;
    
    let outcome = "OPEN";
    if (e.pnl !== null) outcome = e.pnl > 0 ? "WIN" : "LOSS";
    else if (e.status === "failed") outcome = "LOSS";

    return {
      id: e.id,
      slug: e.slug,
      market: e.slug.split("-").map((w: any) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      direction: e.side === "buy" ? "YES" : "NO",
      size: e.amount,
      price: entry,
      outcome,
      timestamp: e.executed_at,
      pnl: e.pnl ?? pnl,
      orderId: e.order_id,
      mode: e.status,
    };
  });

  res.json({
    trades: tradeList,
    count: tradeList.length,
    winRate: tradeList.filter(t => t.outcome === "WIN").length / Math.max(tradeList.filter(t => t.outcome !== "OPEN").length, 1)
  });
});

export default router;
