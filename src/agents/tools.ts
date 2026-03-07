// ── Agent Tools — callable functions for the personalized agent chat ──────────
//
// Each tool has:
//   1. A Gemini function declaration (schema for the LLM)
//   2. An execute() function that calls internal APIs/DB directly
//
// Tools are executed server-side — the LLM never gets raw DB access.

import { getDb } from "../db/schema";
import { getCircuitBreaker, getPortfolioManager, getCorrelationMonitor } from "../risk";

// ── Types ────────────────────────────────────────────────────────────────────

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ToolResult {
  name: string;
  data: unknown;
}

// ── Tool Declarations (sent to Gemini) ───────────────────────────────────────

export const TOOL_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: "get_portfolio",
    description: "Get the user's current portfolio: balance, active positions, total P&L, and exposure. Use when the user asks about their portfolio, positions, balance, or P&L.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_risk_status",
    description: "Get current risk status: circuit breaker state, drawdown, daily P&L, exposure percentage, and risk configuration. Use when the user asks about risk, circuit breakers, drawdown, or safety.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_trade_history",
    description: "Get recent trade history with outcomes (WIN/LOSS/OPEN), P&L, and win rate. Use when the user asks about past trades, trade history, or performance.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent trades to return (default 10, max 50)" },
      },
      required: [],
    },
  },
  {
    name: "search_markets",
    description: "Search for available prediction markets on Polymarket. Use when the user asks to find markets, explore categories, or look up a specific topic.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or market slug" },
        category: {
          type: "string",
          description: "Category filter",
          enum: ["crypto", "politics", "sports", "pop-culture", "science", "world", "business"],
        },
      },
      required: [],
    },
  },
  {
    name: "run_analysis",
    description: "Trigger a full 7-agent pipeline analysis on a specific market. Returns the pipeline run ID. Use when the user asks to analyze a market, run the pipeline, or get a signal on a market slug.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The market slug to analyze (e.g. 'will-bitcoin-hit-100k')" },
      },
      required: ["slug"],
    },
  },
  {
    name: "place_trade",
    description: "Place a trade on a prediction market. IMPORTANT: Always confirm with the user before calling this. Use when the user explicitly asks to buy/trade/bet on a market.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Market slug" },
        direction: { type: "string", description: "Trade direction", enum: ["YES", "NO"] },
        size: { type: "number", description: "Trade size in USDC" },
      },
      required: ["slug", "direction", "size"],
    },
  },
  {
    name: "get_scanner_signals",
    description: "Get recent scanner signals — high-confidence market opportunities detected by the automated scanner. Use when the user asks about signals, opportunities, or what the scanner found.",
    parameters: {
      type: "object",
      properties: {
        alerts_only: { type: "string", description: "If 'true', only return high-confidence alerts (sigma >= 0.70, kelly >= 0.40)" },
      },
      required: [],
    },
  },
];

// ── Tool Executors ───────────────────────────────────────────────────────────

async function executeGetPortfolio(): Promise<unknown> {
  const db = getDb();
  const portfolio = getPortfolioManager();
  const totalCapital = await portfolio.getTotalCapital();
  const deployed = portfolio.getDeployedCapital();
  const available = await portfolio.getAvailableCapital();
  const dailyPnl = portfolio.getDailyPnL();

  const rows = db.prepare(
    "SELECT slug, side, amount, fill_price, executed_at FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL"
  ).all() as any[];

  const priceRows = db.prepare(
    `SELECT s.slug, s.probability FROM scanner_results s
     INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) latest
     ON s.slug = latest.slug AND s.scanned_at = latest.latest`
  ).all() as any[];
  const currentPrices = new Map(priceRows.map((r: any) => [r.slug, r.probability]));

  const positions = rows.map((e: any) => {
    const current = currentPrices.get(e.slug) ?? e.fill_price ?? 0.5;
    const entry = e.fill_price ?? 0.5;
    const shares = entry > 0 ? e.amount / entry : 0;
    const pnl = e.side === "buy" ? (current - entry) * shares : (entry - current) * shares;
    return {
      slug: e.slug,
      direction: e.side === "buy" ? "YES" : "NO",
      size: e.amount,
      entryPrice: entry,
      currentPrice: current,
      pnl: Math.round(pnl * 100) / 100,
    };
  });

  return {
    totalCapital: Math.round(totalCapital * 100) / 100,
    deployedCapital: Math.round(deployed * 100) / 100,
    availableCapital: Math.round(available * 100) / 100,
    exposurePct: totalCapital > 0 ? Math.round((deployed / totalCapital) * 10000) / 100 : 0,
    dailyPnl: Math.round(dailyPnl * 100) / 100,
    positionCount: positions.length,
    positions,
  };
}

