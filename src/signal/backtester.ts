// ── Historical Analogue Lookup ───────────────────────────────────

import { getDb } from "../db/schema";

export interface AnalogueResult {
  hit_rate: number;
  sample_size: number;
  confidence: number;
}

/**
 * Find past pipeline runs with similar keywords in the question.
 * Returns hit rate (fraction that resolved to TRADE/BUY_YES/BUY_NO)
 * and a confidence score scaled by sample size.
 */
export function findAnalogues(
  question: string,
  marketPrice?: number
): AnalogueResult {
  const db = getDb();

  // Extract meaningful keywords (3+ chars, skip stop words)
  const stopWords = new Set([
    "the", "will", "and", "for", "this", "that", "with", "from",
    "have", "been", "what", "when", "where", "who", "how", "are",
    "was", "were", "has", "not", "but", "they", "than",
  ]);
  const keywords = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  if (keywords.length === 0) {
    return { hit_rate: 0.5, sample_size: 0, confidence: 0.3 };
  }

  // Build LIKE clauses for keyword matching
  const conditions = keywords.map(
    (_, i) => `LOWER(market_question) LIKE @kw${i}`
  );
  const params: Record<string, string> = {};
  for (let i = 0; i < keywords.length; i++) {
    params[`kw${i}`] = `%${keywords[i]}%`;
  }

  // Find runs where at least one keyword matches
  const sql = `
    SELECT decision, confidence FROM pipeline_runs
    WHERE completed_at IS NOT NULL
      AND (${conditions.join(" OR ")})
    ORDER BY created_at DESC
    LIMIT 100
  `;

  const rows = db.prepare(sql).all(params) as Array<{
    decision: string | null;
    confidence: number | null;
  }>;

  const sampleSize = rows.length;

  if (sampleSize === 0) {
    return { hit_rate: 0.5, sample_size: 0, confidence: 0.3 };
  }

  // Count "actionable" decisions (BUY_YES, BUY_NO, TRADE) vs passive (HOLD, SKIP, WATCH)
  const actionable = rows.filter(
    (r) =>
      r.decision === "BUY_YES" ||
      r.decision === "BUY_NO" ||
      r.decision === "TRADE"
  ).length;

  let hitRate = actionable / sampleSize;

  // Longshot bias: if market price < 0.15, apply -0.05 adjustment
  if (marketPrice !== undefined && marketPrice < 0.15) {
    hitRate = Math.max(0, hitRate - 0.05);
  }

  // Confidence scales with sample size
  let confidence: number;
  if (sampleSize < 10) {
    confidence = 0.3;
  } else if (sampleSize < 30) {
    confidence = 0.5;
  } else if (sampleSize < 50) {
    confidence = 0.7;
  } else {
    confidence = 0.85;
  }

  return {
    hit_rate: Math.round(hitRate * 1000) / 1000,
    sample_size: sampleSize,
    confidence,
  };
}
