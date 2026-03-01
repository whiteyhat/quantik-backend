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
    const port = process.env.PORT || 3001;
    const url = `http://localhost:${port}/api/portfolio/positions`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json() as any;
      const positions = data.positions || [];

      // Take up to 3 most recent open positions based on instructions
      // Instruction says: "Query last 3 open positions from portfolio, check slug similarity"
      const recentPositions = positions.slice(0, 3);

      for (const pos of recentPositions) {
        // Mocking ChromaDB cosine similarity using basic string similarity
        const sim = isMock ? mockSimilarity(marketSlug, pos.market_slug) : 0; // Replace with actual Chroma call later
        if (sim > maxSim) maxSim = sim;
      }
    }
  } catch (err) {
    console.error("Failed to fetch portfolio positions for correlation:", err);
  }

  // If sim > 0.7 → kelly × (1 - (sim-0.5)×1.0)
  let correlation_penalty = 0;
  let adjusted_position = proposedPositionSize;
  let corr_blocked = false;

  if (maxSim > 0.7) {
    const penaltyFactor = 1 - (maxSim - 0.5) * 1.0;
    correlation_penalty = 1 - penaltyFactor; // the percentage lost
    const adjustedKelly = fractionalKelly * penaltyFactor;

    // Recalculate position based on adjusted kelly (assuming portfolio size is approx proposedPositionSize / fractionalKelly)
    // Actually the instruction says:
    // If adjusted_position < $5 → corr_blocked: true
    // Since we don't have portfolio size here, we just apply the penalty factor directly to the position size
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
