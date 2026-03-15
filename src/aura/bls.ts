// src/aura/bls.ts
// BLS (Bureau of Labor Statistics) — labor/economic sentiment signals

export interface BlsDataPoint {
  seriesId: string;
  year: string;
  period: string;
  value: number;
  previousValue: number;
}

const BLS_API_KEY = process.env.BLS_API_KEY || "";
const BLS_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";

// Key labor series
const SERIES_IDS = [
  "CES0000000001", // Total nonfarm employment
  "CUUR0000SA0",   // CPI-U — all urban consumers
  "LNS14000000",   // Unemployment rate
];

// 30-min cache (BLS data updates monthly)
let cache: { data: BlsDataPoint[]; ts: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000;

export async function fetchBls(): Promise<BlsDataPoint[]> {
  if (!BLS_API_KEY) return [];

  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  const currentYear = new Date().getFullYear();

  try {
    // BLS requires POST with JSON body — can't use fetchWithRetry (GET-only)
    const res = await fetch(BLS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seriesid: SERIES_IDS,
        startyear: String(currentYear - 1),
        endyear: String(currentYear),
        registrationkey: BLS_API_KEY,
        latest: true,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[BLS] HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as {
      status: string;
      Results?: {
        series?: {
          seriesID: string;
          data?: { year: string; period: string; value: string }[];
        }[];
      };
    };

    if (data.status !== "REQUEST_SUCCEEDED" || !data.Results?.series) {
      console.warn(`[BLS] Request status: ${data.status}`);
      return [];
    }

    const points: BlsDataPoint[] = [];

    for (const series of data.Results.series) {
      const entries = series.data;
      if (!entries || entries.length < 2) continue;

      // BLS returns most recent first
      points.push({
        seriesId: series.seriesID,
        year: entries[0].year,
        period: entries[0].period,
        value: parseFloat(entries[0].value),
        previousValue: parseFloat(entries[1].value),
      });
    }

    if (points.length > 0) {
      cache = { data: points, ts: Date.now() };
    }

    return points;
  } catch (err) {
    console.warn(`[BLS] Fetch failed: ${(err as Error).message}`);
    return [];
  }
}

export function scoreBlsMacro(data: BlsDataPoint[]): { score: number; resultCount: number } {
  if (data.length === 0) return { score: 0, resultCount: 0 };

  let total = 0;

  for (const d of data) {
    const delta = d.value - d.previousValue;
    if (Math.abs(delta) < 0.001) continue;

    switch (d.seriesId) {
      case "CES0000000001":
        // Job growth = bullish
        total += delta > 0 ? 0.5 : -0.5;
        break;
      case "CUUR0000SA0":
        // Falling CPI = bullish (lower inflation)
        total += delta < 0 ? 0.5 : -0.5;
        break;
      case "LNS14000000":
        // Falling unemployment = bullish
        total += delta < 0 ? 0.5 : -0.5;
        break;
    }
  }

  const score = Math.max(-1, Math.min(1, total / data.length));
  return { score, resultCount: data.length };
}
