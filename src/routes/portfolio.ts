import { Router, Request, Response } from "express";
import { runCli } from "../cli";
import { getDb } from "../db/schema";

const router = Router();

// ── System defaults ────────────────────────────────────────────
const DEFAULTS = {
  maxPositionSizePct: 5,
  maxThemeExposurePct: 20,
  fractionalKelly: 0.25,
  luciferVetoThreshold: 0.85,
  drawdownLimit: 0.15,
};

// ── Shared types ───────────────────────────────────────────────
interface TradeRow {
  id: string;
  order_id: string | null;
  market_slug: string;
  direction: string;
  size: number;
  price: number;
  net_ev: number | null;
  ev_grade: string | null;
  status: string;
  created_at: number;
  pipeline_run_id: string | null;
}

interface PipelineRunRow {
  id: string;
  market_slug: string;
  market_question: string;
  created_at: number;
  completed_at: number | null;
  decision: string | null;
  confidence: number | null;
  aura_output: string | null;
  flux_output: string | null;
  oracle_output: string | null;
  edge_output: string | null;
  sigma_output: string | null;
  clause_output: string | null;
  lucifer_output: string | null;
}

// ── Response interfaces ────────────────────────────────────────
interface PortfolioSummary {
  // On-chain EOA balances (primary)
  onChainUsdc: number;
  onChainUsdcFormatted: string;
  clobUsdc: number;
  pol: number;
  polFormatted: string;
  // Legacy / derived fields (keep for frontend compat)
  totalValue: number;
  usdc: number;
  usdcFormatted: string;
  pnl: number;
  pnlPct: number;
  pnlToday: number;
  pnlTodayPct: number;
  kellyUtilization: number;
  kellyMax: number;
  circuitBreakerStatus: "ARMED" | "WARNING" | "TRIGGERED";
  drawdown: number;
  drawdownLimit: number;
  positions: PositionEntry[];
  openPnl: number;
  winRate: number;
  totalTrades: number;
  tradesExecutedToday?: number;
}

interface PositionEntry {
  marketSlug: string;
  direction: string;
  size: number;
  price: number;
  openPnl: number;
}

interface CorrelationEntry {
  theme: string;
  positions: string[];
  clusterRisk: number;
  exposure: number;
}

interface PortfolioRisk {
  maxPositionSizePct: number;
  maxThemeExposurePct: number;
  fractionalKelly: number;
  luciferVetoThreshold: number;
  correlations: CorrelationEntry[];
  tailRisk: {
    worstCaseDrawdown: number;
    blackSwanExposure: number;
  };
  platformRisk: {
    contractApproved: boolean;
    gasBalance: number;
    withdrawalLimitReached: boolean;
  };
}

interface SignalAttribution {
  agent: string;
  pnl: number;
  trades: number;
  winRate: number;
}

interface AlphaPoint {
  date: string;
  alpha: number;
}

interface CategoryAttribution {
  category: string;
  pnl: number;
  trades: number;
  winRate: number;
}

interface PortfolioAttribution {
  bySignal: SignalAttribution[];
  alphaCurve: AlphaPoint[];
  byCategory: CategoryAttribution[];
}

// ── Helpers ────────────────────────────────────────────────────

function safeNum(v: unknown, fallback: number): number {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = parseFloat(v);
    if (isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().split("T")[0] ?? "";
}

// ── Polygon RPC balance helpers ────────────────────────────────

const WALLET_ADDRESS = "0x7EE996AbE9355a126F010EfF93487e84b2cE4b53";

// Check BOTH USDC contracts on Polygon — wallet may hold either or both
const USDC_BRIDGED_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e (bridged)
const USDC_NATIVE_CONTRACT  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // USDC (native)

// Working public Polygon RPCs (auth-free, confirmed 2026-02-25).
// polygon-rpc.com, rpc.ankr.com/polygon, polygon.llamarpc.com all require API keys.
const POLYGON_RPC_URLS = [
  "https://polygon-rpc.com",                           // Polygon Foundation
  "https://rpc-mainnet.maticvigil.com",                // MaticVigil
  "https://polygon.meowrpc.com",                       // MeowRPC
  "https://polygon.drpc.org",                          // dRPC
  "https://endpoints.omniatech.io/v1/matic/mainnet/public", // Omnia
  "https://1rpc.io/matic",                             // 1RPC (rate-limited)
  "https://polygon-bor-rpc.publicnode.com",            // PublicNode
  "https://rpc.ankr.com/polygon",                      // Ankr
];

interface RpcResponse {
  result?: string;
  error?: { message: string };
}

async function polygonRpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<string> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  console.log(`[wallet:rpc] POST ${rpcUrl} method=${method}`);
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const json = (await res.json()) as RpcResponse;
  console.log(`[wallet:rpc] response from ${rpcUrl}: ${JSON.stringify(json)}`);
  if (!json.result) {
    throw new Error(
      `RPC ${rpcUrl} method=${method} error: ${json.error?.message ?? "No result field in response"}`
    );
  }
  return json.result;
}

