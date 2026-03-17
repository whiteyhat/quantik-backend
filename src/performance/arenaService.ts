import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne } from "../db/postgres";
import { getLatestScannerDirectionMap, type ExecutionDirection } from "../utils/executionDirection";
import {
  buildArenaLeaderboard,
  type ArenaAgentRecord,
  type ArenaExecutionRecord,
  type ArenaLeaderboardResponse,
  type ArenaWindow,
} from "./arena";
import { loadPreviousRanks } from "./arenaSnapshots";

const ARENA_AGENT_COLUMNS = "id, user_id, agent_code, status, name, avatar_emoji, animal_type, agent_type, connection_status, autopilot_enabled, polymarket_ready";
const ARENA_CACHE_TTL_MS = 15_000;
const SCANNER_STALENESS_MS = 2 * 60 * 60 * 1000; // 2 hours

interface SharedArenaSnapshot {
  activeAgents: ArenaAgentRecord[];
  activeAgentIds: Set<string>;
  activeExecutions: ArenaExecutionRecord[];
  latestPrices: Map<string, number>;
  scannerDirections: Map<string, ExecutionDirection>;
  scannerTimestamps: Map<string, number>;
  loadedAt: number;
}

let sharedArenaSnapshot: SharedArenaSnapshot | null = null;
let sharedArenaSnapshotPromise: Promise<SharedArenaSnapshot> | null = null;

async function loadActiveArenaAgents(): Promise<ArenaAgentRecord[]> {
  if (isPgEnabled()) {
    return pgQuery<ArenaAgentRecord>(
      `SELECT ${ARENA_AGENT_COLUMNS}
       FROM agents
       WHERE status = 'active'
       ORDER BY updated_at DESC NULLS LAST`
    );
  }

  const db = getDb();
  return db.prepare(
    `SELECT ${ARENA_AGENT_COLUMNS}
     FROM agents
     WHERE status = 'active'
     ORDER BY updated_at DESC`
  ).all() as ArenaAgentRecord[];
}

async function loadArenaAgentById(agentId: string): Promise<ArenaAgentRecord | null> {
  if (isPgEnabled()) {
    return await pgQueryOne<ArenaAgentRecord>(
      `SELECT ${ARENA_AGENT_COLUMNS}
       FROM agents
       WHERE id = $1`,
      [agentId]
    ) ?? null;
  }

  const db = getDb();
  const row = db.prepare(
    `SELECT ${ARENA_AGENT_COLUMNS}
     FROM agents
     WHERE id = ?`
  ).get(agentId) as ArenaAgentRecord | undefined;
  return row ?? null;
}

