// Shared utility for agent re-run endpoints

export interface MarketData {
  slug: string;
  question: string;
  description: string;
  yes_price: number;
  resolution_date: string;
  days_to_resolution: number;
  token_id?: string;
  category?: string;
}

export async function fetchMarketBySlug(slug: string): Promise<MarketData> {
  const res = await fetch(
    `https://gamma-api.polymarket.com/markets?slug=${slug}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const raw: unknown = await res.json();
  const m: any = Array.isArray(raw) && raw.length > 0 ? raw[0] : raw;

  let yes_price = 0.5;
  if (m.outcomePrices) {
    try {
      const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      if (Array.isArray(prices) && prices.length > 0) yes_price = Number(prices[0]) || 0.5;
    } catch { /* ignore */ }
  }

  const resolution_date = m.endDate || m.endDateIso || new Date(Date.now() + 30 * 86400000).toISOString();
  const days_to_resolution = Math.max(1, Math.round((new Date(resolution_date).getTime() - Date.now()) / 86400000));

  let token_id: string | undefined;
  if (m.clobTokenIds) {
    try {
      const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      if (Array.isArray(ids) && ids.length > 0) token_id = String(ids[0]);
    } catch { /* ignore */ }
  } else if (Array.isArray(m.tokens) && m.tokens.length > 0) {
    token_id = m.tokens[0].token_id;
  }

  return {
    slug: m.slug || slug,
    question: m.question || slug,
    description: m.description || "",
    yes_price,
    resolution_date,
    days_to_resolution,
    token_id,
    category: m.category,
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Agent timeout")), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
