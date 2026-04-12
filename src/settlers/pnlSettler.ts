import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgExec, dualQuery } from "../db/postgres";
import {
  getEntryYesPrice,
  getLatestScannerDirectionMap,
  resolveExecutionDirection,
} from "../utils/executionDirection";
import { GAMMA_API_BASE, fetchWithRetry } from "../utils/market-fetch";
import { resetArenaLeaderboardCache } from "../performance/arenaService";

interface ExecutionRow {
  id: number;
  slug: string;
  side: string;
  direction: string | null;
  amount: number;
  executed_at: number;
  status: string;
  order_id: string | null;
  fill_price: number | null;
  pnl: number | null;
}

interface GammaMarket {
  resolved?: boolean;
  resolutionPrice?: string;
}

// ─── Scanner-based resolution detection ───────────────────────────────────────
// When the Gamma API can't find a market by slug (common for internal/transformed
// slugs), we use scanner probability data as a fallback resolution source.
// A market is considered resolved when:
//   1. Scanner probability is extreme (≤0.05 for NO, ≥0.95 for YES)
//   2. The market slug contains a date that has already passed, OR
//      the last scanner scan is stale (>48h old, indicating market is no longer active)

interface ScannerSnapshot {
  slug: string;
  probability: number;
  scanned_at: number;
}

const SCANNER_RESOLUTION_THRESHOLD = 0.05; // probability ≤ this → resolved NO; ≥ (1 - this) → resolved YES
const SCANNER_STALE_MS = 48 * 60 * 60 * 1000; // 48 hours — if last scan is older, market is likely inactive

function extractDateFromSlug(slug: string): Date | null {
  // Match patterns like: by-march-31, march-21-march-23, april-30, 2026-04-12
  const monthMap: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  // ISO-ish: 2026-04-12
  const isoMatch = slug.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]), 23, 59, 59);
  }

  // "by-month-day" or "month-day" at end of slug
  const monthDayMatch = slug.match(/(?:by-)?(\w+)-(\d{1,2})(?:-\d{4})?$/);
  if (monthDayMatch) {
    const month = monthMap[monthDayMatch[1].toLowerCase()];
    if (month !== undefined) {
      const day = Number(monthDayMatch[2]);
      const now = new Date();
      let year = now.getFullYear();
      const candidate = new Date(year, month, day, 23, 59, 59);
      // If the date is far in the future, don't use it
      if (candidate.getTime() > now.getTime() + 365 * 24 * 60 * 60 * 1000) {
        year -= 1;
      }
      return new Date(year, month, day, 23, 59, 59);
    }
  }

  // "this-week" style — use the last scan date as proxy
  return null;
}

function isMarketExpiredBySlug(slug: string, now: number): boolean {
  const endDate = extractDateFromSlug(slug);
  if (!endDate) return false;
  // Give 24h grace period past the end date
  return now > endDate.getTime() + 24 * 60 * 60 * 1000;
}

async function loadLatestScannerPrices(slugs: string[]): Promise<Map<string, ScannerSnapshot>> {
  if (slugs.length === 0) return new Map();
  const rows = await dualQuery<ScannerSnapshot>(
    isPgEnabled()
      ? `SELECT DISTINCT ON (slug) slug, probability, scanned_at FROM scanner_results WHERE slug = ANY($1::text[]) ORDER BY slug, scanned_at DESC`
      : `SELECT s.slug, s.probability, s.scanned_at FROM scanner_results s INNER JOIN (SELECT slug, MAX(scanned_at) AS mx FROM scanner_results WHERE slug IN (${slugs.map(() => "?").join(",")}) GROUP BY slug) latest ON latest.slug = s.slug AND latest.mx = s.scanned_at`,
    isPgEnabled() ? [slugs] : slugs,
  );
  return new Map(rows.map((r) => [r.slug, r]));
}

interface ScannerResolution {
  resolved: true;
  resolutionPrice: number; // 0 = NO won, 1 = YES won
  source: "scanner_expired" | "scanner_stale" | "scanner_abandoned";
}

// How long scanner must be idle before we consider the market abandoned.
// At 7+ days stale, the market is almost certainly no longer active.
const SCANNER_ABANDONED_MS = 7 * 24 * 60 * 60 * 1000;

function tryScannerResolution(
  slug: string,
  scanner: ScannerSnapshot | undefined,
  now: number,
): ScannerResolution | null {
  if (!scanner) return null;
  const prob = scanner.probability;
  const slugExpired = isMarketExpiredBySlug(slug, now);
  const scanStale = now - scanner.scanned_at > SCANNER_STALE_MS;
  const scanAbandoned = now - scanner.scanned_at > SCANNER_ABANDONED_MS;

  // ── Tier 1: Extreme probability (≤0.05 or ≥0.95) ──────────────────
  // High confidence — only needs a basic temporal signal.
  const isResolvedYes = prob >= 1 - SCANNER_RESOLUTION_THRESHOLD;
  const isResolvedNo = prob <= SCANNER_RESOLUTION_THRESHOLD;
  if (isResolvedYes || isResolvedNo) {
    if (slugExpired || scanStale) {
      return {
        resolved: true,
        resolutionPrice: isResolvedYes ? 1 : 0,
        source: slugExpired ? "scanner_expired" : "scanner_stale",
      };
    }
    return null;
  }

  // ── Tier 2: Abandoned market (scanner idle >7 days) ────────────────
  // The scanner stopped tracking this market over a week ago, meaning it
  // is no longer active on Polymarket. Use last known probability to
  // infer likely resolution: prob < 0.5 → NO, prob >= 0.5 → YES.
  if (scanAbandoned) {
    return {
      resolved: true,
      resolutionPrice: prob >= 0.5 ? 1 : 0,
      source: "scanner_abandoned",
    };
  }

  return null;
}

