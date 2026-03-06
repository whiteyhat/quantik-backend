// src/aura/hackernews.ts
// Algolia HN API client — searches Hacker News stories for sentiment signal

export interface HNStory {
  title: string;
  points: number;
  numComments: number;
  createdAt: number; // unix timestamp
}

const HN_ALGOLIA_KEY = process.env.ALGOLIA_HN_API_KEY || "";
const HN_APP_ID = "UJ5WYC0L7X"; // public Algolia HN app ID

export async function fetchHackerNews(
  query: string,
  options: { maxResults?: number; daysBack?: number } = {}
): Promise<HNStory[]> {
  const { maxResults = 15, daysBack = 7 } = options;

  const since = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
  const url =
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}` +
    `&tags=story&hitsPerPage=${maxResults}&numericFilters=created_at_i>${since}`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (HN_ALGOLIA_KEY) {
      headers["X-Algolia-Application-Id"] = HN_APP_ID;
      headers["X-Algolia-API-Key"] = HN_ALGOLIA_KEY;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[HN] HTTP ${res.status} for query: "${query}"`);
      return [];
    }

    const data = await res.json() as {
      hits?: { title?: string; points?: number; num_comments?: number; created_at_i?: number }[];
    };

    return (data.hits || []).map((h) => ({
      title: h.title || "",
      points: h.points || 0,
      numComments: h.num_comments || 0,
      createdAt: h.created_at_i || 0,
    })).filter((h) => h.title.length > 0);
  } catch (err) {
    console.warn(`[HN] Fetch failed for "${query}": ${(err as Error).message}`);
    return [];
  }
}

const POSITIVE_KEYWORDS = ["win","wins","won","leads","ahead","victory","confirmed","passes","approved",
  "elected","surges","rises","gains","advances","succeeds","launches","signs","agrees","breakthrough",
  "bullish","rally","recovers","climbs","soars"];

const NEGATIVE_KEYWORDS = ["loses","lost","defeated","drops","falls","fails","rejected","vetoed",
  "cancelled","delayed","reversed","denied","blocked","crashed","collapse","retreat","bearish",
  "dump","plunges","selloff","crisis","fraud","hack","ban","crackdown"];

export function scoreHNSentiment(stories: HNStory[]): { score: number; resultCount: number } {
  if (stories.length === 0) return { score: 0, resultCount: 0 };

  let pos = 0, neg = 0;
  for (const s of stories) {
    const text = s.title.toLowerCase();
    // Weight by engagement (points + comments, capped at 100)
    const weight = Math.min(1 + (s.points + s.numComments) / 100, 3);
    if (POSITIVE_KEYWORDS.some((k) => text.includes(k))) pos += weight;
    if (NEGATIVE_KEYWORDS.some((k) => text.includes(k))) neg += weight;
  }

  const total = pos + neg || 1;
  const score = (pos - neg) / (stories.length * 2);
  return { score: Math.max(-1, Math.min(1, score)), resultCount: stories.length };
}
