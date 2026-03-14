import { fetchWithRetry } from "./fetchWithRetry";

export interface CoinDeskArticle {
  title: string;
  description: string;
  publishedAt: string;
  source: string;
  url: string;
}

const COINDESK_API_KEY = process.env.COINDESK_API_KEY || "";
const COINDESK_API_URL = "https://data-api.coindesk.com/news/v1/search";

export async function fetchCoinDesk(
  query: string,
  options: { maxResults?: number; language?: "EN" | "ES" | "TR" | "FR" | "JP" | "PT"; toTs?: number } = {}
): Promise<CoinDeskArticle[]> {
  if (!COINDESK_API_KEY) return [];

  const {
    maxResults = 10,
    language = "EN",
    toTs = Math.floor(Date.now() / 1000),
  } = options;

  const params = new URLSearchParams({
    api_key: COINDESK_API_KEY,
    source_key: "coindesk",
    search_string: query,
    limit: String(maxResults),
    lang: language,
    to_ts: String(toTs),
  });

  try {
    const res = await fetchWithRetry(`${COINDESK_API_URL}?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      console.warn(`[CoinDesk] HTTP ${res.status} for query: "${query}"`);
      return [];
    }

    const data = await res.json() as {
      Data?: {
        TITLE?: string;
        BODY?: string;
        SUBTITLE?: string;
        URL?: string;
        PUBLISHED_ON?: number;
        SOURCE_DATA?: { NAME?: string };
      }[];
    };

    return (data.Data || [])
      .slice(0, maxResults)
      .map((article) => ({
        title: article.TITLE || "",
        description: article.BODY || article.SUBTITLE || "",
        publishedAt: article.PUBLISHED_ON
          ? new Date(article.PUBLISHED_ON * 1000).toISOString()
          : "",
        source: article.SOURCE_DATA?.NAME || "CoinDesk",
        url: article.URL || "",
      }))
      .filter((article) => article.title.length > 0);
  } catch (err) {
    console.warn(`[CoinDesk] Fetch failed for "${query}": ${(err as Error).message}`);
    return [];
  }
}
