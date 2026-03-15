// ── Agent Tools — callable functions for the personalized agent chat ──────────
//
// Each tool has:
//   1. A Gemini function declaration (schema for the LLM)
//   2. An execute() function that calls internal APIs/DB directly
//
// Tools are executed server-side — the LLM never gets raw DB access.

import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne, pgExec } from "../db/postgres";
import {
  loadOpsSnapshot,
  loadPortfolioSnapshot,
  loadRiskSnapshot,
  loadScannerSnapshot,
  loadTradeHistorySnapshot,
  type ToolExecutionContext,
} from "./snapshots";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerDirectionMap,
} from "../utils/executionDirection";
import { loadArenaLeaderboard } from "../performance/arenaService";
import { parseArenaWindow, type ArenaWindow } from "../performance/arena";

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
    name: "get_arena_leaderboard",
    description: "Get the Arena leaderboard for 24h, 7d, or all-time performance, including the current champion and the calling agent's viewer context.",
    parameters: {
      type: "object",
      properties: {
        window: { type: "string", description: "Leaderboard window", enum: ["day", "week", "all"] },
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
  {
    name: "get_pipeline_history",
    description: "Get recent pipeline run history with all agent outputs. Use to review past analyses and decisions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent runs to return (default 5, max 20)" },
      },
      required: [],
    },
  },
  {
    name: "get_agent_status",
    description: "Get the calling agent's own status, wallet address, configuration, and connection info.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "heartbeat",
    description: "Send a heartbeat to maintain 'connected' status. Call every ~5 minutes.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "close_position",
    description: "Close/exit an open position on a prediction market. Computes P&L and marks the position as closed. Use when the agent wants to exit a trade.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Market slug of the position to close" },
      },
      required: ["slug"],
    },
  },
  {
    name: "get_market_price",
    description: "Get the current market price for a specific prediction market on Polymarket. Returns YES/NO prices, volume, and liquidity.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Market slug (e.g. 'will-bitcoin-hit-100k')" },
      },
      required: ["slug"],
    },
  },
  {
    name: "get_risk_config",
    description: "Get the current risk configuration: drawdown limit, max position size, kelly multiplier, and agent VaR thresholds.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_risk_config",
    description: "Update risk configuration parameters. Only provided fields are updated.",
    parameters: {
      type: "object",
      properties: {
        max_position_size: { type: "number", description: "Max position size as fraction (0.01 to 1.0)" },
        drawdown_limit: { type: "number", description: "Max drawdown limit as fraction (0.01 to 1.0)" },
        kelly_multiplier: { type: "number", description: "Kelly fraction multiplier (0.01 to 1.0)" },
      },
      required: [],
    },
  },
  {
    name: "trigger_scanner",
    description: "Trigger the orchestrator market scanner to find new trading opportunities. Returns scan results with candidates found.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pipeline_output",
    description: "Get the full output from all 7 agents in a specific pipeline run. Returns detailed analysis from each agent (AURA, FLUX, CLAUSE, ORACLE, EDGE, LUCIFER, SIGMA).",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Pipeline run ID (UUID)" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "update_webhook_config",
    description: "Update the agent's webhook configuration: endpoint URL and/or event subscriptions.",
    parameters: {
      type: "object",
      properties: {
        endpoint_url: { type: "string", description: "HTTPS webhook endpoint URL" },
        webhook_events: { type: "string", description: "JSON array of event types to subscribe to, e.g. '[\"trade:executed\",\"agent:alert\"]'. Use '[\"*\"]' for all events." },
      },
      required: [],
    },
  },
  {
    name: "get_health_score",
    description: "Get the agent's own health score (0-100) with grade and component breakdown (uptime, error rate, latency, connection).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_polymarket_status",
    description: "Check the agent's Polymarket wallet readiness: funding status (POL + USDC balances), approval status, and what's needed before autonomous trading can begin. Use when the user asks about wallet status, Polymarket approvals, why the agent can't trade, or whether setup is complete.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "run_polymarket_approvals",
    description: "Request submission of the 6 required on-chain USDC.e approval transactions to Polymarket's CTF Exchange and Neg-Risk contracts. This will return a confirmation request — the actual transactions are only submitted after the user explicitly confirms. Only call when the user specifically asks to approve or enable Polymarket trading.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

// ── Tool Executors ───────────────────────────────────────────────────────────

async function executeGetPortfolio(context: ToolExecutionContext | null): Promise<unknown> {
  const portfolio = await loadPortfolioSnapshot(context);
  return {
    totalCapital: portfolio.totalValue ?? 0,
    deployedCapital: portfolio.deployedCapital,
    availableCapital: portfolio.availableCapital,
    exposurePct: portfolio.exposurePct,
    dailyPnl: portfolio.dailyPnl,
    dailyPnlPct: portfolio.dailyPnlPct,
    positionCount: portfolio.positions.length,
    totalPnl: portfolio.pnl,
    totalPnlPct: portfolio.pnlPct,
    balanceStatus: portfolio.balanceStatus,
    balanceMessage: portfolio.balanceMessage,
    fundingStatus: portfolio.fundingStatus,
    fundingMessage: portfolio.fundingMessage,
    positions: portfolio.positions,
  };
}

async function executeGetRiskStatus(context: ToolExecutionContext | null): Promise<unknown> {
  return loadRiskSnapshot(context);
}

async function executeGetTradeHistory(
  args: { limit?: number },
  context: ToolExecutionContext | null,
): Promise<unknown> {
  return loadTradeHistorySnapshot(context, args.limit ?? 10);
}

async function executeGetArenaLeaderboard(
  args: { window?: ArenaWindow },
  context: ToolExecutionContext | null,
): Promise<unknown> {
  return loadArenaLeaderboard(parseArenaWindow(args.window), context?.linkedAgentId ?? null);
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

async function executeGetScannerSignals(args: { alerts_only?: string }): Promise<unknown> {
  return loadScannerSnapshot({
    alertsOnly: args.alerts_only === "true",
    limit: 10,
  });
}

async function executeGetPipelineHistory(args: { limit?: number }): Promise<unknown> {
  const limit = Math.min(Math.max(1, args.limit ?? 5), 20);

  let runs: any[];
  if (isPgEnabled()) {
    runs = await pgQuery(
      "SELECT id, market_slug, market_question, created_at, completed_at, decision, confidence, signal_state FROM pipeline_runs ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
  } else {
    const db = getDb();
    runs = db.prepare(
      "SELECT id, market_slug, market_question, created_at, completed_at, decision, confidence, signal_state FROM pipeline_runs ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as any[];
  }

  return {
    runs: runs.map((r: any) => ({
      id: r.id,
      market_slug: r.market_slug,
      market_question: r.market_question,
      decision: r.decision,
      confidence: r.confidence,
      signal_state: r.signal_state,
      created_at: r.created_at,
      completed_at: r.completed_at,
    })),
    count: runs.length,
  };
}

async function executeGetAgentStatus(context: ToolExecutionContext | null): Promise<unknown> {
  if (!context?.linkedAgentId) return { error: "Agent context not available" };

  let agent: any;
  if (isPgEnabled()) {
    agent = await pgQueryOne(
      `SELECT id, agent_code, status, name, avatar_emoji, agent_type, description,
              wallet_address, connection_status, last_heartbeat, created_at, updated_at, deployed_at
       FROM agents WHERE id = $1`,
      [context.linkedAgentId]
    );
  } else {
    const db = getDb();
    agent = db.prepare(
      `SELECT id, agent_code, status, name, avatar_emoji, agent_type, description,
              wallet_address, connection_status, last_heartbeat, created_at, updated_at, deployed_at
       FROM agents WHERE id = ?`
    ).get(context.linkedAgentId) as any;
  }

  if (!agent) return { error: "Agent not found" };

  return {
    id: agent.id,
    agent_code: agent.agent_code,
    status: agent.status,
    name: agent.name,
    avatar_emoji: agent.avatar_emoji,
    agent_type: agent.agent_type,
    description: agent.description,
    wallet_address: agent.wallet_address,
    connection_status: agent.connection_status,
    last_heartbeat: agent.last_heartbeat,
    created_at: agent.created_at,
    deployed_at: agent.deployed_at,
  };
}

async function executeHeartbeat(context: ToolExecutionContext | null): Promise<unknown> {
  if (!context?.linkedAgentId) return { error: "Agent context not available" };

  const now = Date.now();
  if (isPgEnabled()) {
    await pgExec(
      "UPDATE agents SET last_heartbeat = $1, connection_status = 'connected' WHERE id = $2",
      [now, context.linkedAgentId]
    );
  } else {
    const db = getDb();
    db.prepare(
      "UPDATE agents SET last_heartbeat = ?, connection_status = 'connected' WHERE id = ?"
    ).run(now, context.linkedAgentId);
  }

  return { status: "ok", server_time: now, your_status: "connected" };
}

// ── New Tool Executors (Phase 7 — Full Autonomy) ────────────────────────────

async function executeClosePosition(args: { slug: string }, context: ToolExecutionContext | null): Promise<unknown> {
  if (!context?.linkedAgentId) return { error: "Agent context not available" };

  // Find the open execution for this slug belonging to this agent
  let execution: {
    id: string; slug: string; side: string; direction: string | null; amount: number; fill_price: number | null; status: string;
  } | undefined;

  if (isPgEnabled()) {
    const row = await pgQueryOne<{
      id: string; slug: string; side: string; direction: string | null; amount: number; fill_price: number | null; status: string;
    }>(
      `SELECT id, slug, side, direction, amount, fill_price, status FROM executions
       WHERE slug = $1 AND agent_id = $2 AND status IN ('placed', 'paper') AND pnl IS NULL
       ORDER BY executed_at DESC LIMIT 1`,
      [args.slug, context.linkedAgentId]
    );
    execution = row ?? undefined;
  } else {
    const db = getDb();
    execution = db.prepare(
      `SELECT id, slug, side, direction, amount, fill_price, status FROM executions
       WHERE slug = ? AND agent_id = ? AND status IN ('placed', 'paper') AND pnl IS NULL
       ORDER BY executed_at DESC LIMIT 1`
    ).get(args.slug, context.linkedAgentId) as typeof execution;
  }

  if (!execution) {
    return { error: `No open position found for slug: ${args.slug}` };
  }

  // Get current price for P&L calculation
  let priceRow: { probability: number } | undefined;
  if (isPgEnabled()) {
    const row = await pgQueryOne<{ probability: number }>(
      `SELECT probability FROM scanner_results WHERE slug = $1 ORDER BY scanned_at DESC LIMIT 1`,
      [args.slug]
    );
    priceRow = row ?? undefined;
  } else {
    const db = getDb();
    priceRow = db.prepare(
      `SELECT probability FROM scanner_results WHERE slug = ? ORDER BY scanned_at DESC LIMIT 1`
    ).get(args.slug) as { probability: number } | undefined;
  }

  const scannerDirection = (await getLatestScannerDirectionMap()).get(args.slug);
  const metrics = calculateOpenExecutionMetrics(
    execution,
    priceRow?.probability ?? getEntryYesPrice(execution, scannerDirection),
    scannerDirection
  );

  const now = Date.now();
  const pnlRounded = Math.round(metrics.pnl * 100) / 100;
  if (isPgEnabled()) {
    await pgExec(
      "UPDATE executions SET status = 'closed', pnl = $1, closed_at = $2, updated_at = $3 WHERE id = $4",
      [pnlRounded, now, now, execution.id]
    );
  } else {
    const db = getDb();
    db.prepare(
      "UPDATE executions SET status = 'closed', pnl = ?, closed_at = ?, updated_at = ? WHERE id = ?"
    ).run(pnlRounded, now, now, execution.id);
  }

  return {
    slug: args.slug,
    direction: metrics.direction,
    size: execution.amount,
    entry_price: metrics.entryTokenPrice,
    exit_price: metrics.currentTokenPrice,
    pnl: pnlRounded,
    status: "closed",
  };
}

async function executeGetMarketPrice(args: { slug: string }): Promise<unknown> {
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(args.slug)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) },
    );

    if (!res.ok) return { error: `Polymarket API returned ${res.status}`, slug: args.slug };

    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: `Market not found: ${args.slug}`, slug: args.slug };
    }

    const m = raw[0];
    let outcomePrices: number[] = [];
    try {
      const parsed = JSON.parse(m.outcomePrices ?? "[]");
      if (Array.isArray(parsed)) outcomePrices = parsed.map((p: unknown) => parseFloat(String(p)) || 0);
    } catch { /* ignore */ }

    return {
      slug: m.slug ?? args.slug,
      question: m.question ?? "",
      yesPrice: outcomePrices[1] ?? 0,
      noPrice: outcomePrices[0] ?? 0,
      volume24hr: m.volume24hr ?? 0,
      liquidity: m.liquidity ?? 0,
      lastUpdated: m.updatedAt ?? null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to fetch market price", slug: args.slug };
  }
}

