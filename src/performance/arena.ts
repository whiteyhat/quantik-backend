import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  type ExecutionDirection,
} from "../utils/executionDirection";

export type ArenaWindow = "day" | "week" | "all";
export const ARENA_WINDOW_VALUES: ArenaWindow[] = ["day", "week", "all"];

export function isArenaWindow(value: unknown): value is ArenaWindow {
  return value === "day" || value === "week" || value === "all";
}

export function parseArenaWindow(value: unknown, fallback: ArenaWindow = "all"): ArenaWindow {
  return isArenaWindow(value) ? value : fallback;
}

export interface ArenaAgentRecord {
  id: string;
  agent_code: string;
  status: string;
  name: string;
  avatar_emoji: string;
  animal_type: string | null;
  agent_type: string;
  connection_status: string | null;
  autopilot_enabled: number | boolean | null;
  polymarket_ready: number | boolean | null;
}

export interface ArenaExecutionRecord {
  id: number;
  agent_id: string | null;
  slug: string;
  side: string | null;
  direction: string | null;
  source: string | null;
  amount: number;
  executed_at: number;
  status: string;
  fill_price: number | null;
  pnl: number | null;
  closed_at: number | null;
  updated_at: number | null;
}

export interface ArenaLeaderboardEntry {
  rank: number;
  agentId: string;
  agentCode: string;
  name: string;
  avatarEmoji: string;
  animalType: string | null;
  agentType: string;
  connectionStatus: string | null;
  autopilotEnabled: boolean;
  polymarketReady: boolean;
  selectedPnl: number;
  selectedRealizedPnl: number;
  selectedUnrealizedPnl: number;
  allTimePnl: number;
  totalTrades: number;
  winRate: number;
  openPositions: number;
  currentStreak: number;
  lastTradeAt: number | null;
  bestTradeSlug: string | null;
  bestTradePnl: number;
}

export interface ArenaViewerContext {
  agentId: string | null;
  eligible: boolean;
  ranked: boolean;
  rank: number | null;
  entry: ArenaLeaderboardEntry | null;
  referencePnl: number;
  gapToTop10: number;
  gapToPodium: number;
  gapToCrown: number;
  reason: "no_agent" | "inactive" | "no_activity" | "ranked";
}

export interface ArenaLeaderboardResponse {
  window: ArenaWindow;
  updatedAt: number;
  meta: {
    rankedAgents: number;
    activeAgents: number;
    totalSelectedPnlPool: number;
    totalRealizedPnlPool: number;
    totalUnrealizedPnlPool: number;
    lastTradeAt: number | null;
  };
  leaders: ArenaLeaderboardEntry[];
  viewer: ArenaViewerContext;
}

interface ArenaEntryComputation {
  entry: ArenaLeaderboardEntry;
  eligible: boolean;
}

