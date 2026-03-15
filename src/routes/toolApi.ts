import { Router, Request, Response } from "express";
import { requireApiKey, requireScope } from "../middleware/apiKeyAuth";
import { executeTool } from "../agents/tools";
import { loadToolExecutionContextByAgentId } from "../agents/snapshots";
import { rateLimit } from "../infra/rateLimit";
import { getDb } from "../db/schema";
import { isPgEnabled, pgExec } from "../db/postgres";
import { isArenaWindow, parseArenaWindow } from "../performance/arena";

const router = Router();

// ── Rate limiters for BYO tool endpoints ────────────────────────────────────

const readRateLimit = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: "byo-read" });
const tradeToolRateLimit = rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "byo-trade" });
const analysisRateLimit = rateLimit({ windowMs: 60_000, max: 5, keyPrefix: "byo-analysis" });
const heartbeatRateLimit = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: "byo-heartbeat" });
const configRateLimit = rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "byo-config" });

// ── Slug validation ─────────────────────────────────────────────────────────

const SLUG_REGEX = /^[a-z0-9][a-z0-9\-_]{0,198}[a-z0-9]$/;

function isValidSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= 200 && SLUG_REGEX.test(slug);
}

// ── Request logging helper ──────────────────────────────────────────────────

function logRequest(
  agentId: string,
  userId: string,
  toolName: string,
  method: string,
  statusCode: number,
  latencyMs: number,
  error?: string,
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO byo_request_log (agent_id, user_id, tool_name, method, status_code, latency_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(agentId, userId, toolName, method, statusCode, latencyMs, error ?? null, Date.now());
    if (isPgEnabled()) {
      void pgExec(
        `INSERT INTO byo_request_log (agent_id, user_id, tool_name, method, status_code, latency_ms, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [agentId, userId, toolName, method, statusCode, latencyMs, error ?? null, Date.now()]
      ).catch(() => {});
    }
  } catch {
    // Fire-and-forget — never block the response
  }
}

// ── Tool execution timeout ──────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("TOOL_TIMEOUT")), ms)
    ),
  ]);
}

// ── Helper: wrap tool execution with BYO agent context + logging ────────────

async function callTool(req: Request, res: Response, toolName: string, args: Record<string, unknown>) {
  const start = Date.now();
  const agent = req.apiKeyAgent!;
  try {
    const context = await loadToolExecutionContextByAgentId(agent.agentId, agent.userId);
    const result = await withTimeout(executeTool(toolName, args, context), TOOL_TIMEOUT_MS);
    const latency = Date.now() - start;
    logRequest(agent.agentId, agent.userId, toolName, req.method, 200, latency);
    res.json({ success: true, data: result.data });
  } catch (err) {
    const latency = Date.now() - start;
    const isTimeout = err instanceof Error && err.message === "TOOL_TIMEOUT";
    const errMsg = isTimeout ? "Tool execution timed out" : (err instanceof Error ? err.message : "Tool execution failed");
    const statusCode = isTimeout ? 408 : 500;
    const errorCode = isTimeout ? "TIMEOUT" : "INTERNAL_ERROR";
    logRequest(agent.agentId, agent.userId, toolName, req.method, statusCode, latency, errMsg);
    console.error(`[toolApi] ${toolName} ${isTimeout ? "timeout" : "error"}:`, err);
    res.status(statusCode).json({ success: false, error: errMsg, code: errorCode });
  }
}

// ── Read-only tools (GET) ───────────────────────────────────────────────────

router.get("/get_portfolio", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "get_portfolio", {});
});

router.get("/get_risk_status", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "get_risk_status", {});
});

router.get("/get_trade_history", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  const raw = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
  const limit = Math.min(Math.max(1, isNaN(raw) ? 10 : raw), 50);
  callTool(req, res, "get_trade_history", { limit });
});

router.get("/get_arena_leaderboard", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  const rawWindow = req.query.window;
  if (rawWindow != null && (typeof rawWindow !== "string" || !isArenaWindow(rawWindow))) {
    res.status(400).json({ success: false, error: "window must be one of: day, week, all", code: "INVALID_PARAMS" });
    return;
  }
  callTool(req, res, "get_arena_leaderboard", { window: parseArenaWindow(rawWindow) });
});

const VALID_CATEGORIES = ["crypto", "politics", "sports", "pop-culture", "science", "world", "business"];

router.get("/search_markets", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  const query = typeof req.query.query === "string" ? req.query.query.slice(0, 200) : undefined;
  const rawCat = typeof req.query.category === "string" ? req.query.category.toLowerCase() : undefined;
  const category = rawCat && VALID_CATEGORIES.includes(rawCat) ? rawCat : undefined;
  callTool(req, res, "search_markets", { query, category });
});

router.get("/get_scanner_signals", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "get_scanner_signals", {
    alerts_only: req.query.alerts_only === "true" ? "true" : undefined,
  });
});

router.get("/get_pipeline_history", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  const raw = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
  const limit = Math.min(Math.max(1, isNaN(raw) ? 5 : raw), 20);
  callTool(req, res, "get_pipeline_history", { limit });
});

router.get("/get_agent_status", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "get_agent_status", {});
});

// ── Write tools (POST) ─────────────────────────────────────────────────────

router.post("/run_analysis", requireApiKey, requireScope("analysis"), analysisRateLimit, (req: Request, res: Response) => {
  const { slug } = req.body as { slug?: string };
  if (!slug || typeof slug !== "string") {
    res.status(400).json({ success: false, error: "slug is required", code: "INVALID_PARAMS" });
    return;
  }
  const trimmed = slug.trim().toLowerCase();
  if (!isValidSlug(trimmed)) {
    res.status(400).json({ success: false, error: "slug must be 2-200 chars, lowercase alphanumeric with hyphens/underscores", code: "INVALID_PARAMS" });
    return;
  }
  callTool(req, res, "run_analysis", { slug: trimmed });
});

router.post("/place_trade", requireApiKey, requireScope("trade"), tradeToolRateLimit, (req: Request, res: Response) => {
  const { slug, direction, size } = req.body as { slug?: string; direction?: string; size?: number };
  if (!slug || !direction || size == null) {
    res.status(400).json({ success: false, error: "slug, direction, and size are required", code: "INVALID_PARAMS" });
    return;
  }
  if (typeof slug !== "string") {
    res.status(400).json({ success: false, error: "slug must be a string", code: "INVALID_PARAMS" });
    return;
  }
  const trimmedSlug = slug.trim().toLowerCase();
  if (!isValidSlug(trimmedSlug)) {
    res.status(400).json({ success: false, error: "slug must be 2-200 chars, lowercase alphanumeric with hyphens/underscores", code: "INVALID_PARAMS" });
    return;
  }
  if (!["YES", "NO"].includes(direction)) {
    res.status(400).json({ success: false, error: "direction must be 'YES' or 'NO'", code: "INVALID_PARAMS" });
    return;
  }
  if (typeof size !== "number" || size <= 0 || size > 10000 || !isFinite(size)) {
    res.status(400).json({ success: false, error: "size must be a positive number (max 10,000 USDC)", code: "INVALID_PARAMS" });
    return;
  }
  callTool(req, res, "place_trade", { slug: trimmedSlug, direction, size });
});

router.post("/heartbeat", requireApiKey, heartbeatRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "heartbeat", {});
});

// ── New autonomy tools (Phase 7) ─────────────────────────────────────────

router.post("/close_position", requireApiKey, requireScope("trade"), tradeToolRateLimit, (req: Request, res: Response) => {
  const { slug } = req.body as { slug?: string };
  if (!slug || typeof slug !== "string") {
    res.status(400).json({ success: false, error: "slug is required", code: "INVALID_PARAMS" });
    return;
  }
  const trimmed = slug.trim().toLowerCase();
  if (!isValidSlug(trimmed)) {
    res.status(400).json({ success: false, error: "slug must be 2-200 chars, lowercase alphanumeric with hyphens/underscores", code: "INVALID_PARAMS" });
    return;
  }
  callTool(req, res, "close_position", { slug: trimmed });
});

router.get("/get_market_price", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  const slug = typeof req.query.slug === "string" ? req.query.slug.trim().toLowerCase() : "";
  if (!slug || !isValidSlug(slug)) {
    res.status(400).json({ success: false, error: "slug query param is required (2-200 chars, lowercase alphanumeric)", code: "INVALID_PARAMS" });
    return;
  }
  callTool(req, res, "get_market_price", { slug });
});

router.get("/get_risk_config", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "get_risk_config", {});
});

router.post("/update_risk_config", requireApiKey, requireScope("config"), configRateLimit, (req: Request, res: Response) => {
  const { max_position_size, drawdown_limit, kelly_multiplier } = req.body as {
    max_position_size?: number; drawdown_limit?: number; kelly_multiplier?: number;
  };
  // At least one field must be provided
  if (max_position_size == null && drawdown_limit == null && kelly_multiplier == null) {
    res.status(400).json({ success: false, error: "At least one of max_position_size, drawdown_limit, or kelly_multiplier is required", code: "INVALID_PARAMS" });
    return;
  }
  callTool(req, res, "update_risk_config", { max_position_size, drawdown_limit, kelly_multiplier });
});

router.post("/trigger_scanner", requireApiKey, requireScope("analysis"), analysisRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "trigger_scanner", {});
});

router.get("/get_pipeline_output", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  const runId = typeof req.query.run_id === "string" ? req.query.run_id.trim() : "";
  if (!runId) {
    res.status(400).json({ success: false, error: "run_id query param is required", code: "INVALID_PARAMS" });
    return;
  }
  callTool(req, res, "get_pipeline_output", { run_id: runId });
});

router.post("/update_webhook_config", requireApiKey, requireScope("config"), configRateLimit, (req: Request, res: Response) => {
  const { endpoint_url, webhook_events } = req.body as { endpoint_url?: string; webhook_events?: string[] };
  // Convert webhook_events array to JSON string for the executor
  const eventsStr = webhook_events ? JSON.stringify(webhook_events) : undefined;
  callTool(req, res, "update_webhook_config", { endpoint_url, webhook_events: eventsStr });
});

router.get("/get_health_score", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "get_health_score", {});
});

// ── API Usage Stats (with in-memory cache) ──────────────────────────────────

interface UsageCacheEntry {
  data: unknown;
  expiry: number;
}

const usageCache = new Map<string, UsageCacheEntry>();
const USAGE_CACHE_TTL_MS = 60_000; // 60 seconds

router.get("/usage", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  try {
    const agentId = req.apiKeyAgent!.agentId;
    const now = Date.now();

    // Check cache
    const cached = usageCache.get(agentId);
    if (cached && now < cached.expiry) {
      res.json({ success: true, data: cached.data });
      return;
    }

    const db = getDb();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    // Total requests (24h)
    const total24h = db.prepare(
      "SELECT COUNT(*) as count FROM byo_request_log WHERE agent_id = ? AND created_at >= ?"
    ).get(agentId, oneDayAgo) as { count: number };

    // Requests by tool (24h)
    const byTool = db.prepare(
      `SELECT tool_name, COUNT(*) as count, AVG(latency_ms) as avg_latency,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
       FROM byo_request_log WHERE agent_id = ? AND created_at >= ?
       GROUP BY tool_name ORDER BY count DESC`
    ).all(agentId, oneDayAgo) as { tool_name: string; count: number; avg_latency: number; errors: number }[];

    // Error rate (24h)
    const errors24h = db.prepare(
      "SELECT COUNT(*) as count FROM byo_request_log WHERE agent_id = ? AND created_at >= ? AND status_code >= 400"
    ).get(agentId, oneDayAgo) as { count: number };

    // Requests per hour (last hour)
    const lastHour = db.prepare(
      "SELECT COUNT(*) as count FROM byo_request_log WHERE agent_id = ? AND created_at >= ?"
    ).get(agentId, oneHourAgo) as { count: number };

    // 7-day daily breakdown
    const dailyBreakdown = db.prepare(
      `SELECT DATE(created_at / 1000, 'unixepoch') as day, COUNT(*) as count,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
       FROM byo_request_log WHERE agent_id = ? AND created_at >= ?
       GROUP BY day ORDER BY day ASC`
    ).all(agentId, sevenDaysAgo) as { day: string; count: number; errors: number }[];

    // Recent errors (last 10)
    const recentErrors = db.prepare(
      `SELECT tool_name, status_code, error, created_at
       FROM byo_request_log WHERE agent_id = ? AND status_code >= 400
       ORDER BY created_at DESC LIMIT 10`
    ).all(agentId) as { tool_name: string; status_code: number; error: string | null; created_at: number }[];

    const data = {
      total_requests_24h: total24h.count,
      requests_last_hour: lastHour.count,
      error_count_24h: errors24h.count,
      error_rate_24h: total24h.count > 0 ? (errors24h.count / total24h.count * 100).toFixed(1) + "%" : "0%",
      by_tool: byTool.map(t => ({
        tool: t.tool_name,
        requests: t.count,
        avg_latency_ms: Math.round(t.avg_latency),
        errors: t.errors,
      })),
      daily_breakdown: dailyBreakdown,
      recent_errors: recentErrors,
    };

    // Cache for 60s
    usageCache.set(agentId, { data, expiry: now + USAGE_CACHE_TTL_MS });

    res.json({ success: true, data });
  } catch (err) {
    console.error("[toolApi] usage error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch usage stats", code: "INTERNAL_ERROR" });
  }
});

// ── Polymarket wallet status & approvals ─────────────────────────────────────

router.get("/get_polymarket_status", requireApiKey, requireScope("read"), readRateLimit, (req: Request, res: Response) => {
  callTool(req, res, "get_polymarket_status", {});
});

// POST /run_polymarket_approvals — directly executes the 6 on-chain approval txns.
// Unlike the chat tool (which returns a confirmation request), calling this REST endpoint
// is considered explicit consent — the agent has deliberately invoked it with config scope.
router.post("/run_polymarket_approvals", requireApiKey, requireScope("config"), configRateLimit, async (req: Request, res: Response) => {
  const { agentId, userId } = req.apiKeyAgent!;
  const start = Date.now();
  try {
    const { runPolymarketApprovals } = await import("../services/polymarket-prep.service");
    const result = await runPolymarketApprovals(agentId, userId);
    logRequest(agentId, userId, "run_polymarket_approvals", "POST", 200, Date.now() - start);
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Approval submission failed";
    logRequest(agentId, userId, "run_polymarket_approvals", "POST", 500, Date.now() - start, msg);
    res.status(500).json({ success: false, error: msg, code: "INTERNAL_ERROR" });
  }
});

export default router;
