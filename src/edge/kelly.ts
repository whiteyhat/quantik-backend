export function kellyMultiplier(brierScore: number, resolvedTrades: number): number {
  if (resolvedTrades < 20) return 0.25; // Phase 0 lock
  const continuous = 0.25 + (0.25 - brierScore) * 2;
  const phased = resolvedTrades < 50 ? 0.35 : resolvedTrades < 100 ? 0.45 : 0.50;
  return Math.min(Math.max(Math.min(continuous, 0.50), 0.25), phased);
}
