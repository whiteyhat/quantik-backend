import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgExec } from "../db/postgres";
import { loadArenaLeaderboard, loadCachedArenaAgents } from "./arenaService";
import { emitToAll } from "../infra/socket";
import type { ArenaWindow, ArenaLeaderboardEntry, ArenaAgentRecord } from "./arena";
import { emitArenaNotifications } from "./arenaNotifications";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ArenaSnapshotRow {
  agent_id: string;
  window: ArenaWindow;
  rank: number;
  selected_pnl: number;
  all_time_pnl: number;
  win_rate: number;
  total_trades: number;
  snapshot_at: number;
}

export interface ArenaRankDelta {
  agentId: string;
  name: string;
  avatarEmoji: string;
  previousRank: number | null;
  currentRank: number;
  rankChange: number; // positive = moved up, negative = moved down, 0 = unchanged
}

export interface ArenaLeaderboardDeltaEvent {
  window: ArenaWindow;
  deltas: ArenaRankDelta[];
  timestamp: number;
}

// ── Snapshot Writer ──────────────────────────────────────────────────────────
// Captures current leaderboard state for all 3 windows.
// Called hourly by the scheduler.

const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const WINDOWS: ArenaWindow[] = ["day", "week", "all"];

async function writeSnapshot(window: ArenaWindow): Promise<ArenaLeaderboardEntry[]> {
  const result = await loadArenaLeaderboard(window);
  const now = Date.now();
  const leaders = result.leaders;

  if (leaders.length === 0) return leaders;

  if (isPgEnabled()) {
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const entry of leaders) {
      values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
      params.push(entry.agentId, window, entry.rank, entry.selectedPnl, entry.allTimePnl, entry.winRate, entry.totalTrades, now);
      idx += 8;
    }

    await pgExec(
      `INSERT INTO arena_snapshots (agent_id, "window", rank, selected_pnl, all_time_pnl, win_rate, total_trades, snapshot_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (agent_id, "window", snapshot_at) DO NOTHING`,
      params,
    );
  } else {
    const db = getDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO arena_snapshots (agent_id, "window", rank, selected_pnl, all_time_pnl, win_rate, total_trades, snapshot_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = db.transaction(() => {
      for (const entry of leaders) {
        insert.run(entry.agentId, window, entry.rank, entry.selectedPnl, entry.allTimePnl, entry.winRate, entry.totalTrades, now);
      }
    });
    tx();
  }

  return leaders;
}

function cleanupOldSnapshots(): void {
  const cutoff = Date.now() - SNAPSHOT_TTL_MS;

  if (isPgEnabled()) {
    pgExec("DELETE FROM arena_snapshots WHERE snapshot_at < $1", [cutoff]).catch((err) => {
      console.error("[arena-snapshots] cleanup failed:", err);
    });
  } else {
    const db = getDb();
    db.prepare("DELETE FROM arena_snapshots WHERE snapshot_at < ?").run(cutoff);
  }
}

// ── Previous Rank Loader ─────────────────────────────────────────────────────
// Loads the most recent snapshot before the current one for rank-change deltas.

export async function loadPreviousRanks(window: ArenaWindow, beforeTimestamp?: number): Promise<Map<string, number>> {
  const before = beforeTimestamp ?? Date.now();

  let rows: Array<{ agent_id: string; rank: number }>;

  if (isPgEnabled()) {
    // Get the most recent snapshot_at before `before`
    const [timeRow] = await pgQuery<{ snapshot_at: number }>(
      `SELECT DISTINCT snapshot_at FROM arena_snapshots
       WHERE "window" = $1 AND snapshot_at < $2
       ORDER BY snapshot_at DESC LIMIT 1`,
      [window, before],
    );
    if (!timeRow) return new Map();

    rows = await pgQuery<{ agent_id: string; rank: number }>(
      `SELECT agent_id, rank FROM arena_snapshots
       WHERE "window" = $1 AND snapshot_at = $2`,
      [window, timeRow.snapshot_at],
    );
  } else {
    const db = getDb();
    const timeRow = db.prepare(
      `SELECT DISTINCT snapshot_at FROM arena_snapshots
       WHERE "window" = ? AND snapshot_at < ?
       ORDER BY snapshot_at DESC LIMIT 1`,
    ).get(window, before) as { snapshot_at: number } | undefined;
    if (!timeRow) return new Map();

    rows = db.prepare(
      `SELECT agent_id, rank FROM arena_snapshots
       WHERE "window" = ? AND snapshot_at = ?`,
    ).all(window, timeRow.snapshot_at) as Array<{ agent_id: string; rank: number }>;
  }

  return new Map(rows.map((row) => [row.agent_id, row.rank]));
}

// ── Agent History (for sparklines) ───────────────────────────────────────

export interface ArenaSparklinePoint {
  timestamp: number;
  pnl: number;
  rank: number;
}

