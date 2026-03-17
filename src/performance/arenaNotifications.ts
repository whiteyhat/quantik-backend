import { emitNotification } from "../infra/socket";
import type { ArenaLeaderboardEntry, ArenaAgentRecord, ArenaWindow } from "./arena";
import type { ArenaRankDelta } from "./arenaSnapshots";

// ── Arena Notifications ─────────────────────────────────────────────────────
// Emits notifications for significant arena events via the existing
// emitNotification() infrastructure (persisted to DB + pushed via socket).
//
// Called at the end of processArenaSnapshots() after deltas are computed.

const TRADE_MILESTONES = [10, 50, 100, 500] as const;

/** Previous badge counts per agent, cached between snapshot runs. */
let previousBadgeCounts = new Map<string, number>();

/** Previous trade counts per agent, cached between snapshot runs. */
let previousTradeCounts = new Map<string, number>();

/** Agent ID of the previous crown holder per window. */
let previousCrown = new Map<ArenaWindow, string>();

function findUserId(
  agentId: string,
  agents: ArenaAgentRecord[],
): string | null {
  const agent = agents.find((a) => a.id === agentId);
  return agent?.user_id ?? null;
}

export function emitArenaNotifications(
  window: ArenaWindow,
  leaders: ArenaLeaderboardEntry[],
  agents: ArenaAgentRecord[],
  deltas: ArenaRankDelta[],
): void {
  const now = Date.now();

  // ── Crown change ──────────────────────────────────────────────────────
  const currentCrown = leaders[0]?.agentId ?? null;
  const prevCrown = previousCrown.get(window) ?? null;
  if (currentCrown && currentCrown !== prevCrown && prevCrown !== null) {
    const champion = leaders[0];
    emitNotification(null, {
      id: `arena-crown-${window}-${now}`,
      level: "info",
      title: "New Arena Champion!",
      message: `${champion.avatarEmoji} ${champion.name} has seized the ${window === "day" ? "24H" : window === "week" ? "7D" : "All-Time"} crown!`,
      category: "arena",
      timestamp: now,
    });
  }
  if (currentCrown) previousCrown.set(window, currentCrown);

  // ── Rank movements into/out of top 10 ─────────────────────────────────
  for (const delta of deltas) {
    if (delta.rankChange === 0) continue;
    const userId = findUserId(delta.agentId, agents);
    if (!userId) continue;

    const enteredTop10 = delta.currentRank <= 10 && (delta.previousRank == null || delta.previousRank > 10);
    const leftTop10 = delta.currentRank > 10 && delta.previousRank != null && delta.previousRank <= 10;

    if (enteredTop10) {
      emitNotification(userId, {
        id: `arena-top10-enter-${window}-${delta.agentId}-${now}`,
        level: "success",
        title: "Top 10 Breakthrough!",
        message: `${delta.avatarEmoji} ${delta.name} broke into the top 10 at #${delta.currentRank}!`,
        category: "arena",
        timestamp: now,
      });
    } else if (leftTop10) {
      emitNotification(userId, {
        id: `arena-top10-exit-${window}-${delta.agentId}-${now}`,
        level: "warning",
        title: "Dropped from Top 10",
        message: `${delta.avatarEmoji} ${delta.name} dropped to #${delta.currentRank}.`,
        category: "arena",
        timestamp: now,
      });
    }
  }

  // ── New badges earned ─────────────────────────────────────────────────
  for (const entry of leaders) {
    const prevCount = previousBadgeCounts.get(entry.agentId) ?? 0;
    const currentCount = entry.badges.length;
    if (currentCount > prevCount && prevCount > 0) {
      const userId = findUserId(entry.agentId, agents);
      if (userId) {
        const newBadges = entry.badges.slice(prevCount);
        const badgeNames = newBadges.map((b) => `${b.emoji} ${b.name}`).join(", ");
        emitNotification(userId, {
          id: `arena-badge-${entry.agentId}-${now}`,
          level: "success",
          title: "New Badge Earned!",
          message: `${entry.name} earned: ${badgeNames}`,
          category: "arena_badge",
          timestamp: now,
        });
      }
    }
    previousBadgeCounts.set(entry.agentId, currentCount);
  }

  // ── Trade milestones ──────────────────────────────────────────────────
  for (const entry of leaders) {
    const prevTrades = previousTradeCounts.get(entry.agentId) ?? 0;
    const currentTrades = entry.totalTrades;

    for (const milestone of TRADE_MILESTONES) {
      if (currentTrades >= milestone && prevTrades < milestone) {
        const userId = findUserId(entry.agentId, agents);
        if (userId) {
          emitNotification(userId, {
            id: `arena-milestone-${entry.agentId}-${milestone}-${now}`,
            level: "info",
            title: `${milestone} Trades Milestone!`,
            message: `${entry.avatarEmoji} ${entry.name} completed ${milestone} trades in the arena.`,
            category: "arena_milestone",
            timestamp: now,
          });
        }
        break; // Only emit the highest milestone crossed this cycle
      }
    }
    previousTradeCounts.set(entry.agentId, currentTrades);
  }
}

/** Reset cached state (useful for tests). */
export function resetArenaNotificationState(): void {
  previousBadgeCounts = new Map();
  previousTradeCounts = new Map();
  previousCrown = new Map();
}
