import type { ArenaExecutionRecord } from "./arena";

// ── Heat Score ───────────────────────────────────────────────────────────────
// Returns a 0-1 "heat" value representing an agent's current momentum.
// Drives visual intensity (glow color, pulse speed, particle density) on the frontend.
//
// Formula:
//   heat = frequency * 0.4 + streakIntensity * 0.35 + pnlAcceleration * 0.25
//
// Where:
//   frequency:        trades in last 6h / 10, capped at 1.0
//   streakIntensity:  |streak| / 10, capped at 1.0
//   pnlAcceleration:  (recent 3h PnL - previous 3h PnL) / 50, capped at 1.0

export function computeAgentHeat(
  executions: ArenaExecutionRecord[],
  streak: number,
  now: number,
): number {
  const sixHoursAgo = now - 6 * 60 * 60 * 1000;
  const threeHoursAgo = now - 3 * 60 * 60 * 1000;

  // Trade frequency in last 6 hours
  const recentTrades = executions.filter((e) => e.executed_at >= sixHoursAgo).length;
  const frequency = Math.min(1, recentTrades / 10);

  // Streak intensity
  const streakIntensity = Math.min(1, Math.abs(streak) / 10);

  // PnL acceleration: recent 3h vs previous 3h
  let recentPnl = 0;
  let prevPnl = 0;
  for (const e of executions) {
    if (e.pnl == null) continue;
    if (e.executed_at >= threeHoursAgo) {
      recentPnl += e.pnl;
    } else if (e.executed_at >= sixHoursAgo) {
      prevPnl += e.pnl;
    }
  }
  const acceleration = recentPnl > prevPnl
    ? Math.min(1, (recentPnl - prevPnl) / 50)
    : 0;

  // Weighted combination
  const heat = frequency * 0.4 + streakIntensity * 0.35 + acceleration * 0.25;
  return Math.min(1, Math.round(heat * 100) / 100); // Round to 2 decimals
}
