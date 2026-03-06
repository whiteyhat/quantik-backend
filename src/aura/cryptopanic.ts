// src/aura/cryptopanic.ts
// CryptoPanic API client — aggregated crypto news with vote-based sentiment

export interface CryptoPanicPost {
  title: string;
  publishedAt: string;
  url: string;
  sentiment: number;   // -1..1 derived from votes
  votes: { positive: number; negative: number; important: number };
  currencies: string[];
}

const CRYPTOPANIC_API_KEY = process.env.CRYPTOPANIC_API_KEY || "";

export async function fetchCryptoPanic(
  options: { filter?: "rising" | "hot" | "bullish" | "bearish" | "important" | "saved" | "lol"; currencies?: string; maxResults?: number } = {}
): Promise<CryptoPanicPost[]> {
  if (!CRYPTOPANIC_API_KEY) return [];

  const { filter = "important", currencies, maxResults = 20 } = options;

  let url =
    `https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_API_KEY}` +
    `&filter=${filter}&kind=news&public=true`;
  if (currencies) url += `&currencies=${encodeURIComponent(currencies)}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!res.ok) {
      console.warn(`[CryptoPanic] HTTP ${res.status}`);
      return [];
    }

    const data = await res.json() as {
      results?: {
        title?: string;
        published_at?: string;
        url?: string;
        votes?: { positive?: number; negative?: number; important?: number };
        currencies?: { code?: string }[];
      }[];
    };

    return (data.results || [])
      .slice(0, maxResults)
      .map((p) => {
        const pos = p.votes?.positive || 0;
        const neg = p.votes?.negative || 0;
        const total = pos + neg || 1;
        return {
          title: p.title || "",
          publishedAt: p.published_at || "",
          url: p.url || "",
          sentiment: (pos - neg) / total,
          votes: { positive: pos, negative: neg, important: p.votes?.important || 0 },
          currencies: (p.currencies || []).map((c) => c.code || "").filter(Boolean),
        };
      })
      .filter((p) => p.title.length > 0);
  } catch (err) {
    console.warn(`[CryptoPanic] Fetch failed: ${(err as Error).message}`);
    return [];
  }
}

export function scoreCryptoPanic(posts: CryptoPanicPost[]): { score: number; resultCount: number } {
  if (posts.length === 0) return { score: 0, resultCount: 0 };
  // Weight by importance votes
  let weightedSum = 0;
  let totalWeight = 0;
  for (const p of posts) {
    const weight = 1 + p.votes.important * 0.5;
    weightedSum += p.sentiment * weight;
    totalWeight += weight;
  }
  return {
    score: Math.max(-1, Math.min(1, weightedSum / totalWeight)),
    resultCount: posts.length,
  };
}
