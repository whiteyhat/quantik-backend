export interface ArbOpportunity {
  type: "CROSS_PLATFORM_BINARY" | "COMBINATORIAL" | "TEMPORAL";
  description: string;
  profit_pct: number;
  executable: boolean;
}

export function detectArbitrage(marketSlug: string, oracleResult: any): ArbOpportunity[] {
  const ops: ArbOpportunity[] = [];
  const isExecutable = !!process.env.POLYMARKET_PRIVATE_KEY;

  if (oracleResult?.arb_detected) {
    ops.push({
      type: "COMBINATORIAL",
      description: "Oracle combinatorial signal detected",
      profit_pct: 0.05,
      executable: isExecutable,
    });
  }

  // Placeholder for cross-platform binary and temporal arbs based on real data
  if (oracleResult?.cross_market_divergence) {
    ops.push({
      type: "CROSS_PLATFORM_BINARY",
      description: "Divergence between markets detected",
      profit_pct: 0.03,
      executable: isExecutable,
    });
  }

  return ops;
}