async function loadArenaExecutions(agentIds: string[], sinceMs?: number): Promise<ArenaExecutionRecord[]> {
  if (agentIds.length === 0) return [];

  if (isPgEnabled()) {
    if (sinceMs != null) {
      return pgQuery<ArenaExecutionRecord>(
        `SELECT id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price, pnl, closed_at, updated_at
         FROM executions
         WHERE agent_id = ANY($1::text[])
           AND (executed_at >= $2 OR (pnl IS NULL AND (status = 'placed' OR status = 'paper')))
         ORDER BY executed_at DESC`,
        [agentIds, sinceMs]
      );
    }
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
  if (sinceMs != null) {
    return db.prepare(
      `SELECT id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price, pnl, closed_at, updated_at
       FROM executions
       WHERE agent_id IN (${placeholders})
         AND (executed_at >= ? OR (pnl IS NULL AND (status = 'placed' OR status = 'paper')))
       ORDER BY executed_at DESC`
    ).all(...agentIds, sinceMs) as ArenaExecutionRecord[];
  }
  return db.prepare(
    `SELECT id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price, pnl, closed_at, updated_at
     FROM executions
     WHERE agent_id IN (${placeholders})
     ORDER BY executed_at DESC`
  ).all(...agentIds) as ArenaExecutionRecord[];
}

async function getLatestArenaScannerPrices(): Promise<{
  prices: Map<string, number>;
  timestamps: Map<string, number>;
}> {
  let rows: Array<{ slug: string; probability: number; scanned_at: number }>;

  if (isPgEnabled()) {
    rows = await pgQuery<{ slug: string; probability: number; scanned_at: number }>(
      `SELECT DISTINCT ON (slug) slug, probability, scanned_at
       FROM scanner_results
       ORDER BY slug, scanned_at DESC`
    );
  } else {
    const db = getDb();
    rows = db.prepare(
      `SELECT s.slug, s.probability, s.scanned_at
       FROM scanner_results s
       INNER JOIN (
         SELECT slug, MAX(scanned_at) AS latest
         FROM scanner_results
         GROUP BY slug
       ) latest
         ON latest.slug = s.slug AND latest.latest = s.scanned_at`
    ).all() as Array<{ slug: string; probability: number; scanned_at: number }>;
  }

  return {
    prices: new Map(rows.map((row) => [row.slug, Number(row.probability ?? 0.5)])),
    timestamps: new Map(rows.map((row) => [row.slug, Number(row.scanned_at ?? 0)])),
  };
}

async function loadSharedArenaSnapshot(): Promise<SharedArenaSnapshot> {
  const now = Date.now();
  if (sharedArenaSnapshot && now - sharedArenaSnapshot.loadedAt < ARENA_CACHE_TTL_MS) {
    return sharedArenaSnapshot;
  }

  if (sharedArenaSnapshotPromise) return sharedArenaSnapshotPromise;

  sharedArenaSnapshotPromise = (async () => {
    const activeAgents = await loadActiveArenaAgents();
    const activeAgentIds = activeAgents.map((agent) => agent.id);
    const [activeExecutions, scannerData, scannerDirections] = await Promise.all([
      loadArenaExecutions(activeAgentIds),
      getLatestArenaScannerPrices(),
      getLatestScannerDirectionMap(),
    ]);

    const snapshot: SharedArenaSnapshot = {
      activeAgents,
      activeAgentIds: new Set(activeAgentIds),
      activeExecutions,
      latestPrices: scannerData.prices,
      scannerDirections,
      scannerTimestamps: scannerData.timestamps,
      loadedAt: Date.now(),
    };
    sharedArenaSnapshot = snapshot;
    return snapshot;
  })();

  try {
    return await sharedArenaSnapshotPromise;
  } finally {
    sharedArenaSnapshotPromise = null;
  }
}

export async function loadArenaLeaderboard(window: ArenaWindow, viewerAgentId?: string | null, limit?: number, offset?: number): Promise<ArenaLeaderboardResponse> {
  const [snapshot, previousRanks] = await Promise.all([
    loadSharedArenaSnapshot(),
    loadPreviousRanks(window),
  ]);

  let agents = snapshot.activeAgents;
  let executions = snapshot.activeExecutions;

  if (viewerAgentId && !snapshot.activeAgentIds.has(viewerAgentId)) {
    const viewerAgent = await loadArenaAgentById(viewerAgentId);
    if (viewerAgent) {
      const viewerExecutions = await loadArenaExecutions([viewerAgentId]);
      agents = [...snapshot.activeAgents, viewerAgent];
      executions = [...snapshot.activeExecutions, ...viewerExecutions];
    }
  }

  return buildArenaLeaderboard({
    window,
    agents,
    executions,
    latestPrices: snapshot.latestPrices,
    scannerDirections: snapshot.scannerDirections,
    scannerTimestamps: snapshot.scannerTimestamps,
    stalenessThresholdMs: SCANNER_STALENESS_MS,
    previousRanks: previousRanks.size > 0 ? previousRanks : undefined,
    viewerAgentId: viewerAgentId ?? null,
    limit,
    offset,
  });
}

export function resetArenaLeaderboardCache(): void {
  sharedArenaSnapshot = null;
  sharedArenaSnapshotPromise = null;
}

/** Return the cached active agents (includes user_id for notification routing). */
export async function loadCachedArenaAgents(): Promise<ArenaAgentRecord[]> {
  const snapshot = await loadSharedArenaSnapshot();
  return snapshot.activeAgents;
}
