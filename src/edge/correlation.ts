import { getDb } from "../db/schema";

export interface CorrelationPenaltyResult {
  correlation_penalty: number;
  corr_blocked: boolean;
  adjusted_position: number;
}

export async function computeCorrelationPenalty(
  marketSlug: string,
  proposedPositionSize: number,
  fractionalKelly: number
): Promise<CorrelationPenaltyResult> {
  const isMock = process.env.EDGE_MOCK === "true";
  let maxSim = 0;

  try {
    const db = getDb();
    // Query last 3 open positions from portfolio, check slug similarity
    const recentPositions = db.prepare(`
      SELECT slug as market_slug
      FROM executions
      WHERE (status = 'placed' OR status = 'paper') AND pnl IS NULL
      ORDER BY executed_at DESC
      LIMIT 3
    `).all() as any[];

    for (const pos of recentPositions) {
      // Mocking ChromaDB cosine similarity using basic string similarity
      const sim = isMock ? mockSimilarity(marketSlug, pos.market_slug) : 0; // Replace with actual Chroma call later
      if (sim > maxSim) maxSim = sim;
    }
  } catch (err) {
    console.error("Failed to query portfolio positions for correlation:", err);
  }

  // If sim > 0.7 → kelly × (1 - (sim-0.5)×1.0)
  let correlation_penalty = 0;
  let adjusted_position = proposedPositionSize;
  let corr_blocked = false;

  if (maxSim > 0.7) {
    const penaltyFactor = 1 - (maxSim - 0.5) * 1.0;
    correlation_penalty = 1 - penaltyFactor; // the percentage lost
    
    adjusted_position = proposedPositionSize * penaltyFactor;
    
    if (adjusted_position < 5) {
      corr_blocked = true;
    }
  }

  return {
    correlation_penalty,
    corr_blocked,
    adjusted_position,
  };
}

function mockSimilarity(slugA: string, slugB: string): number {
  if (!slugA || !slugB) return 0;
  if (slugA === slugB) return 1.0;
  
  // simple mock
  const a = slugA.split("-");
  const b = slugB.split("-");
  let matches = 0;
  for (const word of a) {
    if (b.includes(word)) matches++;
  }
  return matches / Math.max(a.length, b.length);
}
