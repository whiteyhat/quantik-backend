import { Router, Request } from "express";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne } from "../db/postgres";
import { AttributionEngine } from "../monitoring/attribution";
import { DriftDetection } from "../monitoring/drift";
import { ModelCalibration } from "../monitoring/calibration";
import { getUserIdAsync } from "../middleware/auth";
import { loadPortfolioSnapshot, loadToolExecutionContextByAgentId } from "../agents/snapshots";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerDirectionMap,
} from "../utils/executionDirection";
import {
  buildArenaLeaderboard,
  type ArenaAgentRecord,
  type ArenaExecutionRecord,
  type ArenaWindow,
} from "../performance/arena";

const router = Router();
const attributionEngine = new AttributionEngine();
const driftDetection = new DriftDetection();
const modelCalibration = new ModelCalibration();

type ReportPeriod = "day" | "week" | "month" | "all";
type ReportOutcome = "WIN" | "LOSS" | "OPEN" | "PENDING";
type ReportSource = "autopilot" | "manual";

interface ExecutionRow {
  id: number;
  slug: string;
  direction: string | null;
  source: string | null;
  amount: number;
  fill_price: number | null;
  status: string;
  executed_at: number;
  pnl: number | null;
  order_id: string | null;
  pipeline_run_id: string | null;
}

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

function parseArenaWindow(value: unknown): ArenaWindow {
  return value === "day" || value === "week" ? value : "all";
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

  let executions: ExecutionRow[];
  let liveRows: Array<{ slug: string; probability: number }>;

  if (isPgEnabled()) {
    executions = await pgQuery(
      `SELECT id, slug, direction, source, amount, fill_price, status, executed_at, pnl, order_id, pipeline_run_id
         FROM executions
        WHERE agent_id = $1
        ORDER BY executed_at DESC
        LIMIT 500`,
      [linkedAgent.agentId]
    );

    liveRows = await pgQuery(
      `SELECT s.slug, s.probability FROM scanner_results s
       INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) t
       ON s.slug = t.slug AND s.scanned_at = t.latest`
    );
  } else {
    const db = getDb();
    executions = db.prepare(
      `SELECT id, slug, direction, source, amount, fill_price, status, executed_at, pnl, order_id, pipeline_run_id
         FROM executions
        WHERE agent_id = ?
        ORDER BY executed_at DESC
        LIMIT 500`
    ).all(linkedAgent.agentId) as ExecutionRow[];

    liveRows = db.prepare(
      `SELECT s.slug, s.probability FROM scanner_results s
       INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) t
       ON s.slug = t.slug AND s.scanned_at = t.latest`
    ).all() as Array<{ slug: string; probability: number }>;
  }

  const livePrice = new Map(liveRows.map((row) => [row.slug, row.probability]));
  const scannerDirections = await getLatestScannerDirectionMap();

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

async function loadArenaAgents(viewerAgentId?: string | null): Promise<ArenaAgentRecord[]> {
  const columns = `id, agent_code, status, name, avatar_emoji, animal_type, agent_type, connection_status, autopilot_enabled, polymarket_ready`;

  if (isPgEnabled()) {
    const activeAgents = await pgQuery<ArenaAgentRecord>(
      `SELECT ${columns}
       FROM agents
       WHERE status = 'active'
       ORDER BY updated_at DESC NULLS LAST`
    );

    if (!viewerAgentId || activeAgents.some((agent) => agent.id === viewerAgentId)) {
      return activeAgents;
    }

    const viewerAgent = await pgQueryOne<ArenaAgentRecord>(
      `SELECT ${columns}
       FROM agents
       WHERE id = $1`,
      [viewerAgentId]
    );

    return viewerAgent ? [...activeAgents, viewerAgent] : activeAgents;
  }

  const db = getDb();
  const activeAgents = db.prepare(
    `SELECT ${columns}
     FROM agents
     WHERE status = 'active'
     ORDER BY updated_at DESC`
  ).all() as ArenaAgentRecord[];

  if (!viewerAgentId || activeAgents.some((agent) => agent.id === viewerAgentId)) {
    return activeAgents;
  }

  const viewerAgent = db.prepare(
    `SELECT ${columns}
     FROM agents
     WHERE id = ?`
  ).get(viewerAgentId) as ArenaAgentRecord | undefined;

  return viewerAgent ? [...activeAgents, viewerAgent] : activeAgents;
}

async function loadArenaExecutions(agentIds: string[]): Promise<ArenaExecutionRecord[]> {
  if (agentIds.length === 0) return [];

  if (isPgEnabled()) {
    return pgQuery<ArenaExecutionRecord>(
      `SELECT id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price, pnl, closed_at, updated_at
       FROM executions
       WHERE agent_id = ANY($1::text[])
       ORDER BY executed_at DESC`,
      [agentIds]
    );
  }

  const db = getDb();
  const placeholders = agentIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price, pnl, closed_at, updated_at
     FROM executions
     WHERE agent_id IN (${placeholders})
     ORDER BY executed_at DESC`
  ).all(...agentIds) as ArenaExecutionRecord[];
}

async function getLatestArenaScannerPriceMap(): Promise<Map<string, number>> {
  let rows: Array<{ slug: string; probability: number }>;

  if (isPgEnabled()) {
    rows = await pgQuery<{ slug: string; probability: number }>(
      `SELECT DISTINCT ON (slug) slug, probability
       FROM scanner_results
       ORDER BY slug, scanned_at DESC`
    );
  } else {
    const db = getDb();
    rows = db.prepare(
      `SELECT s.slug, s.probability
       FROM scanner_results s
       INNER JOIN (
         SELECT slug, MAX(scanned_at) AS latest
         FROM scanner_results
         GROUP BY slug
       ) latest
         ON latest.slug = s.slug AND latest.latest = s.scanned_at`
    ).all() as Array<{ slug: string; probability: number }>;
  }

  return new Map(rows.map((row) => [row.slug, Number(row.probability ?? 0.5)]));
}

router.get("/summary", async (req: Request, res) => {
  try {
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    const context = linkedAgent?.agentId
      ? await loadToolExecutionContextByAgentId(linkedAgent.agentId, userId)
      : null;
    const snapshot = await loadPortfolioSnapshot(context);
    const attribution = attributionEngine.getAttributionBySignal();
    const alphaDecay = attributionEngine.getAlphaDecayStatus();

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

router.get("/attribution", (_req, res) => {
  const data = attributionEngine.getAttributionBySignal();
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

router.get("/arena", async (req, res) => {
  try {
    const window = parseArenaWindow(req.query.window);
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    const viewerAgentId = linkedAgent?.agentId ?? null;
    const agents = await loadArenaAgents(viewerAgentId);
    const executions = await loadArenaExecutions(agents.map((agent) => agent.id));
    const [latestPrices, scannerDirections] = await Promise.all([
      getLatestArenaScannerPriceMap(),
      getLatestScannerDirectionMap(),
    ]);

    res.json(buildArenaLeaderboard({
      window,
      agents,
      executions,
      latestPrices,
      scannerDirections,
      viewerAgentId,
    }));
  } catch (err) {
    console.error("[performance:arena] error:", err);
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

router.get("/drift", (_req, res) => {
  try {
    const microstructure = driftDetection.checkMicrostructureDrift();
    const concept = driftDetection.checkConceptDrift();
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