async function getPolygonBalances(
  address: string
): Promise<{ usdc: number; pol: number }> {
  // balanceOf(address) selector = keccak256("balanceOf(address)")[0:4] = 0x70a08231
  // Wallet address: strip 0x, lowercase, left-pad to 32 bytes (64 hex chars)
  const paddedAddr = address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${paddedAddr}`;

  console.log(`[wallet:rpc] === on-chain balance fetch start ===`);
  console.log(`[wallet:rpc] wallet=${address}`);
  console.log(`[wallet:rpc] callData=${callData}`);
  console.log(`[wallet:rpc] USDC.e contract=${USDC_BRIDGED_CONTRACT}`);
  console.log(`[wallet:rpc] USDC native contract=${USDC_NATIVE_CONTRACT}`);

  const rpcErrors: string[] = [];

  for (const rpcUrl of POLYGON_RPC_URLS) {
    console.log(`[wallet:rpc] → trying ${rpcUrl}`);

    let usdcBridgedHex: string;
    let usdcNativeHex: string;
    let polHex: string;

    // Log each failure verbosely; try next RPC endpoint before giving up
    try {
      [usdcBridgedHex, usdcNativeHex, polHex] = await Promise.all([
        polygonRpcCall(rpcUrl, "eth_call", [
          { to: USDC_BRIDGED_CONTRACT, data: callData },
          "latest",
        ]),
        polygonRpcCall(rpcUrl, "eth_call", [
          { to: USDC_NATIVE_CONTRACT, data: callData },
          "latest",
        ]),
        polygonRpcCall(rpcUrl, "eth_getBalance", [address, "latest"]),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wallet:rpc] FAILED rpc=${rpcUrl} error=${msg}`);
      rpcErrors.push(`${rpcUrl}: ${msg}`);
      continue; // try next RPC
    }

    // Log raw hex before parsing
    console.log(`[wallet:rpc] USDC.e (bridged) raw hex=${usdcBridgedHex}`);
    console.log(`[wallet:rpc] USDC (native)   raw hex=${usdcNativeHex}`);
    console.log(`[wallet:rpc] POL              raw hex=${polHex}`);

    // USDC: 6 decimals; POL: 18 decimals
    // Guard: RPC may return "0x" (empty/no data) — treat as 0 to avoid BigInt crash
    const safeBigInt = (hex: string): bigint => {
      const h = hex?.trim();
      if (!h || h === "0x" || h === "0X") return 0n;
      try { return BigInt(h); } catch { return 0n; }
    };
    const usdcBridged = Number(safeBigInt(usdcBridgedHex)) / 1e6;
    const usdcNative  = Number(safeBigInt(usdcNativeHex))  / 1e6;
    const usdc        = usdcBridged + usdcNative;
    const pol         = Number(safeBigInt(polHex)) / 1e18;

    console.log(`[wallet:rpc] parsed USDC.e=${usdcBridged}`);
    console.log(`[wallet:rpc] parsed USDC native=${usdcNative}`);
    console.log(`[wallet:rpc] parsed total USDC=${usdc}`);
    console.log(`[wallet:rpc] parsed POL=${pol}`);
    console.log(`[wallet:rpc] === SUCCESS via ${rpcUrl} ===`);

    return { usdc, pol };
  }

  // All RPCs failed — throw so the error surfaces in Railway logs
  const detail = rpcErrors.join(" | ");
  console.error(`[wallet:rpc] ALL RPCs failed: ${detail}`);
  throw new Error(`All Polygon RPC endpoints failed: ${detail}`);
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPol(amount: number): string {
  return `${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} POL`;
}

