// src/aura/fred.ts
// FRED (Federal Reserve Economic Data) — macro-economic sentiment signals

import { fetchWithRetry } from "./fetchWithRetry";

export interface FredObservation {
  seriesId: string;
  date: string;
  value: number;
  previousValue: number;
}

const FRED_API_KEY = process.env.FRED_API_KEY || "";
const BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

// Key macro series for prediction-market sentiment
const SERIES = [
  "UNRATE",   // Unemployment rate
  "CPIAUCSL", // CPI — inflation gauge
  "FEDFUNDS", // Federal funds rate
  "T10Y2Y",   // 10y-2y treasury spread — recession indicator
] as const;

// 30-min cache (macro data updates monthly/quarterly)
let cache: { data: FredObservation[]; ts: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000;

async function fetchSeries(seriesId: string): Promise<FredObservation | null> {
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const url =
    `${BASE_URL}?series_id=${seriesId}&api_key=${FRED_API_KEY}` +
    `&file_type=json&sort_order=desc&limit=2&observation_start=${startDate}`;

  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      console.warn(`[FRED] HTTP ${res.status} for series ${seriesId}`);
      return null;
    }

    const data = (await res.json()) as {
      observations?: { date: string; value: string }[];
    };

    const obs = data.observations?.filter((o) => o.value !== ".");
    if (!obs || obs.length < 2) return null;

    return {
      seriesId,
      date: obs[0].date,
      value: parseFloat(obs[0].value),
      previousValue: parseFloat(obs[1].value),
    };
  } catch (err) {
    console.warn(`[FRED] Fetch failed for ${seriesId}: ${(err as Error).message}`);
    return null;
  }
}

export async function fetchFred(): Promise<FredObservation[]> {
  if (!FRED_API_KEY) return [];

  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  const results = await Promise.allSettled(SERIES.map((s) => fetchSeries(s)));

  const observations: FredObservation[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) observations.push(r.value);
  }

  if (observations.length > 0) {
    cache = { data: observations, ts: Date.now() };
  }

  return observations;
}

export function scoreFredMacro(obs: FredObservation[]): { score: number; resultCount: number } {
  if (obs.length === 0) return { score: 0, resultCount: 0 };

  let total = 0;

  for (const o of obs) {
    const delta = o.value - o.previousValue;
    if (Math.abs(delta) < 0.001) continue; // unchanged

    switch (o.seriesId) {
      case "UNRATE":
        // Falling unemployment = bullish
        total += delta < 0 ? 0.5 : -0.5;
        break;
      case "CPIAUCSL":
        // Falling/stable CPI = bullish (lower inflation)
        total += delta < 0 ? 0.5 : -0.5;
        break;
      case "FEDFUNDS":
        // Rate cuts = bullish
        total += delta < 0 ? 0.5 : -0.5;
        break;
      case "T10Y2Y":
        // Positive/rising spread = normal curve = bullish; inversion = bearish
        total += delta > 0 ? 0.5 : -0.5;
        break;
    }
  }

  const score = Math.max(-1, Math.min(1, total / obs.length));
  return { score, resultCount: obs.length };
}
