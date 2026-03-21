import { Router, Request } from "express";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne, dualQuery } from "../db/postgres";
import { AttributionEngine } from "../monitoring/attribution";
import { DriftDetection } from "../monitoring/drift";
import { ModelCalibration } from "../monitoring/calibration";
import { getUserIdAsync } from "../middleware/auth";
import { loadPortfolioSnapshot, loadToolExecutionContextByAgentId } from "../agents/snapshots";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";
import {
  buildScannerMaps,
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerResults,
} from "../utils/executionDirection";
import type { ExecutionRecord } from "../types/execution";
import { parseArenaWindow } from "../performance/arena";
import { loadArenaLeaderboard, loadCachedArenaAgents } from "../performance/arenaService";
import { loadAgentHistory, loadComparison } from "../performance/arenaSnapshots";
import { apiRateLimit } from "../infra/rateLimit";

const router = Router();
const attributionEngine = new AttributionEngine();
const driftDetection = new DriftDetection();
const modelCalibration = new ModelCalibration();

type ReportPeriod = "day" | "week" | "month" | "all";
type ReportOutcome = "WIN" | "LOSS" | "OPEN" | "PENDING";
type ReportSource = "autopilot" | "manual";

type ExecutionRow = ExecutionRecord;

interface ReportTrade {
  id: number;
  slug: string;
  market: string;
  direction: string;
  source: ReportSource;
  size: number;
  price: number;
  outcome: ReportOutcome;
  timestamp: number;
  pnl: number;
  orderId: string | null;
  mode: string;
  pipelineRunId: string | null;
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parsePeriod(value: unknown): ReportPeriod {
  return value === "day" || value === "week" || value === "month" ? value : "all";
}

function parseOutcome(value: unknown): ReportOutcome | null {
  return value === "WIN" || value === "LOSS" || value === "OPEN" || value === "PENDING"
    ? value
    : null;
}

function parseSource(value: unknown): ReportSource | null {
  return value === "manual" || value === "autopilot" ? value : null;
}

function withinPeriod(timestamp: number, period: ReportPeriod): boolean {
  if (period === "all") return true;
  const now = Date.now();
  const windowMs =
    period === "day"
      ? 24 * 60 * 60 * 1000
      : period === "week"
      ? 7 * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
  return timestamp >= now - windowMs;
}

function buildBuckets(trades: ReportTrade[], period: ReportPeriod) {
  if (period === "all") return [];

  const bucketMap = new Map<number, { timestamp: number; pnl: number; trades: number; label: string }>();

  for (const trade of trades) {
    const date = new Date(trade.timestamp);
    let bucketTs: number;
    let label: string;

    if (period === "day") {
      date.setMinutes(0, 0, 0);
      bucketTs = date.getTime();
      label = date.toLocaleTimeString("en-US", { hour: "numeric" });
    } else {
      date.setHours(0, 0, 0, 0);
      bucketTs = date.getTime();
      label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    const existing = bucketMap.get(bucketTs) ?? { timestamp: bucketTs, pnl: 0, trades: 0, label };
    existing.pnl += trade.pnl ?? 0;
    existing.trades += 1;
    bucketMap.set(bucketTs, existing);
  }

  return Array.from(bucketMap.values()).sort((left, right) => left.timestamp - right.timestamp);
}

function toCsv(trades: ReportTrade[]): string {
  const header = ["id", "timestamp", "market", "slug", "direction", "source", "size", "price", "outcome", "pnl", "mode", "pipelineRunId"];
  const rows = trades.map((trade) => [
    trade.id,
    new Date(trade.timestamp).toISOString(),
    trade.market,
    trade.slug,
    trade.direction,
    trade.source,
    trade.size.toFixed(2),
    trade.price.toFixed(4),
    trade.outcome,
    trade.pnl.toFixed(2),
    trade.mode,
    trade.pipelineRunId ?? "",
  ]);
  return [header, ...rows]
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, "\"\"")}"`).join(","))
    .join("\n");
}

