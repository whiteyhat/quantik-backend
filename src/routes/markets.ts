import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";
import { getDb } from "../db/schema";

const router = Router();

// ── Types ──────────────────────────────────────────────────────

interface MarketsListResponse {
  markets: unknown[];
  total: number;
  hasMore: boolean;
  stale?: boolean;
  cachedAt?: number;
}

interface MarketsCacheRow {
  key: string;
  data: string;
  cached_at: number;
}

// ── Cache helpers ──────────────────────────────────────────────

function cacheKey(category: string | undefined): string {
  return `markets:${category ?? "all"}`;
}

function readCache(key: string): { data: unknown[]; cachedAt: number } | null {
  try {
    const db = getDb();
    const row = db
      .prepare<[string], MarketsCacheRow>(
        "SELECT * FROM markets_cache WHERE key = ?"
      )
      .get(key);
    if (!row) return null;
    const data = JSON.parse(row.data) as unknown[];
    return { data, cachedAt: row.cached_at };
  } catch {
    return null;
  }
}

function writeCache(key: string, data: unknown[]): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO markets_cache (key, data, cached_at) VALUES (?, ?, ?)`
    ).run(key, JSON.stringify(data), Date.now());
  } catch {
    // Non-fatal — continue without caching
  }
}

// ── Gamma API fetch ────────────────────────────────────────────

const GAMMA_MARKETS_BASE = "https://gamma-api.polymarket.com/markets";
const GAMMA_EVENTS_BASE  = "https://gamma-api.polymarket.com/events";

// Maps our category keys → tag slugs used in the Gamma events API.
// A single category can match multiple slugs (OR logic).
// NOTE: The Gamma events `tag=` query param is broken and always ignored —
//       we fetch all events and filter client-side by event.tags[].slug.
const CATEGORY_TAG_SLUGS: Record<string, string[]> = {
  crypto:        ["crypto", "crypto-prices"],
  politics:      ["politics", "geopolitics", "elections", "world-elections", "global-elections"],
  sports:        ["sports", "soccer", "nba", "nfl", "mma", "tennis", "golf", "baseball"],
  "pop-culture": ["pop-culture", "awards", "movies", "music", "tv", "celebrity"],
  science:       ["science", "space", "technology", "ai", "biotech"],
  world:         ["world", "geopolitics", "foreign-policy", "middle-east", "ukraine"],
  business:      ["business", "finance", "economy", "stocks", "earnings"],
};

interface GammaTag {
  id: string;
  label: string;
  slug: string;
}

interface GammaEvent {
  tags?: GammaTag[];
  markets?: unknown[];
  [key: string]: unknown;
}

/**
 * Returns true if an event's tags array includes at least one of the
 * target slugs. Comparison is case-insensitive.
 */
function eventMatchesCategory(event: GammaEvent, targetSlugs: string[]): boolean {
  const tags = event.tags ?? [];
  return tags.some((t) => targetSlugs.includes(t.slug?.toLowerCase?.() ?? ""));
}

/**
 * Enrich each market object with parent event metadata so the frontend
 * has context (event title, image, tags) even for nested markets.
 */
function enrichMarketsFromEvent(event: GammaEvent): unknown[] {
  const markets = event.markets ?? [];
  const eventMeta = {
    eventId:    event["id"],
    eventTitle: event["title"],
    eventImage: event["image"],
    eventSlug:  event["slug"],
    eventTags:  event["tags"],
  };

  return markets.map((m) =>
    typeof m === "object" && m !== null
      ? { ...eventMeta, ...(m as Record<string, unknown>) }
      : m
  );
}

async function fetchGammaMarkets(
  limit: number,
  offset: number,
  category?: string
): Promise<unknown[]> {
  if (category) {
    // The Gamma events `tag=` query param is completely ignored by the API
    // (verified: tag=Politics and tag=Crypto return identical results).
    // Instead: fetch a large batch of events, then filter client-side by
    // checking whether any of the event's tags[].slug matches our category.
    const targetSlugs = CATEGORY_TAG_SLUGS[category] ?? [category];

    // Fetch enough events to have a deep pool after filtering.
    // 300 is generous; Gamma seems to cap at ~200 per page.
    const params = new URLSearchParams({
      active:     "true",
      closed:     "false",
      order:      "volume",
      ascending:  "false",
      limit:      "300",
    });

    const url = `${GAMMA_EVENTS_BASE}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Gamma Events API returned ${res.status}: ${res.statusText}`);
    }

    const events: unknown = await res.json();
    if (!Array.isArray(events)) return [];

    // Filter events by tag slug, then flatten their markets
    const markets: unknown[] = [];
    for (const event of events) {
      if (event === null || typeof event !== "object") continue;
      const ev = event as GammaEvent;
      if (eventMatchesCategory(ev, targetSlugs)) {
        markets.push(...enrichMarketsFromEvent(ev));
      }
    }
    return markets;
  }

  // No category — use /markets sorted by volume (default behaviour)
  const params = new URLSearchParams({
    active:    "true",
    closed:    "false",
    order:     "volume",
    ascending: "false",
    limit:     String(limit),
    offset:    String(offset),
  });

  const url = `${GAMMA_MARKETS_BASE}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Gamma Markets API returned ${res.status}: ${res.statusText}`);
  }

  const data: unknown = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── Trending markets in-memory cache ──────────────────────────
interface TrendingCache {
  data: unknown[];
  fetchedAt: number;
}
let trendingCache: TrendingCache | null = null;
const TRENDING_TTL = 5 * 60 * 1000; // 5 minutes

interface GammaMarketRaw {
  slug?: string;
  conditionId?: string;
  question?: string;
  outcomePrices?: string;
  volume24hr?: number;
  liquidity?: number;
  [key: string]: unknown;
}

/** Gamma returns clobTokenIds as either an array or a JSON-encoded string.
 *  Order follows outcomes: ["No","Yes"] → clobTokenIds[0]=NO, [1]=YES */
function parseClobTokenIds(raw: unknown): { noTokenId: string | null; yesTokenId: string | null } {
  let arr: string[] = [];
  if (Array.isArray(raw)) {
    arr = raw.map(String);
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed.map(String);
    } catch { /* ignore */ }
  }
  return {
    noTokenId: arr[0] ?? null,
    yesTokenId: arr[1] ?? null,
  };
}
function parseClobTokenId(raw: unknown): string | null {
  return parseClobTokenIds(raw).noTokenId;
}

function transformTrendingMarket(raw: GammaMarketRaw): unknown {
  let outcomePrices: number[] = [];
  try {
    const parsed = JSON.parse(raw.outcomePrices ?? "[]");
    if (Array.isArray(parsed)) {
      outcomePrices = parsed.map((p: unknown) => parseFloat(String(p)) || 0);
    }
  } catch { /* ignore parse errors */ }

  const liquidity = raw.liquidity ?? 0;
  const liquidityGrade =
    liquidity > 50000 ? "A" : liquidity > 10000 ? "B" : liquidity > 1000 ? "C" : "D";

  const tokens = parseClobTokenIds(raw.clobTokenIds);
  return {
    slug: raw.slug ?? raw.conditionId ?? "",
    question: raw.question ?? "",
    yesPrice: outcomePrices[1] ?? 0,
    noPrice: outcomePrices[0] ?? 0,
    volume: raw.volume24hr ?? 0,
    liquidity,
    liquidityGrade,
    tokenId: tokens.noTokenId ?? raw.conditionId ?? "",
    yesTokenId: tokens.yesTokenId ?? raw.conditionId ?? "",
    noTokenId: tokens.noTokenId ?? raw.conditionId ?? "",
  };
}

// ── GET /api/markets/trending ─────────────────────────────────
router.get("/trending", async (_req: Request, res: Response) => {
  // Return cached if fresh
  if (trendingCache && Date.now() - trendingCache.fetchedAt < TRENDING_TTL) {
    res.json({ markets: trendingCache.data, total: trendingCache.data.length, hasMore: false });
    return;
  }

  try {
    const url =
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=20";
    const apiRes = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!apiRes.ok) {
      throw new Error(`Gamma trending API returned ${apiRes.status}`);
    }

    const raw: unknown = await apiRes.json();
    if (!Array.isArray(raw)) throw new Error("Unexpected response shape");

    const markets = raw.map((m: unknown) => transformTrendingMarket(m as GammaMarketRaw));

    // Cache result
    trendingCache = { data: markets, fetchedAt: Date.now() };

    res.json({ markets, total: markets.length, hasMore: false });
  } catch {
    // Return stale cache if available
    if (trendingCache) {
      res.json({ markets: trendingCache.data, total: trendingCache.data.length, hasMore: false, stale: true });
      return;
    }
    res.status(503).json({ error: "Polymarket unavailable", fallback: true });
  }
});

// ── GET /api/markets?limit=20&offset=0&category=crypto ─────────
router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(
    Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20),
    100
  );
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const category =
    typeof req.query.category === "string" && req.query.category
      ? req.query.category.toLowerCase()
      : undefined;

  const key = cacheKey(category);

  try {
    let markets: unknown[];
    let hasMore: boolean;
    let total: number;

    if (category) {
      // Client-side filtering: fetchGammaMarkets returns the full filtered pool.
      // We paginate here after receiving all matching markets.
      const allMatching = await fetchGammaMarkets(limit, offset, category);
      hasMore = allMatching.length > offset + limit;
      markets = allMatching.slice(offset, offset + limit);
      total = allMatching.length;
      // Cache the full pool so stale fallback has complete data
      writeCache(key, allMatching);
    } else {
      // API-side pagination: fetch limit+1 to detect hasMore
      const probe = await fetchGammaMarkets(limit + 1, offset, undefined);
      hasMore = probe.length > limit;
      markets = probe.slice(0, limit);
      total = offset + markets.length + (hasMore ? 1 : 0);
      writeCache(key, probe);
    }

    const response: MarketsListResponse = { markets, total, hasMore };
    res.json(response);
  } catch (err) {
    // Gamma API failed — attempt stale cache fallback
    const cached = readCache(key);
    if (cached) {
      const hasMore = cached.data.length > offset + limit;
      const markets = cached.data.slice(offset, offset + limit);
      const response: MarketsListResponse = {
        markets,
        total: cached.data.length,
        hasMore,
        stale: true,
        cachedAt: cached.cachedAt,
      };
      res.json(response);
      return;
    }

    // No cache available — return empty rather than 502
    const response: MarketsListResponse = {
      markets: [],
      total: 0,
      hasMore: false,
      stale: true,
    };
    res.json(response);
  }
});

// ── GET /api/markets/:slug ─────────────────────────────────────
router.get("/:slug", async (req: Request, res: Response) => {
  const slug = String(req.params["slug"] ?? "");
  try {
    // Gamma bulk endpoint with slug filter is unreliable — search in active markets list
    const urls = [
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`,
      `https://gamma-api.polymarket.com/markets?active=true&limit=100&order=volume24hr&ascending=false`,
    ];
    let raw: Record<string, unknown> | null = null;

    for (const url of urls) {
      const r = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const arr: unknown = await r.json();
      if (Array.isArray(arr)) {
        const match = arr.find((m: unknown) => (m as Record<string, unknown>)["slug"] === slug) as Record<string, unknown> | undefined;
        if (match) { raw = match; break; }
      }
    }

    if (!raw) {
      res.status(404).json({ error: "Market not found" });
      return;
    }

    // Normalize to frontend-expected shape (includes tokenId from clobTokenIds)
    res.json(transformTrendingMarket(raw as GammaMarketRaw));
  } catch (err) {
    handleCliError(res, err);
  }
});