async function executeGetRiskStatus(): Promise<unknown> {
  const portfolio = getPortfolioManager();
  const correlation = getCorrelationMonitor();
  const cb = getCircuitBreaker();
  const cbStatus = await cb.checkAndTrip();
  const totalCapital = await portfolio.getTotalCapital();
  const deployed = portfolio.getDeployedCapital();
  const dailyPnl = portfolio.getDailyPnL();

  const themeExposure: Record<string, number> = {};
  for (const [theme, exposure] of correlation.getThemeExposure()) {
    themeExposure[theme] = exposure;
  }

  const db = getDb();
  const gcb = db.prepare<[], { drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number }>(
    `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
     FROM global_circuit_breakers gcb
     JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
     WHERE rc.is_active = 1 LIMIT 1`
  ).get();

  return {
    circuitBreaker: cbStatus.state,
    totalCapital: Math.round(totalCapital * 100) / 100,
    deployedCapital: Math.round(deployed * 100) / 100,
    exposurePct: totalCapital > 0 ? Math.round((deployed / totalCapital) * 10000) / 100 : 0,
    dailyPnl: Math.round(dailyPnl * 100) / 100,
    dailyPnlPct: totalCapital > 0 ? Math.round((dailyPnl / totalCapital) * 10000) / 100 : 0,
    themeExposure,
    maxDrawdownPct: gcb?.drawdown_limit_pct ?? 0.15,
    maxPositionSizePct: gcb?.max_position_size_pct ?? 0.10,
    kellyFraction: gcb?.kelly_fraction_multiplier ?? 0.25,
  };
}

function executeGetTradeHistory(args: { limit?: number }): unknown {
  const db = getDb();
  const limit = Math.min(Math.max(1, args.limit ?? 10), 50);

  const executions = db.prepare(
    "SELECT * FROM executions ORDER BY executed_at DESC LIMIT ?"
  ).all(limit) as any[];

  const priceRows = db.prepare(
    `SELECT s.slug, s.probability FROM scanner_results s
     INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) t
     ON s.slug = t.slug AND s.scanned_at = t.latest`
  ).all() as any[];
  const livePrice = new Map(priceRows.map((r: any) => [r.slug, r.probability]));

  const trades = executions.map((e: any) => {
    const entry = e.fill_price ?? 0.5;
    const current = livePrice.get(e.slug) ?? entry;
    const shares = entry > 0 ? e.amount / entry : 0;
    const pnl = e.side === "buy" ? (current - entry) * shares : (entry - current) * shares;
    let outcome = "OPEN";
    if (e.pnl !== null) outcome = e.pnl > 0 ? "WIN" : "LOSS";
    else if (e.status === "failed") outcome = "LOSS";

    return {
      slug: e.slug,
      direction: e.side === "buy" ? "YES" : "NO",
      size: e.amount,
      price: entry,
      outcome,
      pnl: Math.round((e.pnl ?? pnl) * 100) / 100,
      timestamp: e.executed_at,
      mode: e.status,
    };
  });

  const settled = trades.filter((t: any) => t.outcome !== "OPEN");
  const wins = settled.filter((t: any) => t.outcome === "WIN").length;

  return {
    trades,
    count: trades.length,
    winRate: settled.length > 0 ? Math.round((wins / settled.length) * 10000) / 100 : 0,
    totalPnl: Math.round(trades.reduce((sum: number, t: any) => sum + t.pnl, 0) * 100) / 100,
  };
}