async function loadReportTrades(req: Request): Promise<ReportTrade[]> {
  const userId = await getUserIdAsync(req);
  if (!userId) return [];

  const linkedAgent = await loadLinkedAgentForUser(userId);
  if (!linkedAgent) return [];

  const [executions, scannerRows] = await Promise.all([
    dualQuery<ExecutionRow>(
      `SELECT id, slug, direction, source, amount, fill_price, status, executed_at, pnl, order_id, pipeline_run_id
         FROM executions
        WHERE agent_id = $1
        ORDER BY executed_at DESC
        LIMIT 500`,
      [linkedAgent.agentId]
    ),
    getLatestScannerResults(),
  ]);

  const { priceMap: livePrice, directionMap: scannerDirections } = buildScannerMaps(scannerRows);

  return executions.map((execution) => {
    const scannerDirection = scannerDirections.get(execution.slug);
    const entryYes = getEntryYesPrice(execution, scannerDirection);
    const currentYes = livePrice.get(execution.slug) ?? entryYes;
    const metrics = calculateOpenExecutionMetrics(execution, currentYes, scannerDirection);

    let outcome: ReportOutcome = "OPEN";
    if (execution.status === "failed") {
      outcome = "PENDING";
    } else if (execution.pnl !== null) {
      outcome = execution.pnl > 0 ? "WIN" : "LOSS";
    }

    return {
      id: execution.id,
      slug: execution.slug,
      market: humanizeSlug(execution.slug),
      direction: metrics.direction,
      source: execution.source === "autopilot" ? "autopilot" : "manual",
      size: execution.amount,
      price: entryYes,
      outcome,
      timestamp: execution.executed_at,
      pnl: execution.pnl ?? metrics.pnl,
      orderId: execution.order_id,
      mode: execution.status,
      pipelineRunId: execution.pipeline_run_id,
    };
  });
}