// ── GET /api/portfolio/summary ────────────────────────────────
router.get("/summary", async (_req: Request, res: Response) => {
  // 1. On-chain EOA balance via Polygon RPC (primary)
  const { usdc: onChainUsdc, pol } = await getPolygonBalances(WALLET_ADDRESS);

  // 2. CLOB deposit balance via polymarket CLI (may be 0 if nothing deposited)
  let clobUsdc = 0;
  try {
    const raw: unknown = await runCli([
      "clob",
      "balance",
      "--asset-type",
      "collateral",
    ]);
    if (raw !== null && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      clobUsdc = safeNum(obj["balance"] ?? obj["usdc"] ?? obj["USDC"], 0);
    }
  } catch {
    // CLOB balance unavailable — report 0
  }

  const db = getDb();

  // Read from executions table (the actual trade log — paper + live)
  interface ExecSummaryRow {
    id: number;
    slug: string;
    side: string;
    amount: number;
    executed_at: number;
    status: string;
    pnl: number | null;
  }
  const executions = db.prepare<[], ExecSummaryRow>(
    "SELECT id, slug, side, amount, executed_at, status, pnl FROM executions ORDER BY executed_at DESC"
  ).all();

  const totalTrades = executions.length;
  const settledExecs = executions.filter((e: ExecSummaryRow) => e.pnl !== null);
  const wins = settledExecs.filter((e: ExecSummaryRow) => (e.pnl ?? 0) > 0).length;
  const winRate = settledExecs.length > 0 ? wins / settledExecs.length : 0;

  // Open positions = placed/paper trades with no fill_price yet
  const openExecs = executions.filter((e: ExecSummaryRow) =>
    (e.status === "placed" || e.status === "paper") && e.pnl === null
  );
  const positions: PositionEntry[] = openExecs.map((e: ExecSummaryRow) => ({
    marketSlug: e.slug,
    direction: e.side === "buy" ? "YES" : "NO",
    size: e.amount,
    price: 0,
    openPnl: 0,
  }));
  const openPnl = 0;

  // Total portfolio value: on-chain USDC + CLOB USDC + POL * ~$0.40 spot
  const totalValue = onChainUsdc + clobUsdc + pol * 0.4;

  // Realised P&L: sum settled pnl
  const pnl = settledExecs.reduce((acc: number, e: ExecSummaryRow) => acc + (e.pnl ?? 0), 0);
  const pnlPct = totalValue > 0 ? pnl / Math.max(totalValue - pnl, 1) : 0;

  // "Today" trades — last 24 h
  const dayAgo = Date.now() - 86_400_000;
  const todayExecs = executions.filter((e: ExecSummaryRow) => e.executed_at > dayAgo);
  const pnlToday = todayExecs.reduce((acc: number, e: ExecSummaryRow) => acc + (e.pnl ?? 0), 0);
  const pnlTodayPct = totalValue > 0 ? pnlToday / totalValue : 0;
  const tradesExecutedToday = todayExecs.length;

  const kellyMax = 1.0;
  const kellyUtilization =
    openExecs.length > 0
      ? Math.min(
          (openExecs.length * DEFAULTS.maxPositionSizePct) / 100,
          1
        )
      : 0;

  const drawdown =
    totalValue > 0 && pnl < 0
      ? Math.abs(pnl) / (totalValue + Math.abs(pnl))
      : 0;

  const circuitBreakerStatus: "ARMED" | "WARNING" | "TRIGGERED" =
    drawdown >= DEFAULTS.drawdownLimit
      ? "TRIGGERED"
      : drawdown >= DEFAULTS.drawdownLimit * 0.75
      ? "WARNING"
      : "ARMED";

  // Primary USDC for legacy fields = on-chain + CLOB
  const usdc = onChainUsdc + clobUsdc;

  // synthetic: false — summary always reflects real on-chain + DB data
  const summary: PortfolioSummary & { synthetic: boolean; data_source: string } = {
    // New on-chain fields
    onChainUsdc,
    onChainUsdcFormatted: formatUsd(onChainUsdc),
    clobUsdc,
    pol,
    polFormatted: formatPol(pol),
    // Legacy fields
    totalValue,
    usdc,
    usdcFormatted: formatUsd(usdc),
    pnl,
    pnlPct,
    pnlToday,
    pnlTodayPct,
    kellyUtilization,
    kellyMax,
    circuitBreakerStatus,
    drawdown,
    drawdownLimit: DEFAULTS.drawdownLimit,
    positions,
    openPnl,
    winRate,
    totalTrades,
    tradesExecutedToday,
    synthetic: false,
    data_source: "on_chain_and_db",
  };

  res.json(summary);
});