async function executeGetRiskConfig(): Promise<unknown> {
  let cb: { drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number } | undefined;
  let thresholds: { agent_name: string; var_threshold: number; auto_exec_enabled: number }[];

  if (isPgEnabled()) {
    const cbRow = await pgQueryOne<{ drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number }>(
      `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
       FROM global_circuit_breakers gcb
       JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 LIMIT 1`
    );
    cb = cbRow ?? undefined;

    thresholds = await pgQuery<{ agent_name: string; var_threshold: number; auto_exec_enabled: number }>(
      `SELECT at.agent_name, at.var_threshold, at.auto_exec_enabled
       FROM agent_thresholds at
       JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
       WHERE rc.is_active = 1`
    );
  } else {
    const db = getDb();
    cb = db.prepare<[], { drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number }>(
      `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
       FROM global_circuit_breakers gcb
       JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 LIMIT 1`
    ).get();

    thresholds = db.prepare<[], { agent_name: string; var_threshold: number; auto_exec_enabled: number }>(
      `SELECT at.agent_name, at.var_threshold, at.auto_exec_enabled
       FROM agent_thresholds at
       JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
       WHERE rc.is_active = 1`
    ).all();
  }

  const rawMaxPos = cb?.max_position_size_pct ?? 0.1;
  const maxPositionSize = rawMaxPos > 1 ? rawMaxPos / 100 : rawMaxPos;

  return {
    drawdown_limit: cb?.drawdown_limit_pct ?? 0.15,
    max_position_size: maxPositionSize,
    kelly_multiplier: cb?.kelly_fraction_multiplier ?? 0.25,
    agent_thresholds: thresholds.map(t => ({
      agent_name: t.agent_name,
      var_threshold: t.var_threshold,
      auto_exec_enabled: t.auto_exec_enabled === 1,
    })),
  };
}

