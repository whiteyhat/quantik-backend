// Shared utility for agent re-run endpoints

export const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

/** Transient error codes that warrant a retry */
const RETRYABLE_CODES = new Set(["ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);

function isTransientError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const cause = (err as any).cause;
    if (cause && typeof cause === "object" && RETRYABLE_CODES.has((cause as any).code)) return true;
    if (RETRYABLE_CODES.has((err as any).code)) return true;
  }
  return false;
}

/**
 * Fetch with automatic retry on transient network errors (DNS failures, timeouts, resets).
 * Uses exponential backoff: 1s, 2s, 4s by default.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isTransientError(err)) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export interface MarketData {
  slug: string;
  question: string;
  description: string;
  yes_price: number;
  no_price: number;
  resolution_date: string;
  days_to_resolution: number;
  token_id?: string;
  yes_token_id?: string;
  no_token_id?: string;
  category?: string;
  /** The parent event slug used in Polymarket frontend URLs */
  event_slug?: string;
  /** The condition ID on the CLOB */
  condition_id?: string;
  protocol?: string;
  liquidity?: number;
  volume?: number;
  liquidityGrade?: "A" | "B" | "C" | "D";
}

export function parseClobTokenIds(raw: unknown): { noTokenId: string | null; yesTokenId: string | null } {
  let arr: string[] = [];
  if (Array.isArray(raw)) {
    arr = raw.map(String);
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed.map(String);
    } catch {
      // Ignore malformed historical rows.
    }
  }

  return {
    noTokenId: arr[0] ?? null,
    yesTokenId: arr[1] ?? null,
  };
}

export async function fetchMarketBySlug(slug: string): Promise<MarketData> {
  const res = await fetchWithRetry(
    `${GAMMA_API_BASE}/markets?slug=${slug}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const raw: unknown = await res.json();
  const m: any = Array.isArray(raw) && raw.length > 0 ? raw[0] : raw;

  let yes_price = 0.5;
  let no_price = 0.5;
  if (m.outcomePrices) {
    try {
      const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      if (Array.isArray(prices) && prices.length > 1) {
        no_price = Number(prices[0]) || 0.5;
        yes_price = Number(prices[1]) || 0.5;
      } else if (Array.isArray(prices) && prices.length > 0) {
        yes_price = Number(prices[0]) || 0.5;
        no_price = Math.max(0.01, Math.min(0.99, 1 - yes_price));
      }
    } catch { /* ignore */ }
  }

  const resolution_date = m.endDate || m.endDateIso || new Date(Date.now() + 30 * 86400000).toISOString();
  const days_to_resolution = Math.max(1, Math.round((new Date(resolution_date).getTime() - Date.now()) / 86400000));

  let token_id: string | undefined;
  const tokens = parseClobTokenIds(m.clobTokenIds);
  if (tokens.noTokenId || tokens.yesTokenId) {
    token_id = tokens.noTokenId ?? tokens.yesTokenId ?? undefined;
  } else if (Array.isArray(m.tokens) && m.tokens.length > 0) {
    token_id = m.tokens[0].token_id;
  }

  return {
    slug: m.slug || slug,
    question: m.question || slug,
    description: m.description || "",
    yes_price,
    no_price,
    resolution_date,
    days_to_resolution,
    token_id,
    yes_token_id: tokens.yesTokenId ?? undefined,
    no_token_id: tokens.noTokenId ?? undefined,
    category: m.category,
    event_slug: m.groupSlug || m.eventSlug || undefined,
    condition_id: m.conditionId || undefined,
  };
}

/**
 * Resolve the correct Polymarket frontend URL for a given market slug.
 */
export async function resolvePolymarketUrl(marketSlug: string): Promise<string> {
  try {
    const res = await fetchWithRetry(
      `${GAMMA_API_BASE}/markets?slug=${marketSlug}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const raw: unknown = await res.json();
      const m: any = Array.isArray(raw) && raw.length > 0 ? raw[0] : raw;
      const eventSlug = m?.groupSlug || m?.eventSlug || m?.slug || marketSlug;
      return `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`;
    }
  } catch {
    // Gamma API timeout/error — fall back
  }
  return `https://polymarket.com/event/${encodeURIComponent(marketSlug)}`;
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