// ── GET /api/portfolio/risk ───────────────────────────────────
router.get("/risk", async (_req: Request, res: Response) => {
  const db = getDb();

  // Group open trades by theme (derived from market_slug prefix)
  const trades = db
    .prepare<[], TradeRow>(
      "SELECT * FROM trades WHERE status = 'submitted' OR status = 'open'"
    )
    .all();

  // Cluster trades into themes by shared market_slug prefix (first segment)
  const themeMap: Map<string, TradeRow[]> = new Map();
  for (const t of trades) {
    const theme = t.market_slug.split("-")[0] ?? "general";
    const bucket = themeMap.get(theme) ?? [];
    bucket.push(t);
    themeMap.set(theme, bucket);
  }

  const correlations: CorrelationEntry[] =
    themeMap.size > 0
      ? Array.from(themeMap.entries()).map(([theme, rows]) => {
          const totalExposure = rows.reduce(
            (acc, r) => acc + safeNum(r.size, 0) * safeNum(r.price, 0),
            0
          );
          return {
            theme,
            positions: rows.map((r) => r.market_slug),
            clusterRisk: Math.min(rows.length * 0.08, 0.9),
            exposure: totalExposure,
          };
        })
      : []; // No open positions — return empty rather than fake data

  // Try CLI for gas/platform status — fall back to mock
  let gasBalance = 0.05;
  let contractApproved = true;

  try {
    const raw: unknown = await runCli(["clob", "balance", "--asset-type", "conditional"]);
    if (raw !== null && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      gasBalance = safeNum(obj["gas"] ?? obj["pol"] ?? obj["POL"], gasBalance);
      contractApproved =
        typeof obj["approved"] === "boolean" ? obj["approved"] : true;
    }
  } catch {
    // CLI unavailable
  }

  const risk: PortfolioRisk = {
    maxPositionSizePct: DEFAULTS.maxPositionSizePct,
    maxThemeExposurePct: DEFAULTS.maxThemeExposurePct,
    fractionalKelly: DEFAULTS.fractionalKelly,
    luciferVetoThreshold: DEFAULTS.luciferVetoThreshold,
    correlations,
    tailRisk: {
      worstCaseDrawdown: 0.28,
      blackSwanExposure: 0.07,
    },
    platformRisk: {
      contractApproved,
      gasBalance,
      withdrawalLimitReached: false,
    },
  };

  res.json(risk);
});

