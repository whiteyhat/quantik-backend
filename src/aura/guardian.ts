// src/aura/guardian.ts
// The Guardian Open Platform API client

export interface GuardianArticle {
  title: string;
  snippet: string;
  publishedAt: string;
  source: string;
  url: string;
}

const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY || "";

export async function fetchGuardian(
  query: string,
  options: { maxResults?: number; daysBack?: number } = {}
): Promise<GuardianArticle[]> {
  if (!GUARDIAN_API_KEY) return [];

  const { maxResults = 10, daysBack = 7 } = options;
  const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const url =
    `https://content.guardianapis.com/search?q=${encodeURIComponent(query)}` +
    `&show-fields=trailText&page-size=${maxResults}&from-date=${fromDate}` +
    `&order-by=relevance&api-key=${GUARDIAN_API_KEY}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!res.ok) {
      console.warn(`[Guardian] HTTP ${res.status} for query: "${query}"`);
      return [];
    }

    const data = await res.json() as {
      response?: {
        results?: {
          webTitle?: string;
          webPublicationDate?: string;
          webUrl?: string;
          fields?: { trailText?: string };
        }[];
      };
    };

    return (data.response?.results || []).map((r) => ({
      title: r.webTitle || "",
      snippet: r.fields?.trailText?.replace(/<[^>]+>/g, "") || "",
      publishedAt: r.webPublicationDate || "",
      source: "The Guardian",
      url: r.webUrl || "",
    })).filter((a) => a.title.length > 0);
  } catch (err) {
    console.warn(`[Guardian] Fetch failed for "${query}": ${(err as Error).message}`);
    return [];
  }
}