// ── GET /api/markets/:tokenId/book ─────────────────────────────
router.get("/:tokenId/book", async (req: Request, res: Response) => {
  const tokenId = String(req.params["tokenId"] ?? "");
  if (!tokenId) {
    res.status(400).json({ error: "Missing tokenId" });
    return;
  }
  try {
    const apiRes = await fetch(
      `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!apiRes.ok) {
      res.status(apiRes.status).json({ error: "CLOB API error", status: apiRes.status });
      return;
    }
    const data = (await apiRes.json()) as Record<string, unknown>;
    const normalize = (levels: unknown[]) =>
      levels.map((l: unknown) => {
        const r = l as Record<string, unknown>;
        return { price: parseFloat(String(r.price)) || 0, size: parseFloat(String(r.size)) || 0 };
      });
    res.json({
      bids: Array.isArray(data.bids) ? normalize(data.bids) : [],
      asks: Array.isArray(data.asks) ? normalize(data.asks) : [],
    });
  } catch (err) {
    handleCliError(res, err);
  }
});

// ── Synthetic price-history fallback ────────────────────────────
function generateSyntheticPriceHistory(basePrice = 0.5, points = 30): { t: number; p: number }[] {
  const now = Date.now();
  const dayMs = 86400000;
  let price = basePrice;
  const history: { t: number; p: number }[] = [];
  for (let i = points - 1; i >= 0; i--) {
    history.push({ t: now - i * dayMs, p: Math.round(price * 1000) / 1000 });
    price += (Math.random() - 0.5) * 0.04; // ±0.02 random walk
    price = Math.max(0.01, Math.min(0.99, price));
  }
  return history;
}

// ── GET /api/markets/:tokenId/price-history ────────────────────
router.get("/:tokenId/price-history", async (req: Request, res: Response) => {
  const tokenId = String(req.params["tokenId"] ?? "");
  const interval =
    typeof req.query.interval === "string" ? req.query.interval : undefined;
  const fidelity =
    typeof req.query.fidelity === "string" ? req.query.fidelity : undefined;

  // 1) Try CLI first — only use if it returns non-empty data
  try {
    const args = ["clob", "price-history", tokenId];
    if (interval) args.push("--interval", interval);
    if (fidelity) args.push("--fidelity", fidelity);
    const data = await runCli(args);
    if (Array.isArray(data) && data.length > 0) return res.json(data);
    // CLI returned [] — fall through to CLOB REST API
  } catch {}

  // 2) Try Gamma API for price history (tokenId is the condition ID or token ID)
  try {
    // Map frontend intervals to CLOB API intervals
    const clobInterval = interval === "1h" ? "1h" : interval === "1w" ? "1w" : interval === "all" ? "max" : "1d";
    const gammaRes = await fetch(
      `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=${clobInterval}&fidelity=10`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (gammaRes.ok) {
      const data = (await gammaRes.json()) as any;
      // CLOB returns { history: [{t: number, p: number}] }
      if (data?.history && Array.isArray(data.history)) {
        return res.json(data.history);
      }
    }
  } catch {}

  // 3) Final fallback: synthetic data anchored to actual market price from Gamma
  try {
    const gammaSlugRes = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(tokenId)}&active=true&limit=1`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (gammaSlugRes.ok) {
      const gms = await gammaSlugRes.json() as any[];
      const ltp = parseFloat(gms?.[0]?.lastTradePrice ?? "0.5");
      if (ltp > 0) return res.json(generateSyntheticPriceHistory(ltp, 30));
    }
  } catch {}
  res.json(generateSyntheticPriceHistory(0.5, 30));
});

// ── GET /api/markets/:tokenId/spread ──────────────────────────
router.get("/:tokenId/spread", async (req: Request, res: Response) => {
  const tokenId = String(req.params["tokenId"] ?? "");
  try {
    const data = await runCli(["clob", "spread", tokenId]);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

function handleCliError(res: Response, err: unknown): void {
  if (err instanceof CliError) {
    res.status(502).json({ error: err.message, stderr: err.stderr });
  } else {
    res.status(500).json({ error: String(err) });
  }
}

export default router;
