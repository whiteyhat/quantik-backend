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
    let rawMarkets: unknown[];

    if (category) {
      // Use events list with --tag for category filtering, then flatten markets
      const events = await runCli([
        "events",
        "list",
        "--tag",
        category,
        "--active",
        "true",
        "--closed",
        "false",
        "--limit",
        String(limit + 1),
        "--offset",
        String(offset),
      ]);

      const eventsArr = Array.isArray(events) ? events : [];
      // Flatten: each event has a `markets` array
      rawMarkets = eventsArr.flatMap((e) => {
        const ev = e as Record<string, unknown>;
        const inner = ev["markets"];
        return Array.isArray(inner) ? inner : [e];
      });
    } else {
      // Use markets list for general (no category) queries
      const result = await runCli([
        "markets",
        "list",
        "--active",
        "true",
        "--closed",
        "false",
        "--order",
        "volume_num",
        "--limit",
        String(limit + 1),
        "--offset",
        String(offset),
      ]);
      rawMarkets = Array.isArray(result) ? result : [];
    }

    // Determine pagination
    const hasMore = rawMarkets.length > limit;
    const markets = rawMarkets.slice(0, limit);
    const total = offset + markets.length + (hasMore ? 1 : 0);

    // Cache successful result
    writeCache(key, rawMarkets);

    const response: MarketsListResponse = { markets, total, hasMore };
    res.json(response);
  } catch (err) {
    // CLI failed — attempt stale cache fallback
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

    // No cache available
    if (err instanceof CliError) {
      res.status(502).json({ error: err.message, stderr: err.stderr });
    } else {
      res.status(500).json({ error: String(err) });
    }
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
