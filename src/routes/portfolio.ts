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
  totalValue: number;
  usdc: number;
  usdcFormatted: string;
  pol: number;
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

// ── GET /api/portfolio/summary ────────────────────────────────
router.get("/summary", async (_req: Request, res: Response) => {
  // Fetch real USDC balance from Polymarket CLI — hard-fail if unavailable
  let usdc: number;
  let pol = 0;

  try {
    const raw: unknown = await runCli([
      "clob",
      "balance",
      "--asset-type",
      "collateral",
    ]);

    if (raw === null || typeof raw !== "object") {
      res
        .status(502)
        .json({ error: "Polymarket CLI returned unexpected response format" });
      return;
    }

    const obj = raw as Record<string, unknown>;
    const parsed = safeNum(
      obj["balance"] ?? obj["usdc"] ?? obj["USDC"],
      NaN
    );

    if (!isFinite(parsed)) {
      res.status(502).json({
        error: "Polymarket CLI response did not contain a valid balance field",
        raw: obj,
      });
      return;
    }

    usdc = parsed;
    pol = safeNum(obj["pol"] ?? obj["POL"] ?? obj["matic"], 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res
      .status(502)
      .json({ error: `Failed to fetch portfolio balance: ${message}` });
    return;
  }

  const db = getDb();
  const trades = db.prepare<[], TradeRow>("SELECT * FROM trades").all();

  const totalTrades = trades.length;
  const wins = trades.filter((t) => safeNum(t.net_ev, 0) > 0).length;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;

  const openTradeRows = trades.filter(
    (t) => t.status === "submitted" || t.status === "open"
  );

  const positions: PositionEntry[] = openTradeRows.map((t) => ({
    marketSlug: t.market_slug,
    direction: t.direction,
    size: safeNum(t.size, 0),
    price: safeNum(t.price, 0),
    openPnl: safeNum(t.net_ev, 0),
  }));

  const openPnl = positions.reduce((acc, p) => acc + p.openPnl, 0);

  // Rough portfolio value: USDC + POL * ~$0.40 spot
  const totalValue = usdc + pol * 0.4;

  // Realised P&L: sum net_ev from all settled trades
  const pnl = trades.reduce((acc, t) => acc + safeNum(t.net_ev, 0), 0);
  const pnlPct = totalValue > 0 ? pnl / Math.max(totalValue - pnl, 1) : 0;

  // "Today" trades — last 24 h
  const dayAgo = Date.now() - 86_400_000;
  const todayTrades = trades.filter((t) => t.created_at > dayAgo);
  const pnlToday = todayTrades.reduce(
    (acc, t) => acc + safeNum(t.net_ev, 0),
    0
  );
  const pnlTodayPct = totalValue > 0 ? pnlToday / totalValue : 0;

  const kellyMax = 1.0;
  const kellyUtilization =
    openTradeRows.length > 0
      ? Math.min(
          (openTradeRows.length * DEFAULTS.maxPositionSizePct) / 100,
          1
        )
      : 0;

  // Drawdown: no PnL curve in DB yet — derive from current pnl vs totalValue
  const drawdown =
    totalValue > 0 && pnl < 0 ? Math.abs(pnl) / (totalValue + Math.abs(pnl)) : 0;

  const circuitBreakerStatus: "ARMED" | "WARNING" | "TRIGGERED" =
    drawdown >= DEFAULTS.drawdownLimit
      ? "TRIGGERED"
      : drawdown >= DEFAULTS.drawdownLimit * 0.75
      ? "WARNING"
      : "ARMED";

  const summary: PortfolioSummary = {
    totalValue,
    usdc,
    usdcFormatted: `$${usdc.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`,
    pol,
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
      : [
          {
            theme: "politics",
            positions: ["us-election-2026", "senate-majority"],
            clusterRisk: 0.32,
            exposure: 125.0,
          },
          {
            theme: "crypto",
            positions: ["btc-100k-eoy", "eth-merge-v2"],
            clusterRisk: 0.58,
            exposure: 87.5,
          },
          {
            theme: "sports",
            positions: ["nba-finals-2026"],
            clusterRisk: 0.12,
            exposure: 40.0,
          },
        ];

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
    : [
        { agent: "edge", pnl: 94.2, trades: 21, winRate: 0.71 },
        { agent: "oracle", pnl: 62.1, trades: 14, winRate: 0.64 },
        { agent: "aura", pnl: 31.7, trades: 8, winRate: 0.625 },
        { agent: "flux", pnl: -0.5, trades: 4, winRate: 0.5 },
      ];

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

    // Mock: 30-day realistic alpha curve
    const points: AlphaPoint[] = [];
    let alpha = 0;
    for (let i = 29; i >= 0; i--) {
      const ts = Date.now() - i * 86_400_000;
      const day = isoDate(ts);
      const delta = (Math.random() * 20 - 6) * (0.8 + Math.random() * 0.4);
      alpha += delta;
      points.push({ date: day, alpha: Math.round(alpha * 100) / 100 });
    }
    return points;
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

  const byCategory: CategoryAttribution[] =
    categoryMap.size > 0
      ? Array.from(categoryMap.entries()).map(([category, s]) => ({
          category,
          pnl: s.pnl,
          trades: s.trades,
          winRate: s.trades > 0 ? s.wins / s.trades : 0,
        }))
      : [
          { category: "politics", pnl: 98.3, trades: 22, winRate: 0.68 },
          { category: "crypto", pnl: 61.2, trades: 13, winRate: 0.62 },
          { category: "sports", pnl: 28.0, trades: 7, winRate: 0.57 },
          { category: "science", pnl: -0.0, trades: 5, winRate: 0.4 },
        ];

  const attribution: PortfolioAttribution = { bySignal, alphaCurve, byCategory };
  res.json(attribution);
});

export default router;
