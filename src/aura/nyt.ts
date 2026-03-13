// src/aura/nyt.ts
// NYT Article Search API client

import { fetchWithRetry } from "./fetchWithRetry";

export interface NYTArticle {
  title: string;
  snippet: string;
  publishedAt: string;
  source: string;
  url: string;
}

const NYT_API_KEY = process.env.NYT_API_KEY || "";

export async function fetchNYT(
  query: string,
  options: { maxResults?: number; daysBack?: number } = {}
): Promise<NYTArticle[]> {
  if (!NYT_API_KEY) return [];

  const { maxResults = 10, daysBack = 7 } = options;
  const beginDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]
    .replace(/-/g, "");

  const url =
    `https://api.nytimes.com/svc/search/v2/articlesearch.json?q=${encodeURIComponent(query)}` +
    `&begin_date=${beginDate}&sort=relevance&fl=headline,snippet,pub_date,web_url` +
    `&api-key=${NYT_API_KEY}`;

  try {
    const res = await fetchWithRetry(url);

    if (!res.ok) {
      console.warn(`[NYT] HTTP ${res.status} for query: "${query}"`);
      return [];
    }

    const data = await res.json() as {
      response?: {
        docs?: {
          headline?: { main?: string };
          snippet?: string;
          pub_date?: string;
          web_url?: string;
        }[];
      };
    };

    return (data.response?.docs || [])
      .slice(0, maxResults)
      .map((d) => ({
        title: d.headline?.main || "",
        snippet: d.snippet || "",
        publishedAt: d.pub_date || "",
        source: "The New York Times",
        url: d.web_url || "",
      }))
      .filter((a) => a.title.length > 0);
  } catch (err) {
    console.warn(`[NYT] Fetch failed for "${query}": ${(err as Error).message}`);
    return [];
  }
}