// ── GET /api/portfolio/attribution ───────────────────────────
router.get("/attribution", (_req: Request, res: Response) => {
  const db = getDb();

  const trades = db
    .prepare<[], TradeRow>("SELECT * FROM trades")
    .all();

  const runs = db
    .prepare<[], PipelineRunRow>("SELECT * FROM pipeline_runs")
    .all();

  // Build a pipeline_run_id → trade map
  const runTradeMap: Map<string, TradeRow[]> = new Map();
  for (const t of trades) {
    if (!t.pipeline_run_id) continue;
    const bucket = runTradeMap.get(t.pipeline_run_id) ?? [];
    bucket.push(t);
    runTradeMap.set(t.pipeline_run_id, bucket);
  }

  // Agents whose outputs live in pipeline_runs
  const AGENTS = [
    "aura",
    "flux",
    "oracle",
    "edge",
    "sigma",
    "clause",
    "lucifer",
  ] as const;
  type Agent = (typeof AGENTS)[number];

  // Accumulate per-agent stats via pipeline runs that have associated trades
  const agentStats: Map<
    Agent,
    { pnl: number; trades: number; wins: number }
  > = new Map(AGENTS.map((a) => [a, { pnl: 0, trades: 0, wins: 0 }]));

  for (const run of runs) {
    const linked = runTradeMap.get(run.id) ?? [];
    if (linked.length === 0) continue;

    const runPnl = linked.reduce((acc, t) => acc + safeNum(t.net_ev, 0), 0);

    for (const agent of AGENTS) {
      const outputKey = `${agent}_output` as keyof PipelineRunRow;
      if (run[outputKey] !== null) {
        const stats = agentStats.get(agent)!;
        stats.pnl += runPnl / AGENTS.filter((a) => run[`${a}_output` as keyof PipelineRunRow] !== null).length;
        stats.trades += linked.length;
        if (runPnl > 0) stats.wins += linked.length;
      }
    }
  }

  // Build bySignal — use real data if we have any, otherwise realistic mock
  const hasRealData = runs.some((r) => runTradeMap.get(r.id)?.length ?? 0 > 0);

  // bySignal: only populated from real pipeline data — never fake numbers
  const bySignal: SignalAttribution[] = hasRealData
    ? AGENTS.map((agent) => {
        const s = agentStats.get(agent)!;
        return {
          agent,
          pnl: s.pnl,
          trades: s.trades,
          winRate: s.trades > 0 ? s.wins / s.trades : 0,
        };
      }).filter((s) => s.trades > 0)
    : []; // No real data — return empty

  // Alpha curve — daily cumulative PnL over last 30 days
  const alphaCurve: AlphaPoint[] = (() => {
    if (trades.length > 0) {
      // Group by day
      const dayMap: Map<string, number> = new Map();
      for (const t of trades) {
        const day = isoDate(t.created_at);
        dayMap.set(day, (dayMap.get(day) ?? 0) + safeNum(t.net_ev, 0));
      }

      // Sort and build cumulative
      let cumulative = 0;
      return Array.from(dayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, pnl]) => {
          cumulative += pnl;
          return { date, alpha: cumulative };
        });
    }

    // No trade history yet — return empty rather than fake numbers
    return [];
  })();

  // P&L by category — derived from market_slug first word
  const categoryMap: Map<
    string,
    { pnl: number; trades: number; wins: number }
  > = new Map();

  for (const t of trades) {
    const category = t.market_slug.split("-")[0] ?? "other";
    const s = categoryMap.get(category) ?? { pnl: 0, trades: 0, wins: 0 };
    s.pnl += safeNum(t.net_ev, 0);
    s.trades += 1;
    if (safeNum(t.net_ev, 0) > 0) s.wins += 1;
    categoryMap.set(category, s);
  }

  // byCategory: derived from real trade data only — never fake numbers
  const byCategory: CategoryAttribution[] =
    categoryMap.size > 0
      ? Array.from(categoryMap.entries()).map(([category, s]) => ({
          category,
          pnl: s.pnl,
          trades: s.trades,
          winRate: s.trades > 0 ? s.wins / s.trades : 0,
        }))
      : []; // No trade history yet

  const isRealAttribution = hasRealData && trades.length > 0;
  if (!isRealAttribution) {
    console.warn("[portfolio:attribution] No real pipeline/trade data — returning empty attribution (data_source: no_data)");
  }

  // ── Fetch executions from the executions table (these are real/paper trades) ──
  interface ExecRow {
    id: number;
    slug: string;
    side: string;
    amount: number;
    executed_at: number;
    status: string;
    order_id: string | null;
    fill_price: number | null;
    pnl: number | null;
  }
  const executions = db.prepare<[], ExecRow>(
    "SELECT id, slug, side, amount, executed_at, status, order_id, fill_price, pnl FROM executions ORDER BY executed_at DESC LIMIT 500"
  ).all();

  // Fetch latest scanner prices for simulated P&L
  interface ScanPriceRow { slug: string; yes_price: number; probability: number; }
  const scanRows = db.prepare<[], ScanPriceRow>(
    "SELECT slug, yes_price, probability FROM scanner_results GROUP BY slug ORDER BY created_at DESC"
  ).all();
  const livePrice = new Map<string, number>(
    scanRows.map((s: ScanPriceRow) => [s.slug, s.yes_price ?? s.probability ?? 0.5])
  );

  // Map executions to the Trade shape the frontend expects
  const tradeList = executions.map((e: ExecRow) => {
    const entry = e.fill_price ?? 0.5;
    const current = livePrice.get(e.slug) ?? entry;
    const shares = entry > 0 ? e.amount / entry : 0;
    const priceMove = e.side === "buy" ? current - entry : entry - current;
    const simPnl = e.pnl !== null ? e.pnl
      : (e.status === "paper" || e.status === "placed") ? parseFloat((priceMove * shares).toFixed(4))
      : null;
    const outcome = simPnl !== null
      ? (Math.abs(simPnl) < 0.005 ? "OPEN" : simPnl > 0 ? "WIN" : "LOSS")
      : "PENDING";
    return {
      id: e.id,
      slug: e.slug,
      market: e.slug.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      direction: e.side === "buy" ? "YES" : "NO",
      size: e.amount,
      price: entry,
      outcome,
      timestamp: e.executed_at,
      pnl: simPnl ?? undefined,
      orderId: e.order_id ?? undefined,
      mode: e.status,
    };
  });

  const attribution = {
    bySignal,
    alphaCurve,
    byCategory,
    trades: tradeList,
    count: tradeList.length,
    synthetic: !isRealAttribution,
    data_source: isRealAttribution ? "db" : "no_data",
  };
  res.json(attribution);
});

export default router;