interface BuildArenaLeaderboardOptions {
  window: ArenaWindow;
  now?: number;
  agents: ArenaAgentRecord[];
  executions: ArenaExecutionRecord[];
  latestPrices: Map<string, number>;
  scannerDirections: Map<string, ExecutionDirection>;
  viewerAgentId?: string | null;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function getWindowStart(window: ArenaWindow, now: number): number {
  if (window === "day") return now - 24 * 60 * 60 * 1000;
  if (window === "week") return now - 7 * 24 * 60 * 60 * 1000;
  return 0;
}

function isOpenExecution(execution: ArenaExecutionRecord): boolean {
  return execution.pnl == null && (execution.status === "placed" || execution.status === "paper");
}

function settlementTime(execution: ArenaExecutionRecord): number {
  return execution.closed_at ?? execution.updated_at ?? execution.executed_at;
}

function withinWindow(timestamp: number, start: number, window: ArenaWindow): boolean {
  return window === "all" || timestamp >= start;
}

function computeCurrentStreak(executions: ArenaExecutionRecord[]): number {
  const settled = executions
    .filter((execution) => execution.pnl != null)
    .sort((left, right) => settlementTime(right) - settlementTime(left));

  if (settled.length === 0) return 0;

  const firstWasWin = (settled[0].pnl ?? 0) > 0;
  let streak = 0;

  for (const execution of settled) {
    const wasWin = (execution.pnl ?? 0) > 0;
    if (wasWin !== firstWasWin) break;
    streak += 1;
  }

  return firstWasWin ? streak : -streak;
}

function compareEntries(left: ArenaLeaderboardEntry, right: ArenaLeaderboardEntry): number {
  if (right.selectedPnl !== left.selectedPnl) return right.selectedPnl - left.selectedPnl;
  if (right.allTimePnl !== left.allTimePnl) return right.allTimePnl - left.allTimePnl;
  if (right.winRate !== left.winRate) return right.winRate - left.winRate;
  if ((right.lastTradeAt ?? 0) !== (left.lastTradeAt ?? 0)) return (right.lastTradeAt ?? 0) - (left.lastTradeAt ?? 0);
  return left.agentId.localeCompare(right.agentId);
}

function gapToRank(leaders: ArenaLeaderboardEntry[], referencePnl: number, rank: number): number {
  if (leaders.length === 0) return 0;
  const target = leaders[Math.min(Math.max(rank, 1), leaders.length) - 1]?.selectedPnl ?? leaders[leaders.length - 1]?.selectedPnl ?? referencePnl;
  return round2(Math.max(0, target - referencePnl));
}

function computeAgentEntry(
  agent: ArenaAgentRecord,
  executions: ArenaExecutionRecord[],
  latestPrices: Map<string, number>,
  scannerDirections: Map<string, ExecutionDirection>,
  window: ArenaWindow,
  windowStart: number,
): ArenaEntryComputation {
  const validExecutions = executions.filter((execution) => execution.status !== "failed");
  const openExecutions = validExecutions.filter(isOpenExecution);
  const settledExecutions = validExecutions.filter((execution) => execution.pnl != null);

  let selectedRealizedPnl = 0;
  let selectedUnrealizedPnl = 0;
  let lifetimeRealizedPnl = 0;
  let lifetimeUnrealizedPnl = 0;

  for (const execution of settledExecutions) {
    lifetimeRealizedPnl += Number(execution.pnl ?? 0);
    if (withinWindow(settlementTime(execution), windowStart, window)) {
      selectedRealizedPnl += Number(execution.pnl ?? 0);
    }
  }

  for (const execution of openExecutions) {
    const scannerDirection = scannerDirections.get(execution.slug);
    const currentYesPrice = latestPrices.get(execution.slug) ?? getEntryYesPrice(execution, scannerDirection);
    const metrics = calculateOpenExecutionMetrics(execution, currentYesPrice, scannerDirection);
    lifetimeUnrealizedPnl += metrics.pnl;

    if (withinWindow(execution.executed_at, windowStart, window)) {
      selectedUnrealizedPnl += metrics.pnl;
    }
  }

  const allTimePnl = lifetimeRealizedPnl + lifetimeUnrealizedPnl;
  const selectedPnl = window === "all"
    ? allTimePnl
    : selectedRealizedPnl + selectedUnrealizedPnl;

  const bestTrade = settledExecutions
    .filter((execution) => withinWindow(settlementTime(execution), windowStart, window))
    .sort((left, right) => Number(right.pnl ?? 0) - Number(left.pnl ?? 0))[0] ?? null;

  const lifetimeWins = settledExecutions.filter((execution) => Number(execution.pnl ?? 0) > 0).length;
  const winRate = settledExecutions.length > 0 ? lifetimeWins / settledExecutions.length : 0;
  const lastTradeAt = validExecutions.reduce<number | null>((latest, execution) => {
    if (latest == null) return execution.executed_at;
    return Math.max(latest, execution.executed_at);
  }, null);

  return {
    eligible: agent.status === "active" && validExecutions.length > 0,
    entry: {
      rank: 0,
      agentId: agent.id,
      agentCode: agent.agent_code,
      name: agent.name,
      avatarEmoji: agent.avatar_emoji,
      animalType: agent.animal_type,
      agentType: agent.agent_type,
      connectionStatus: agent.connection_status,
      autopilotEnabled: normalizeBoolean(agent.autopilot_enabled),
      polymarketReady: normalizeBoolean(agent.polymarket_ready),
      selectedPnl: round2(selectedPnl),
      selectedRealizedPnl: round2(window === "all" ? lifetimeRealizedPnl : selectedRealizedPnl),
      selectedUnrealizedPnl: round2(window === "all" ? lifetimeUnrealizedPnl : selectedUnrealizedPnl),
      allTimePnl: round2(allTimePnl),
      totalTrades: validExecutions.length,
      winRate: round2(winRate * 100),
      openPositions: openExecutions.length,
      currentStreak: computeCurrentStreak(validExecutions),
      lastTradeAt,
      bestTradeSlug: bestTrade?.slug ?? null,
      bestTradePnl: round2(Number(bestTrade?.pnl ?? 0)),
    },
  };
}

export function buildArenaLeaderboard({
  window,
  now = Date.now(),
  agents,
  executions,
  latestPrices,
  scannerDirections,
  viewerAgentId = null,
}: BuildArenaLeaderboardOptions): ArenaLeaderboardResponse {
  const windowStart = getWindowStart(window, now);
  const executionsByAgent = new Map<string, ArenaExecutionRecord[]>();

  for (const execution of executions) {
    if (!execution.agent_id) continue;
    const agentExecutions = executionsByAgent.get(execution.agent_id) ?? [];
    agentExecutions.push(execution);
    executionsByAgent.set(execution.agent_id, agentExecutions);
  }

  const computed = agents.map((agent) => ({
    agent,
    ...computeAgentEntry(
      agent,
      executionsByAgent.get(agent.id) ?? [],
      latestPrices,
      scannerDirections,
      window,
      windowStart,
    ),
  }));

  const leaders = computed
    .filter((record) => record.eligible)
    .map((record) => record.entry)
    .sort(compareEntries)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  const leaderByAgentId = new Map(leaders.map((entry) => [entry.agentId, entry]));
  const viewerRecord = viewerAgentId
    ? computed.find((record) => record.agent.id === viewerAgentId) ?? null
    : null;
  const viewerEntry = viewerRecord
    ? leaderByAgentId.get(viewerRecord.agent.id) ?? viewerRecord.entry
    : null;
  const viewerReferencePnl = viewerEntry?.selectedPnl ?? 0;

  const viewer: ArenaViewerContext = viewerRecord
    ? {
        agentId: viewerRecord.agent.id,
        eligible: viewerRecord.eligible,
        ranked: leaderByAgentId.has(viewerRecord.agent.id),
        rank: leaderByAgentId.get(viewerRecord.agent.id)?.rank ?? null,
        entry: viewerEntry,
        referencePnl: round2(viewerReferencePnl),
        gapToTop10: gapToRank(leaders, viewerReferencePnl, 10),
        gapToPodium: gapToRank(leaders, viewerReferencePnl, 3),
        gapToCrown: gapToRank(leaders, viewerReferencePnl, 1),
        reason: viewerRecord.agent.status !== "active"
          ? "inactive"
          : viewerRecord.eligible
            ? "ranked"
            : "no_activity",
      }
    : {
        agentId: null,
        eligible: false,
        ranked: false,
        rank: null,
        entry: null,
        referencePnl: 0,
        gapToTop10: 0,
        gapToPodium: 0,
        gapToCrown: 0,
        reason: "no_agent",
      };

  return {
    window,
    updatedAt: now,
    meta: {
      rankedAgents: leaders.length,
      activeAgents: agents.filter((agent) => agent.status === "active").length,
      totalSelectedPnlPool: round2(leaders.reduce((sum, entry) => sum + entry.selectedPnl, 0)),
      totalRealizedPnlPool: round2(leaders.reduce((sum, entry) => sum + entry.selectedRealizedPnl, 0)),
      totalUnrealizedPnlPool: round2(leaders.reduce((sum, entry) => sum + entry.selectedUnrealizedPnl, 0)),
      lastTradeAt: leaders.reduce<number | null>((latest, entry) => {
        if (entry.lastTradeAt == null) return latest;
        if (latest == null) return entry.lastTradeAt;
        return Math.max(latest, entry.lastTradeAt);
      }, null),
    },
    leaders,
    viewer,
  };
}