export async function loadAgentHistory(
  agentId: string,
  window: ArenaWindow,
  limit = 168,
): Promise<ArenaSparklinePoint[]> {
  let rows: Array<{ snapshot_at: number; selected_pnl: number; rank: number }>;

  if (isPgEnabled()) {
    rows = await pgQuery<{ snapshot_at: number; selected_pnl: number; rank: number }>(
      `SELECT snapshot_at, selected_pnl, rank FROM arena_snapshots
       WHERE agent_id = $1 AND "window" = $2
       ORDER BY snapshot_at DESC LIMIT $3`,
      [agentId, window, limit],
    );
  } else {
    const db = getDb();
    rows = db.prepare(
      `SELECT snapshot_at, selected_pnl, rank FROM arena_snapshots
       WHERE agent_id = ? AND "window" = ?
       ORDER BY snapshot_at DESC LIMIT ?`,
    ).all(agentId, window, limit) as typeof rows;
  }

  return rows.reverse().map((row) => ({
    timestamp: row.snapshot_at,
    pnl: row.selected_pnl,
    rank: row.rank,
  }));
}

// ── Head-to-Head Comparison ──────────────────────────────────────────────

export interface ArenaComparisonAgent {
  agentId: string;
  agentCode: string;
  name: string;
  avatarEmoji: string;
  rank: number | null;
  selectedPnl: number;
  allTimePnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  currentStreak: number;
  sparkline: ArenaSparklinePoint[];
}

export async function loadComparison(
  agentId1: string,
  agentId2: string,
  window: ArenaWindow,
): Promise<{ window: ArenaWindow; agents: [ArenaComparisonAgent, ArenaComparisonAgent] } | null> {
  const result = await loadArenaLeaderboard(window);
  const entry1 = result.leaders.find((e) => e.agentId === agentId1);
  const entry2 = result.leaders.find((e) => e.agentId === agentId2);
  if (!entry1 && !entry2) return null;

  const [spark1, spark2] = await Promise.all([
    loadAgentHistory(agentId1, window, 48),
    loadAgentHistory(agentId2, window, 48),
  ]);

  function toComp(entry: typeof entry1, sparkline: ArenaSparklinePoint[]): ArenaComparisonAgent {
    return {
      agentId: entry?.agentId ?? "",
      agentCode: entry?.agentCode ?? "",
      name: entry?.name ?? "Unknown",
      avatarEmoji: entry?.avatarEmoji ?? "?",
      rank: entry?.rank ?? null,
      selectedPnl: entry?.selectedPnl ?? 0,
      allTimePnl: entry?.allTimePnl ?? 0,
      winRate: entry?.winRate ?? 0,
      totalTrades: entry?.totalTrades ?? 0,
      openPositions: entry?.openPositions ?? 0,
      currentStreak: entry?.currentStreak ?? 0,
      sparkline,
    };
  }

  return {
    window,
    agents: [toComp(entry1, spark1), toComp(entry2, spark2)],
  };
}

// ── Compute Deltas ───────────────────────────────────────────────────────────

function computeDeltas(leaders: ArenaLeaderboardEntry[], previousRanks: Map<string, number>): ArenaRankDelta[] {
  return leaders.map((entry) => {
    const previousRank = previousRanks.get(entry.agentId) ?? null;
    const rankChange = previousRank != null ? previousRank - entry.rank : 0;
    return {
      agentId: entry.agentId,
      name: entry.name,
      avatarEmoji: entry.avatarEmoji,
      previousRank,
      currentRank: entry.rank,
      rankChange,
    };
  });
}

// ── Socket Broadcast ─────────────────────────────────────────────────────────

function broadcastDelta(window: ArenaWindow, deltas: ArenaRankDelta[]): void {
  const movers = deltas.filter((d) => d.rankChange !== 0);
  if (movers.length === 0) return;

  const event: ArenaLeaderboardDeltaEvent = {
    window,
    deltas: movers,
    timestamp: Date.now(),
  };
  emitToAll("arena:leaderboard_delta", event);
}

// ── Scheduled Processor ──────────────────────────────────────────────────────
// This is the function called by the scheduler (hourly).
// 1. For each window: load previous ranks, write new snapshot, compute + broadcast deltas.
// 2. Cleanup snapshots older than 30 days.

export async function processArenaSnapshots(): Promise<void> {
  try {
    // Load agents with user_id for notification routing
    const agentRecords = await loadCachedArenaAgents();

    // Parallelize the DB-heavy snapshot + rank loading across all windows
    const windowResults = await Promise.all(
      WINDOWS.map(async (w) => {
        const [prevRanks, leaders] = await Promise.all([
          loadPreviousRanks(w),
          writeSnapshot(w),
        ]);
        return { window: w, leaders, previousRanks: prevRanks };
      }),
    );

    // Notifications use shared module state — run sequentially
    for (const { window, leaders, previousRanks } of windowResults) {
      const deltas = computeDeltas(leaders, previousRanks);
      broadcastDelta(window, deltas);
      emitArenaNotifications(window, leaders, agentRecords, deltas);
    }
    cleanupOldSnapshots();
    console.log("[arena-snapshots] Snapshot cycle complete");
  } catch (err) {
    console.error("[arena-snapshots] error:", err);
  }
}
