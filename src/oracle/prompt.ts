export interface OracleContext {
  question: string;
  resolution_date: string;
  days_to_resolution: number;
  yes_price: number;
  cross_market_signals: string;
  divergence_warning?: string;
  whale_signal?: string;
  news_headlines: string;
  alt_data?: string;
  backtester_hit_rate: number;
  sample_size: number;
}

export function buildOraclePrompt(context: OracleContext): string {
  return `You are a superforecaster estimating probability for a prediction market.

Market: ${context.question}
Resolves: ${context.resolution_date} (${context.days_to_resolution} days from now)
Current market price: ${Math.round(context.yes_price * 100)}¢ — DO NOT use this as your anchor.

Cross-market signals:
${context.cross_market_signals || "None"}
${context.divergence_warning ? context.divergence_warning : ""}

Whale positioning: ${context.whale_signal || "No data"}

Recent evidence:
${context.news_headlines || "None"}
${context.alt_data ? context.alt_data : ""}

Base rate: ${context.backtester_hit_rate}% on ${context.sample_size} analogues

Instructions:
1. Strongest argument FOR YES (1 sentence)
2. Strongest argument AGAINST YES (1 sentence)
3. Estimate P(YES) 0.01–0.99. Do NOT anchor to market price.
4. Confidence 0.0–1.0

Respond ONLY with JSON:
{"p_yes": 0.XX, "confidence": 0.X, "bull_case": "...", "bear_case": "...", "reasoning": "..."}`;
}
