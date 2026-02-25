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

// Valid category → Polymarket tag mapping
const CATEGORY_TAG_MAP: Record<string, string> = {
  crypto:       "crypto",
  politics:     "politics",
  sports:       "sports",
  "pop-culture": "pop-culture",
  science:      "science",
  world:        "world",
  business:     "business",
};

async function fetchGammaMarkets(
  limit: number,
  offset: number,
  category?: string
): Promise<unknown[]> {
  if (category) {
    // Polymarket Gamma does NOT filter /markets by tag.
    // Use the /events endpoint with tag= then flatten each event's markets array.
    const tag = CATEGORY_TAG_MAP[category] ?? category;
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      tag,
      limit: String(limit),
      offset: String(offset),
    });

    const url = `${GAMMA_EVENTS_BASE}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`Gamma Events API returned ${res.status}: ${res.statusText}`);
    }

    const events: unknown = await res.json();
    if (!Array.isArray(events)) return [];

    // Flatten all markets from every event
    const markets: unknown[] = [];
    for (const event of events) {
      if (
        event !== null &&
        typeof event === "object" &&
        Array.isArray((event as Record<string, unknown>)["markets"])
      ) {
        markets.push(...((event as Record<string, unknown>)["markets"] as unknown[]));
      }
    }
    return markets;
  }

  // No category — use /markets sorted by volume (default behaviour)
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    order: "volume",
    ascending: "false",
    limit: String(limit),
    offset: String(offset),
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

// ── GET /api/markets?limit=20&offset=0&category=crypto ─────────
router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(
    Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20),
    100
  );
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const category =
    typeof req.query.category === "string" && req.query.category
      ? req.query.category
      : undefined;

  const key = cacheKey(category);

  try {
    // Fetch one extra to determine hasMore
    const rawMarkets = await fetchGammaMarkets(limit + 1, offset, category);

    // Determine pagination
    const hasMore = rawMarkets.length > limit;
    const markets = rawMarkets.slice(0, limit);
    const total = offset + markets.length + (hasMore ? 1 : 0);

    // Cache successful result
    writeCache(key, rawMarkets);

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
    const data = await runCli(["markets", "get", slug]);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// ── GET /api/markets/:tokenId/book ─────────────────────────────
router.get("/:tokenId/book", async (req: Request, res: Response) => {
  const tokenId = String(req.params["tokenId"] ?? "");
  try {
    const data = await runCli(["clob", "book", tokenId]);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// ── GET /api/markets/:tokenId/price-history ────────────────────
router.get("/:tokenId/price-history", async (req: Request, res: Response) => {
  const tokenId = String(req.params["tokenId"] ?? "");
  try {
    const args = ["clob", "price-history", tokenId];
    const interval =
      typeof req.query.interval === "string" ? req.query.interval : undefined;
    const fidelity =
      typeof req.query.fidelity === "string" ? req.query.fidelity : undefined;
    if (interval) args.push("--interval", interval);
    if (fidelity) args.push("--fidelity", fidelity);
    const data = await runCli(args);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
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
