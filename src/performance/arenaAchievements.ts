import type { ArenaExecutionRecord } from "./arena";

// ── Types ────────────────────────────────────────────────────────────────────

export type BadgeTier = "common" | "rare" | "epic" | "legendary";

export interface ArenaBadge {
  id: string;
  name: string;
  description: string;
  tier: BadgeTier;
  emoji: string;
}

// ── Badge Definitions ────────────────────────────────────────────────────────

const BADGE_DEFS: Record<string, Omit<ArenaBadge, "id"> & { id: string }> = {
  first_blood:   { id: "first_blood",   name: "First Blood",   tier: "common",    emoji: "🩸", description: "Completed first trade" },
  market_maker:  { id: "market_maker",  name: "Market Maker",  tier: "rare",      emoji: "🏭", description: "50+ trades executed" },
  diversified:   { id: "diversified",   name: "Diversified",   tier: "rare",      emoji: "🌐", description: "Traded 5+ markets" },
  night_owl:     { id: "night_owl",     name: "Night Owl",     tier: "common",    emoji: "🦉", description: "Traded at midnight UTC" },
  speed_demon:   { id: "speed_demon",   name: "Speed Demon",   tier: "epic",      emoji: "⚡", description: "Trade closed under 1 hour" },
  streak_master: { id: "streak_master", name: "Streak Master", tier: "epic",      emoji: "🔥", description: "10+ win streak" },
  diamond_hands: { id: "diamond_hands", name: "Diamond Hands", tier: "legendary", emoji: "💎", description: "Highest single-trade PnL" },
};

// ── Computation ──────────────────────────────────────────────────────────────

export function computeAgentBadges(
  executions: ArenaExecutionRecord[],
  currentStreak: number,
  bestTradePnl: number,
  globalHighestPnl: number,
): ArenaBadge[] {
  const badges: ArenaBadge[] = [];

  // First Blood: at least 1 trade
  if (executions.length >= 1) {
    badges.push(BADGE_DEFS.first_blood);
  }

  // Market Maker: 50+ trades
  if (executions.length >= 50) {
    badges.push(BADGE_DEFS.market_maker);
  }

  // Diversified: 5+ unique market slugs
  const uniqueSlugs = new Set(executions.map((e) => e.slug));
  if (uniqueSlugs.size >= 5) {
    badges.push(BADGE_DEFS.diversified);
  }

  // Night Owl: any trade executed at midnight UTC hour (00:xx)
  const hasNightTrade = executions.some((e) => {
    const hour = new Date(e.executed_at).getUTCHours();
    return hour === 0;
  });
  if (hasNightTrade) {
    badges.push(BADGE_DEFS.night_owl);
  }

  // Speed Demon: any trade with closed_at - executed_at < 1 hour
  const hasSpeedTrade = executions.some((e) => {
    if (!e.closed_at) return false;
    return e.closed_at - e.executed_at < 3_600_000;
  });
  if (hasSpeedTrade) {
    badges.push(BADGE_DEFS.speed_demon);
  }

  // Streak Master: |currentStreak| >= 10
  if (Math.abs(currentStreak) >= 10) {
    badges.push(BADGE_DEFS.streak_master);
  }

  // Diamond Hands: agent holds the global highest single-trade PnL
  if (globalHighestPnl > 0 && bestTradePnl >= globalHighestPnl) {
    badges.push(BADGE_DEFS.diamond_hands);
  }

  return badges;
}