router.get("/summary", async (req: Request, res) => {
  try {
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    const context = linkedAgent?.agentId
      ? await loadToolExecutionContextByAgentId(linkedAgent.agentId, userId)
      : null;
    const snapshot = await loadPortfolioSnapshot(context);
    const attribution = await attributionEngine.getAttributionBySignal();
    const alphaDecay = await attributionEngine.getAlphaDecayStatus();

    res.json({
      ...snapshot,
      attribution,
      alphaDecay,
    });
  } catch (err) {
    console.error("[performance:summary] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/attribution", async (_req, res) => {
  const data = await attributionEngine.getAttributionBySignal();
  res.json(data);
});

// Trade history (moved from /api/portfolio/attribution)
router.get("/trades", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const outcome = parseOutcome(req.query.outcome);
    const source = parseSource(req.query.source);
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const allTrades = await loadReportTrades(req);
    const filteredTrades = allTrades.filter((trade) => {
      if (!withinPeriod(trade.timestamp, period)) return false;
      if (outcome && trade.outcome !== outcome) return false;
      if (source && trade.source !== source) return false;
      if (search && !trade.market.toLowerCase().includes(search) && !trade.slug.toLowerCase().includes(search)) return false;
      return true;
    });

    const closedTrades = filteredTrades.filter((trade) => trade.outcome === "WIN" || trade.outcome === "LOSS");
    const wins = closedTrades.filter((trade) => trade.outcome === "WIN").length;
    const losses = closedTrades.filter((trade) => trade.outcome === "LOSS").length;
    const totalPnl = filteredTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
    const bestTrade = [...filteredTrades]
      .filter((trade) => Number.isFinite(trade.pnl))
      .sort((left, right) => right.pnl - left.pnl)[0] ?? null;
    const worstTrade = [...filteredTrades]
      .filter((trade) => Number.isFinite(trade.pnl))
      .sort((left, right) => left.pnl - right.pnl)[0] ?? null;

    res.json({
      trades: filteredTrades,
      count: filteredTrades.length,
      period,
      filters: { outcome, source, search },
      summary: {
        totalTrades: filteredTrades.length,
        totalPnl,
        wins,
        losses,
        open: filteredTrades.filter((trade) => trade.outcome === "OPEN").length,
        pending: filteredTrades.filter((trade) => trade.outcome === "PENDING").length,
        winRate: wins / Math.max(closedTrades.length, 1),
      },
      buckets: buildBuckets(filteredTrades, period),
      bestTrade,
      worstTrade,
      agentAttribution: modelCalibration.getAgentWeights(),
    });
  } catch (err) {
    console.error("[performance:trades] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/arena", apiRateLimit, async (req, res) => {
  try {
    const window = parseArenaWindow(req.query.window);
    const userId = req.apiKeyAgent ? null : await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    const viewerAgentId = req.apiKeyAgent?.agentId ?? linkedAgent?.agentId ?? null;
    const limit = req.query.limit != null ? Math.max(1, Math.min(200, Number(req.query.limit) || 50)) : undefined;
    const offset = req.query.offset != null ? Math.max(0, Number(req.query.offset) || 0) : undefined;
    res.json(await loadArenaLeaderboard(window, viewerAgentId, limit, offset));
  } catch (err) {
    console.error("[performance:arena] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/arena/compare", apiRateLimit, async (req, res) => {
  try {
    const window = parseArenaWindow(req.query.window);
    const a1 = typeof req.query.a1 === "string" ? req.query.a1 : "";
    const a2 = typeof req.query.a2 === "string" ? req.query.a2 : "";
    if (!a1 || !a2) {
      res.status(400).json({ error: "Both a1 and a2 agent IDs are required" });
      return;
    }
    const result = await loadComparison(a1, a2, window);
    if (!result) {
      res.status(404).json({ error: "Neither agent found in leaderboard" });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error("[performance:arena:compare] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Public agent profile — no auth required
router.get("/arena/agent/:agentCode", apiRateLimit, async (req, res) => {
  try {
    const agentCode = typeof req.params.agentCode === "string" ? req.params.agentCode : "";
    if (!agentCode) {
      res.status(400).json({ error: "Missing agentCode" });
      return;
    }

    // Find agent by agent_code
    const agents = await loadCachedArenaAgents();
    const agent = agents.find((a) => a.agent_code === agentCode);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Load leaderboard to find this agent's entry
    const result = await loadArenaLeaderboard("all");
    const entry = result.leaders.find((e) => e.agentId === agent.id);

    // Load sparkline history
    const sparkline = await loadAgentHistory(agent.id, "all", 168);

    res.json({
      agentCode: agent.agent_code,
      name: agent.name,
      avatarEmoji: agent.avatar_emoji,
      agentType: agent.agent_type,
      rank: entry?.rank ?? null,
      selectedPnl: entry?.selectedPnl ?? 0,
      allTimePnl: entry?.allTimePnl ?? 0,
      winRate: entry?.winRate ?? 0,
      totalTrades: entry?.totalTrades ?? 0,
      openPositions: entry?.openPositions ?? 0,
      currentStreak: entry?.currentStreak ?? 0,
      heat: entry?.heat ?? 0,
      dna: entry?.dna ?? { volume: 0, diversity: 0, speed: 0, streak: 0, riskAppetite: 0, timing: 0 },
      badges: entry?.badges ?? [],
      marketBreakdown: entry?.marketBreakdown ?? [],
      sparkline,
    });
  } catch (err) {
    console.error("[performance:arena:agent] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/arena/:agentId/history", apiRateLimit, async (req, res) => {
  try {
    const window = parseArenaWindow(req.query.window);
    const limit = Math.max(1, Math.min(720, Number(req.query.limit) || 168));
    const agentId = typeof req.params.agentId === "string" ? req.params.agentId : "";
    res.json(await loadAgentHistory(agentId, window, limit));
  } catch (err) {
    console.error("[performance:arena:history] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/trades/export.csv", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const outcome = parseOutcome(req.query.outcome);
    const source = parseSource(req.query.source);
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const trades = (await loadReportTrades(req)).filter((trade) => {
      if (!withinPeriod(trade.timestamp, period)) return false;
      if (outcome && trade.outcome !== outcome) return false;
      if (source && trade.source !== source) return false;
      if (search && !trade.market.toLowerCase().includes(search) && !trade.slug.toLowerCase().includes(search)) return false;
      return true;
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="quantik-trades.csv"');
    res.send(toCsv(trades));
  } catch (err) {
    console.error("[performance:trades:csv] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/brier", async (_req, res) => {
  if (isPgEnabled()) {
    const rows = await pgQuery("SELECT market_slug as slug, brier_score as score, resolved_at as timestamp FROM resolutions ORDER BY resolved_at DESC LIMIT 50");
    res.json(rows);
    return;
  }
  const db = getDb();
  const rows = db.prepare("SELECT market_slug as slug, brier_score as score, resolved_at as timestamp FROM resolutions ORDER BY resolved_at DESC LIMIT 50").all();
  res.json(rows);
});

router.get("/drift", async (_req, res) => {
  try {
    const microstructure = await driftDetection.checkMicrostructureDrift();
    const concept = await driftDetection.checkConceptDrift();
    res.json({
      microstructure: microstructure.detected ? "detected" : "clear",
      concept: concept.detected ? "detected" : "clear",
      lastChecked: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/calibration", (_req, res) => {
  try {
    const weights = modelCalibration.getAgentWeights();
    res.json(
      weights.map((w) => ({
        agent: w.agent,
        weight: w.weight,
        confidence: w.brierScore !== null ? Math.max(0, 1 - w.brierScore) : null,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
