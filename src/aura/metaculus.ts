// src/aura/metaculus.ts
// Metaculus crowd-wisdom sentiment — prediction trend signals for Aura
// (Oracle uses raw probability; Aura uses crowd consensus direction)

import { fetchWithRetry } from "./fetchWithRetry";

export interface MetaculusSentiment {
  questionId: number;
  title: string;
  communityPrediction: number; // q2 (median)
  spreadQ1: number;
  spreadQ3: number;
  numPredictions: number;
}

const METACULUS_API_KEY = process.env.METACULUS_API_KEY || "";
const BASE_URL = "https://www.metaculus.com/api2/questions/";

// 15-min cache keyed on query
const cache = new Map<string, { data: MetaculusSentiment[]; ts: number }>();
const CACHE_TTL = 15 * 60 * 1000;

export async function fetchMetaculusSentiment(
  query: string
): Promise<MetaculusSentiment[]> {
  if (!METACULUS_API_KEY) return [];

  const cacheKey = query.toLowerCase().trim();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const qEnc = encodeURIComponent(query.slice(0, 80));
  const url = `${BASE_URL}?search=${qEnc}&status=open&limit=5`;

  try {
    const res = await fetchWithRetry(url, {
      headers: {
        Authorization: `Token ${METACULUS_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.warn(`[Metaculus] HTTP ${res.status} for query: "${query}"`);
      return [];
    }

    const data = (await res.json()) as {
      results?: {
        id: number;
        title: string;
        number_of_predictions?: number;
        community_prediction?: { full?: { q1?: number; q2?: number; q3?: number } };
        metaculus_prediction?: { full?: { q1?: number; q2?: number; q3?: number } };
      }[];
    };

    const results: MetaculusSentiment[] = [];

    for (const q of data.results ?? []) {
      const cp = q.community_prediction?.full ?? q.metaculus_prediction?.full;
      if (!cp || typeof cp.q2 !== "number") continue;

      results.push({
        questionId: q.id,
        title: q.title,
        communityPrediction: cp.q2,
        spreadQ1: cp.q1 ?? cp.q2,
        spreadQ3: cp.q3 ?? cp.q2,
        numPredictions: q.number_of_predictions ?? 0,
      });
    }

    if (results.length > 0) {
      cache.set(cacheKey, { data: results, ts: Date.now() });
    }

    return results;
  } catch (err) {
    console.warn(`[Metaculus] Fetch failed for "${query}": ${(err as Error).message}`);
    return [];
  }
}

export function scoreMetaculusCrowdTrend(
  data: MetaculusSentiment[]
): { score: number; resultCount: number } {
  if (data.length === 0) return { score: 0, resultCount: 0 };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const q of data) {
    const spread = q.spreadQ3 - q.spreadQ1;
    const predWeight = Math.min(1 + q.numPredictions / 100, 3);

    let signal = 0;

    if (spread < 0.15 && q.communityPrediction > 0.6) {
      // Narrow spread + high median = strong bullish consensus
      signal = 0.3;
    } else if (spread < 0.15 && q.communityPrediction < 0.4) {
      // Narrow spread + low median = strong bearish consensus
      signal = -0.3;
    } else if (q.communityPrediction > 0.6) {
      // High median, wider spread = moderate bullish
      signal = 0.2;
    } else if (q.communityPrediction < 0.4) {
      // Low median = moderate bearish
      signal = -0.2;
    } else if (spread > 0.4) {
      // Wide spread = high uncertainty = slight bearish
      signal = -0.1;
    }

    weightedSum += signal * predWeight;
    totalWeight += predWeight;
  }

  if (totalWeight === 0) return { score: 0, resultCount: data.length };

  const score = Math.max(-1, Math.min(1, weightedSum / totalWeight));
  return { score, resultCount: data.length };
}