async function executeUpdateRiskConfig(args: { max_position_size?: number; drawdown_limit?: number; kelly_multiplier?: number }): Promise<unknown> {
  // Get active risk config
  let config: { id: string } | undefined;
  if (isPgEnabled()) {
    const row = await pgQueryOne<{ id: string }>(
      "SELECT id FROM risk_configurations WHERE is_active = 1 LIMIT 1"
    );
    config = row ?? undefined;
  } else {
    const db = getDb();
    config = db.prepare<[], { id: string }>(
      "SELECT id FROM risk_configurations WHERE is_active = 1 LIMIT 1"
    ).get();
  }

  if (!config) return { error: "No active risk configuration found" };

  let cb: { id: string; drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number } | undefined;
  if (isPgEnabled()) {
    const row = await pgQueryOne<typeof cb & {}>(
      "SELECT * FROM global_circuit_breakers WHERE risk_configuration_id = $1 LIMIT 1",
      [config.id]
    );
    cb = row ?? undefined;
  } else {
    const db = getDb();
    cb = db.prepare<[string], { id: string; drawdown_limit_pct: number; max_position_size_pct: number; kelly_fraction_multiplier: number }>(
      "SELECT * FROM global_circuit_breakers WHERE risk_configuration_id = ? LIMIT 1"
    ).get(config.id);
  }

  if (!cb) return { error: "No circuit breaker config found" };

  if (args.max_position_size != null) {
    if (args.max_position_size < 0.01 || args.max_position_size > 1.0) {
      return { error: "max_position_size must be between 0.01 and 1.0" };
    }
  }
  if (args.drawdown_limit != null) {
    if (args.drawdown_limit < 0.01 || args.drawdown_limit > 1.0) {
      return { error: "drawdown_limit must be between 0.01 and 1.0" };
    }
  }
  if (args.kelly_multiplier != null) {
    if (args.kelly_multiplier < 0.01 || args.kelly_multiplier > 1.0) {
      return { error: "kelly_multiplier must be between 0.01 and 1.0" };
    }
  }

  if (isPgEnabled()) {
    const updates: string[] = [];
    const values: (number | string)[] = [];
    let paramIdx = 1;

    if (args.max_position_size != null) {
      updates.push(`max_position_size_pct = $${paramIdx++}`);
      values.push(args.max_position_size);
    }
    if (args.drawdown_limit != null) {
      updates.push(`drawdown_limit_pct = $${paramIdx++}`);
      values.push(args.drawdown_limit);
    }
    if (args.kelly_multiplier != null) {
      updates.push(`kelly_fraction_multiplier = $${paramIdx++}`);
      values.push(args.kelly_multiplier);
    }

    if (updates.length === 0) return { error: "No fields to update" };

    values.push(cb.id);
    await pgExec(
      `UPDATE global_circuit_breakers SET ${updates.join(", ")} WHERE id = $${paramIdx}`,
      values
    );
  } else {
    const updates: string[] = [];
    const values: (number | string)[] = [];

    if (args.max_position_size != null) {
      updates.push("max_position_size_pct = ?");
      values.push(args.max_position_size);
    }
    if (args.drawdown_limit != null) {
      updates.push("drawdown_limit_pct = ?");
      values.push(args.drawdown_limit);
    }
    if (args.kelly_multiplier != null) {
      updates.push("kelly_fraction_multiplier = ?");
      values.push(args.kelly_multiplier);
    }

    if (updates.length === 0) return { error: "No fields to update" };

    values.push(cb.id);
    const db = getDb();
    db.prepare(`UPDATE global_circuit_breakers SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  }

  // Return updated config
  return executeGetRiskConfig();
}

async function executeTriggerScanner(): Promise<unknown> {
  const BACKEND_HOST = `http://localhost:${process.env.PORT || "3001"}`;
  try {
    const res = await fetch(`${BACKEND_HOST}/api/orchestrator/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { triggered: false, error: body.error ?? `Scanner returned ${res.status}` };
    }

    const data = await res.json() as Record<string, unknown>;
    return {
      triggered: true,
      markets_scanned: data.marketsScanned ?? 0,
      candidates_found: data.candidatesFound ?? 0,
    };
  } catch (err) {
    return { triggered: false, error: err instanceof Error ? err.message : "Scanner trigger failed" };
  }
}

async function executeGetPipelineOutput(args: { run_id: string }): Promise<unknown> {
  let run: any;
  let aura: any, flux: any, clause: any, oracle: any, edge: any, research: any;

  if (isPgEnabled()) {
    run = await pgQueryOne(
      `SELECT id, market_slug, market_question, created_at, completed_at, decision, confidence, signal_state
       FROM pipeline_runs WHERE id = $1`,
      [args.run_id]
    );

    if (!run) return { error: `Pipeline run not found: ${args.run_id}` };

    // Fetch each agent's output for this run in parallel
    [aura, flux, clause, oracle, edge, research] = await Promise.all([
      pgQueryOne("SELECT * FROM aura_results WHERE pipeline_run_id = $1", [args.run_id]),
      pgQueryOne("SELECT * FROM flux_results WHERE pipeline_run_id = $1", [args.run_id]),
      pgQueryOne("SELECT * FROM clause_results WHERE pipeline_run_id = $1", [args.run_id]),
      pgQueryOne("SELECT * FROM oracle_results WHERE pipeline_run_id = $1", [args.run_id]),
      pgQueryOne("SELECT * FROM edge_results WHERE pipeline_run_id = $1", [args.run_id]),
      pgQueryOne("SELECT * FROM research_notes WHERE pipeline_run_id = $1", [args.run_id]),
    ]);
  } else {
    const db = getDb();

    run = db.prepare(
      `SELECT id, market_slug, market_question, created_at, completed_at, decision, confidence, signal_state
       FROM pipeline_runs WHERE id = ?`
    ).get(args.run_id) as any;

    if (!run) return { error: `Pipeline run not found: ${args.run_id}` };

    // Fetch each agent's output for this run
    aura = db.prepare("SELECT * FROM aura_results WHERE pipeline_run_id = ?").get(args.run_id);
    flux = db.prepare("SELECT * FROM flux_results WHERE pipeline_run_id = ?").get(args.run_id);
    clause = db.prepare("SELECT * FROM clause_results WHERE pipeline_run_id = ?").get(args.run_id);
    oracle = db.prepare("SELECT * FROM oracle_results WHERE pipeline_run_id = ?").get(args.run_id);
    edge = db.prepare("SELECT * FROM edge_results WHERE pipeline_run_id = ?").get(args.run_id);
    research = db.prepare("SELECT * FROM research_notes WHERE pipeline_run_id = ?").get(args.run_id);
  }

  return {
    run_id: run.id,
    market_slug: run.market_slug,
    market_question: run.market_question,
    decision: run.decision,
    confidence: run.confidence,
    signal_state: run.signal_state,
    created_at: run.created_at,
    completed_at: run.completed_at,
    agents: {
      aura: aura ?? null,
      flux: flux ?? null,
      clause: clause ?? null,
      oracle: oracle ?? null,
      edge: edge ?? null,
      research: research ?? null,
    },
  };
}

async function executeUpdateWebhookConfig(
  args: { endpoint_url?: string; webhook_events?: string },
  context: ToolExecutionContext | null,
): Promise<unknown> {
  if (!context?.linkedAgentId) return { error: "Agent context not available" };

  // Validate inputs first (shared between PG and SQLite paths)
  const fieldUpdates: { column: string; value: string | null }[] = [];

  if (args.endpoint_url !== undefined) {
    if (args.endpoint_url === "" || args.endpoint_url === null) {
      // Allow clearing the URL
      fieldUpdates.push({ column: "endpoint_url", value: null });
    } else {
      // SSRF validation (same rules as agent creation)
      if (args.endpoint_url.length > 500) return { error: "endpoint_url must be 500 characters or less" };
      try {
        const parsed = new URL(args.endpoint_url);
        if (parsed.protocol !== "https:") return { error: "endpoint_url must use HTTPS" };
        const host = parsed.hostname;
        if (
          host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
          host.startsWith("10.") || host.startsWith("192.168.") ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
          host === "[::1]" || host.endsWith(".local") || host.endsWith(".internal")
        ) {
          return { error: "endpoint_url must not point to a private/internal address" };
        }
      } catch {
        return { error: "endpoint_url is not a valid URL" };
      }
      fieldUpdates.push({ column: "endpoint_url", value: args.endpoint_url });
    }
  }

  if (args.webhook_events !== undefined) {
    try {
      const events = JSON.parse(args.webhook_events);
      if (!Array.isArray(events) || !events.every((e: unknown) => typeof e === "string")) {
        return { error: "webhook_events must be a JSON array of strings" };
      }
      fieldUpdates.push({ column: "webhook_events", value: JSON.stringify(events) });
    } catch {
      return { error: "webhook_events must be valid JSON" };
    }
  }

  if (fieldUpdates.length === 0) return { error: "No fields to update" };

  let agent: { endpoint_url: string | null; webhook_events: string | null };

  if (isPgEnabled()) {
    const setClauses: string[] = [];
    const values: (string | null)[] = [];
    let paramIdx = 1;

    for (const f of fieldUpdates) {
      setClauses.push(`${f.column} = $${paramIdx++}`);
      values.push(f.value);
    }
    setClauses.push(`updated_at = $${paramIdx++}`);
    values.push(String(Date.now()));
    values.push(context.linkedAgentId);

    await pgExec(
      `UPDATE agents SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values
    );

    // Return updated config
    const row = await pgQueryOne<{ endpoint_url: string | null; webhook_events: string | null }>(
      "SELECT endpoint_url, webhook_events FROM agents WHERE id = $1",
      [context.linkedAgentId]
    );
    agent = row ?? { endpoint_url: null, webhook_events: null };
  } else {
    const db = getDb();
    const updates: string[] = [];
    const values: (string | null)[] = [];

    for (const f of fieldUpdates) {
      updates.push(`${f.column} = ?`);
      values.push(f.value);
    }
    updates.push("updated_at = ?");
    values.push(String(Date.now()));
    values.push(context.linkedAgentId);

    db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    // Return updated config
    agent = db.prepare(
      "SELECT endpoint_url, webhook_events FROM agents WHERE id = ?"
    ).get(context.linkedAgentId) as { endpoint_url: string | null; webhook_events: string | null };
  }

  let parsedEvents: string[] = ["*"];
  try { parsedEvents = JSON.parse(agent.webhook_events ?? '["*"]'); } catch { /* ignore */ }

  return {
    endpoint_url: agent.endpoint_url,
    webhook_events: parsedEvents,
    updated: true,
  };
}

async function executeGetHealthScore(context: ToolExecutionContext | null): Promise<unknown> {
  if (!context?.linkedAgentId) return { error: "Agent context not available" };

  const ops = await loadOpsSnapshot(context);
  if (!ops.health) return { error: "Failed to compute health score" };
  return ops.health;
}

async function executeGetPolymarketStatus(context: ToolExecutionContext | null): Promise<unknown> {
  if (!context?.linkedAgentId || !context?.userId) {
    return { polymarket_ready: false, polymarket_status: "unknown", error: "Agent context not available — authenticate to check status" };
  }
  const { checkPolymarketBalance } = await import("../services/polymarket-prep.service");
  return checkPolymarketBalance(context.linkedAgentId, context.userId);
}

function executeRequestPolymarketApprovals(context: ToolExecutionContext | null): unknown {
  if (!context?.linkedAgentId || !context?.userId) {
    return { error: "Agent context not available — authenticate first" };
  }
  // Returns a confirmation payload — agentChat.ts emits a polymarket_confirm SSE event.
  // Actual on-chain transactions are only submitted after the user confirms via
  // POST /api/v1/tools/run_polymarket_approvals (config scope required).
  return {
    action: "polymarket_confirm_required",
    message: "Ready to submit 6 on-chain approval transactions to Polymarket's CTF Exchange and Neg-Risk contracts. Confirm by calling POST /api/v1/tools/run_polymarket_approvals.",
    agentId: context.linkedAgentId,
  };
}

// ── Tool Executor Dispatch ───────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext | null = null,
): Promise<ToolResult> {
  switch (name) {
    case "get_portfolio":
      return { name, data: await executeGetPortfolio(context) };
    case "get_risk_status":
      return { name, data: await executeGetRiskStatus(context) };
    case "get_trade_history":
      return { name, data: await executeGetTradeHistory(args as { limit?: number }, context) };
    case "get_arena_leaderboard":
      return { name, data: await executeGetArenaLeaderboard(args as { window?: ArenaWindow }, context) };
    case "search_markets":
      return { name, data: await executeSearchMarkets(args as { query?: string; category?: string }) };
    case "run_analysis":
      return { name, data: await executeRunAnalysis(args as { slug: string }) };
    case "place_trade":
      return { name, data: executePlaceTrade(args as { slug: string; direction: string; size: number }) };
    case "get_scanner_signals":
      return { name, data: await executeGetScannerSignals(args as { alerts_only?: string }) };
    case "get_pipeline_history":
      return { name, data: await executeGetPipelineHistory(args as { limit?: number }) };
    case "get_agent_status":
      return { name, data: await executeGetAgentStatus(context) };
    case "heartbeat":
      return { name, data: await executeHeartbeat(context) };
    case "close_position":
      return { name, data: await executeClosePosition(args as { slug: string }, context) };
    case "get_market_price":
      return { name, data: await executeGetMarketPrice(args as { slug: string }) };
    case "get_risk_config":
      return { name, data: await executeGetRiskConfig() };
    case "update_risk_config":
      return { name, data: await executeUpdateRiskConfig(args as { max_position_size?: number; drawdown_limit?: number; kelly_multiplier?: number }) };
    case "trigger_scanner":
      return { name, data: await executeTriggerScanner() };
    case "get_pipeline_output":
      return { name, data: await executeGetPipelineOutput(args as { run_id: string }) };
    case "update_webhook_config":
      return { name, data: await executeUpdateWebhookConfig(args as { endpoint_url?: string; webhook_events?: string }, context) };
    case "get_health_score":
      return { name, data: await executeGetHealthScore(context) };
    case "get_polymarket_status":
      return { name, data: await executeGetPolymarketStatus(context) };
    case "run_polymarket_approvals":
      return { name, data: executeRequestPolymarketApprovals(context) };
    default:
      return { name, data: { error: `Unknown tool: ${name}` } };
  }
}