async function executeSearchMarkets(args: { query?: string; category?: string }): Promise<unknown> {
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    order: "volume24hr",
    ascending: "false",
    limit: "10",
  });

  let url: string;
  if (args.query) {
    url = `https://gamma-api.polymarket.com/markets?${params.toString()}&slug_contains=${encodeURIComponent(args.query)}`;
  } else {
    url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;
  }

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return { error: "Market search unavailable", markets: [] };

  const raw = await res.json() as any[];
  if (!Array.isArray(raw)) return { markets: [], count: 0 };

  const markets = raw.slice(0, 10).map((m: any) => {
    let outcomePrices: number[] = [];
    try {
      const parsed = JSON.parse(m.outcomePrices ?? "[]");
      if (Array.isArray(parsed)) outcomePrices = parsed.map((p: unknown) => parseFloat(String(p)) || 0);
    } catch { /* ignore */ }

    return {
      slug: m.slug ?? "",
      question: m.question ?? "",
      yesPrice: outcomePrices[1] ?? 0,
      noPrice: outcomePrices[0] ?? 0,
      volume24hr: m.volume24hr ?? 0,
      liquidity: m.liquidity ?? 0,
    };
  });

  return { markets, count: markets.length };
}

async function executeRunAnalysis(args: { slug: string }): Promise<unknown> {
  const BACKEND_HOST = `http://localhost:${process.env.PORT || "3001"}`;
  try {
    const res = await fetch(`${BACKEND_HOST}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: args.slug }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) return { error: `Pipeline returned ${res.status}`, slug: args.slug };

    const text = await res.text();
    const lines = text.split("\n");
    let decision: string | null = null;
    let confidence: number | null = null;
    let runId: string | null = null;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (data.runId) runId = data.runId as string;
          if (data.decision) decision = data.decision as string;
          if (data.confidence) confidence = data.confidence as number;
        } catch { /* skip */ }
      }
    }

    return {
      slug: args.slug,
      runId,
      decision: decision ?? "UNKNOWN",
      confidence: confidence ?? 0,
      message: `Pipeline analysis complete for ${args.slug}. Decision: ${decision ?? "UNKNOWN"} at ${confidence ?? 0}% confidence.`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Pipeline failed", slug: args.slug };
  }
}

function executePlaceTrade(args: { slug: string; direction: string; size: number }): unknown {
  // Don't execute — return a confirmation request for the frontend
  return {
    action: "trade_confirmation_required",
    slug: args.slug,
    direction: args.direction,
    size: args.size,
    message: `Ready to place ${args.direction} trade on ${args.slug} for $${args.size} USDC. Awaiting your confirmation.`,
  };
}

function executeGetScannerSignals(args: { alerts_only?: string }): unknown {
  const db = getDb();
  const alertsOnly = args.alerts_only === "true";

  let query = "SELECT * FROM scanner_results WHERE 1=1";
  if (alertsOnly) {
    query += " AND sigma_confidence >= 0.70 AND kelly_fraction >= 0.40";
  }
  query += " ORDER BY scanned_at DESC LIMIT 10";

  const rows = db.prepare(query).all() as any[];

  const signals = rows.map((r: any) => ({
    slug: r.slug,
    sigmaConfidence: r.sigma_confidence,
    kellyFraction: r.kelly_fraction,
    recommendation: r.recommendation,
    probability: r.probability,
    scannedAt: r.scanned_at,
  }));

  return { signals, count: signals.length };
}

// ── Tool Executor Dispatch ───────────────────────────────────────────────────

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "get_portfolio":
      return { name, data: await executeGetPortfolio() };
    case "get_risk_status":
      return { name, data: await executeGetRiskStatus() };
    case "get_trade_history":
      return { name, data: executeGetTradeHistory(args as { limit?: number }) };
    case "search_markets":
      return { name, data: await executeSearchMarkets(args as { query?: string; category?: string }) };
    case "run_analysis":
      return { name, data: await executeRunAnalysis(args as { slug: string }) };
    case "place_trade":
      return { name, data: executePlaceTrade(args as { slug: string; direction: string; size: number }) };
    case "get_scanner_signals":
      return { name, data: executeGetScannerSignals(args as { alerts_only?: string }) };
    default:
      return { name, data: { error: `Unknown tool: ${name}` } };
  }
}
