import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, dualQuery } from "../db/postgres";

import type { TradeDirection } from "../types/execution";

export type ExecutionDirection = TradeDirection;

export interface ExecutionDirectionRecord {
  slug: string;
  direction?: string | null;
  side?: string | null;
  status?: string | null;
  fill_price?: number | null;
  fillPrice?: number | null;
  amount?: number | null;
}

export interface ExecutionDirectionResolution {
  direction: ExecutionDirection;
  source: "stored" | "scanner" | "legacy";
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.01, Math.min(0.99, value));
}

export function normalizeExecutionDirection(value: unknown): ExecutionDirection | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "YES" || normalized === "NO") return normalized;
  return null;
}

export function recommendationToDirection(value: unknown): ExecutionDirection | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "BET_YES" || normalized === "BUY_YES" || normalized === "YES") {
    return "YES";
  }
  if (normalized === "BET_NO" || normalized === "BUY_NO" || normalized === "NO") {
    return "NO";
  }
  return null;
}

export interface LatestScannerRow {
  slug: string;
  probability: number | null;
  recommendation: string | null;
}

/** Fetch the latest scanner result per slug (single query, shared across callers). */
export async function getLatestScannerResults(): Promise<LatestScannerRow[]> {
  return dualQuery<LatestScannerRow>(
    `SELECT s.slug, s.probability, s.recommendation
       FROM scanner_results s
       INNER JOIN (
         SELECT slug, MAX(scanned_at) AS latest
         FROM scanner_results
         GROUP BY slug
       ) latest
         ON latest.slug = s.slug AND latest.latest = s.scanned_at`
  );
}

/** Build price and direction maps from scanner rows. */
export function buildScannerMaps(rows: LatestScannerRow[]) {
  return {
    priceMap: new Map(rows.map(r => [r.slug, r.probability])),
    directionMap: new Map(
      rows
        .map((r) => [r.slug, recommendationToDirection(r.recommendation)] as const)
        .filter((e): e is [string, ExecutionDirection] => e[1] !== null)
    ),
  };
}

export async function getLatestScannerDirectionMap(): Promise<Map<string, ExecutionDirection>> {
  const rows = await getLatestScannerResults();
  return buildScannerMaps(rows).directionMap;
}

export function resolveExecutionDirection(
  execution: ExecutionDirectionRecord,
  scannerDirection?: ExecutionDirection | null
): ExecutionDirectionResolution {
  const storedDirection = normalizeExecutionDirection(execution.direction);
  if (storedDirection) {
    return { direction: storedDirection, source: "stored" };
  }

  if (scannerDirection) {
    return { direction: scannerDirection, source: "scanner" };
  }

  if (typeof execution.side === "string" && execution.side.toLowerCase() === "sell") {
    return { direction: "NO", source: "legacy" };
  }

  return { direction: "YES", source: "legacy" };
}

function getStoredFillPrice(execution: ExecutionDirectionRecord): number {
  const raw = execution.fill_price ?? execution.fillPrice ?? 0.5;
  return clampProbability(Number(raw));
}

export function getEntryYesPrice(
  execution: ExecutionDirectionRecord,
  scannerDirection?: ExecutionDirection | null
): number {
  const fillPrice = getStoredFillPrice(execution);
  const resolved = resolveExecutionDirection(execution, scannerDirection);

  // Explicit direction rows use token-price storage for both YES and NO.
  if (resolved.source === "stored") {
    return resolved.direction === "YES" ? fillPrice : clampProbability(1 - fillPrice);
  }

  // Legacy paper NO rows stored the YES price. Legacy live NO rows stored the NO token price.
  if (resolved.direction === "NO" && execution.status !== "paper") {
    return clampProbability(1 - fillPrice);
  }

  return fillPrice;
}

export function getExecutionTokenPriceFromYesPrice(
  currentYesPrice: number,
  execution: ExecutionDirectionRecord,
  scannerDirection?: ExecutionDirection | null
): number {
  const currentYes = clampProbability(Number(currentYesPrice));
  const { direction } = resolveExecutionDirection(execution, scannerDirection);
  return direction === "YES" ? currentYes : clampProbability(1 - currentYes);
}

export function calculateOpenExecutionMetrics(
  execution: ExecutionDirectionRecord,
  currentYesPrice: number,
  scannerDirection?: ExecutionDirection | null
): {
  direction: ExecutionDirection;
  entryYesPrice: number;
  entryTokenPrice: number;
  currentTokenPrice: number;
  pnl: number;
} {
  const { direction } = resolveExecutionDirection(execution, scannerDirection);
  const entryYesPrice = getEntryYesPrice(execution, scannerDirection);
  const entryTokenPrice = direction === "YES"
    ? entryYesPrice
    : clampProbability(1 - entryYesPrice);
  const currentTokenPrice = getExecutionTokenPriceFromYesPrice(
    currentYesPrice,
    execution,
    scannerDirection
  );
  const amount = Number(execution.amount ?? 0);
  const shares = entryTokenPrice > 0 ? amount / entryTokenPrice : 0;
  const pnl = (currentTokenPrice - entryTokenPrice) * shares;

  return {
    direction,
    entryYesPrice,
    entryTokenPrice,
    currentTokenPrice,
    pnl,
  };
}
