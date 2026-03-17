import type { ArenaExecutionRecord } from "./arena";

// ── Agent Strategy DNA ──────────────────────────────────────────────────────
// A 6-axis "fingerprint" (each axis 0-1) representing an agent's trading style.
// Computed from execution data at leaderboard build time — no new DB queries.
//
// Axes:
//   volume:       trade count relative to the arena's most active agent
//   diversity:    unique markets traded (capped at 10)
//   speed:        how quickly positions close (faster = higher)
//   streak:       max historical consecutive-win run
//   riskAppetite: average position size relative to arena median
//   timing:       recency-weighted win rate

export interface AgentDNA {
  volume: number;
  diversity: number;
  speed: number;
  streak: number;
  riskAppetite: number;
  timing: number;
}

export interface ArenaDNAStats {
  maxTrades: number;
  medianAmount: number;
}

const EMPTY_DNA: AgentDNA = {
  volume: 0,
  diversity: 0,
  speed: 0,
  streak: 0,
  riskAppetite: 0,
  timing: 0,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

function computeMaxStreak(executions: ArenaExecutionRecord[]): number {
  const settled = executions
    .filter((e) => e.pnl != null)
    .sort((a, b) => a.executed_at - b.executed_at);

  let maxStreak = 0;
  let currentStreak = 0;

  for (const execution of settled) {
    if ((execution.pnl ?? 0) > 0) {
      currentStreak += 1;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  return maxStreak;
}

function computeAvgCloseHours(executions: ArenaExecutionRecord[]): number {
  const closed = executions.filter(
    (e) => e.closed_at != null && e.executed_at > 0,
  );
  if (closed.length === 0) return 168; // default to 1 week (slowest)

  const totalHours = closed.reduce((sum, e) => {
    const durationMs = (e.closed_at ?? e.executed_at) - e.executed_at;
    return sum + Math.max(0, durationMs) / (1000 * 60 * 60);
  }, 0);

  return totalHours / closed.length;
}

function computeRecentWinRate(executions: ArenaExecutionRecord[]): number {
  // Weight recent trades more heavily: last 20 trades get full weight,
  // older trades get linearly decaying weight
  const settled = executions
    .filter((e) => e.pnl != null)
    .sort((a, b) => b.executed_at - a.executed_at);

  if (settled.length === 0) return 0;

  let weightedWins = 0;
  let totalWeight = 0;

  for (let i = 0; i < settled.length; i++) {
    const weight = i < 20 ? 1.0 : Math.max(0.1, 1.0 - (i - 20) * 0.02);
    totalWeight += weight;
    if ((settled[i].pnl ?? 0) > 0) {
      weightedWins += weight;
    }
  }

  return totalWeight > 0 ? (weightedWins / totalWeight) * 100 : 0;
}

export function computeAgentDNA(
  executions: ArenaExecutionRecord[],
  arenaStats: ArenaDNAStats,
): AgentDNA {
  const valid = executions.filter((e) => e.status !== "failed");
  if (valid.length === 0) return EMPTY_DNA;

  // Volume: trade count relative to the arena's most active agent
  const volume = arenaStats.maxTrades > 0
    ? clamp01(valid.length / arenaStats.maxTrades)
    : 0;

  // Diversity: unique markets traded, capped at 10
  const uniqueMarkets = new Set(valid.map((e) => e.slug)).size;
  const diversity = clamp01(uniqueMarkets / 10);

  // Speed: inverse of average close time (faster = higher)
  const avgCloseHours = computeAvgCloseHours(valid);
  const speed = clamp01(1 - avgCloseHours / 168);

  // Streak: max historical consecutive-win run
  const maxStreak = computeMaxStreak(valid);
  const streak = clamp01(maxStreak / 15);

  // Risk appetite: average position size relative to arena median
  const avgAmount = valid.reduce((sum, e) => sum + e.amount, 0) / valid.length;
  const riskAppetite = arenaStats.medianAmount > 0
    ? clamp01(avgAmount / (2 * arenaStats.medianAmount))
    : 0;

  // Timing: recency-weighted win rate
  const timing = clamp01(computeRecentWinRate(valid) / 100);

  return { volume, diversity, speed, streak, riskAppetite, timing };
}

/** Compute global arena stats needed for DNA normalization. */
export function computeArenaDNAStats(
  executionsByAgent: Map<string, ArenaExecutionRecord[]>,
): ArenaDNAStats {
  let maxTrades = 0;
  const allAmounts: number[] = [];

  for (const [, agentExecs] of executionsByAgent) {
    const valid = agentExecs.filter((e) => e.status !== "failed");
    maxTrades = Math.max(maxTrades, valid.length);
    for (const e of valid) {
      allAmounts.push(e.amount);
    }
  }

  // Compute median amount
  allAmounts.sort((a, b) => a - b);
  const medianAmount = allAmounts.length > 0
    ? allAmounts[Math.floor(allAmounts.length / 2)]
    : 0;

  return { maxTrades, medianAmount };
}