// ─── Settlement logic ─────────────────────────────────────────────────────────

function settleExecution(
  db: ReturnType<typeof getDb>,
  row: ExecutionRow,
  resolutionPrice: number,
  scannerDirection: ReturnType<typeof resolveExecutionDirection> extends { direction: infer D } ? D : never,
  scannerDirections: Map<string, any>,
): { pnl: number } | null {
  const resolvedDirection = resolveExecutionDirection(row, scannerDirections.get(row.slug)).direction;

  // Voided market (resolution price is not 0 or 1)
  if (resolutionPrice !== 0 && resolutionPrice !== 1) {
    if (isPgEnabled()) {
      pgExec(`UPDATE executions SET status = 'voided', pnl = 0 WHERE id = $1`, [row.id]);
    } else {
      db.prepare(`UPDATE executions SET status = 'voided', pnl = 0 WHERE id = ?`).run(row.id);
    }
    console.log(`[pnlSettler] Voided: ${row.slug}`);
    return { pnl: 0 };
  }

  let fillPrice = row.fill_price;
  if (fillPrice == null || fillPrice === 0) {
    // Use a reasonable default when fill price is missing
    fillPrice = 0.5;
  }

  const fillRow = { ...row, fill_price: fillPrice };
  const scannerDir = scannerDirections.get(row.slug);
  const entryYesPrice = getEntryYesPrice(fillRow, scannerDir);
  const entryTokenPrice = resolvedDirection === "YES"
    ? entryYesPrice
    : Math.max(0.01, Math.min(0.99, 1 - entryYesPrice));
  const weWon = resolvedDirection === "NO" ? resolutionPrice === 0 : resolutionPrice === 1;
  const shares = row.amount / entryTokenPrice;
  const pnl = weWon ? shares * (1 - entryTokenPrice) : -row.amount;

  if (isPgEnabled()) {
    pgExec(`UPDATE executions SET pnl = $1, status = 'settled', closed_at = $3 WHERE id = $2`, [pnl, row.id, Date.now()]);
    pgExec(`UPDATE oracle_results SET resolved_correctly = $1 WHERE market_slug = $2`, [pnl > 0 ? 1 : 0, row.slug]);
  } else {
    db.prepare(`UPDATE executions SET pnl = ?, status = 'settled', closed_at = ? WHERE id = ?`).run(pnl, Date.now(), row.id);
    db.prepare(`UPDATE oracle_results SET resolved_correctly = ? WHERE market_slug = ?`).run(pnl > 0 ? 1 : 0, row.slug);
  }

  return { pnl };
}

export async function settle(): Promise<void> {
  try {
    const db = getDb();
    let rows: ExecutionRow[];
    if (isPgEnabled()) {
      rows = await pgQuery<ExecutionRow>(
        `SELECT * FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL`,
        []
      );
    } else {
      rows = db.prepare(`SELECT * FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL`).all() as ExecutionRow[];
    }
    const scannerDirections = await getLatestScannerDirectionMap();

    if (rows.length === 0) return;
    console.log(`[pnlSettler] Checking ${rows.length} open positions`);

    // Pre-load scanner prices for all open slugs (single query)
    const openSlugs = [...new Set(rows.map((r) => r.slug))];
    const scannerPrices = await loadLatestScannerPrices(openSlugs);
    const now = Date.now();
    let settledCount = 0;

    for (const row of rows) {
      try {
        // ── Primary: Gamma API lookup ──────────────────────────────────
        let resolved = false;
        let resolutionPrice = 0;

        const res = await fetchWithRetry(`${GAMMA_API_BASE}/markets?slug=${row.slug}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
        if (res?.ok) {
          const markets = await res.json().catch(() => []) as GammaMarket[];
          if (Array.isArray(markets) && markets.length > 0) {
            const market = markets[0];
            if (market.resolved) {
              resolved = true;
              resolutionPrice = parseFloat(market.resolutionPrice ?? "0");
            }
          }
        }

        // ── Fallback: Scanner-based resolution ─────────────────────────
        // When Gamma API returns empty (slug mismatch), check if scanner
        // data + slug date indicate the market has clearly resolved.
        if (!resolved) {
          const scannerRes = tryScannerResolution(row.slug, scannerPrices.get(row.slug), now);
          if (scannerRes) {
            resolved = true;
            resolutionPrice = scannerRes.resolutionPrice;
            console.log(`[pnlSettler] Scanner-based resolution for ${row.slug}: price=${resolutionPrice} (${scannerRes.source})`);
          }
        }

        if (!resolved) continue;

        const result = settleExecution(db, row, resolutionPrice, "" as any, scannerDirections);
        if (result) {
          settledCount++;
          console.log(`[pnlSettler] Settled ${row.slug}: pnl=$${result.pnl.toFixed(2)}`);
        }
      } catch (err) {
        console.error(`[pnlSettler] Error settling ${row.slug}:`, err);
      }
    }

    // Bust the arena cache so the leaderboard reflects newly settled trades
    if (settledCount > 0) {
      resetArenaLeaderboardCache();
      console.log(`[pnlSettler] Settled ${settledCount} trades, arena cache cleared`);
    }
  } catch (err) {
    console.error("[pnlSettler] settle() error:", err);
  }
}

export function startPnlSettler(): void {
  console.log("[pnlSettler] Starting (30-minute interval)");
  settle().catch(() => {});
  setInterval(() => settle().catch(() => {}), 30 * 60 * 1000);
}
