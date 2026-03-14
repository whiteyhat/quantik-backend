import { getDb } from "../db/schema";
import {
  getEntryYesPrice,
  getLatestScannerDirectionMap,
  resolveExecutionDirection,
} from "../utils/executionDirection";

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

export async function settle(): Promise<void> {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL`).all() as ExecutionRow[];
    const scannerDirections = getLatestScannerDirectionMap();

    if (rows.length === 0) return;
    console.log(`[pnlSettler] Checking ${rows.length} open positions`);

    for (const row of rows) {
      try {
        const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${row.slug}`);
        if (!res.ok) continue;

        const markets = await res.json() as GammaMarket[];
        if (!Array.isArray(markets) || markets.length === 0) continue;

        const market = markets[0];
        if (!market.resolved) continue;

        const resolutionPrice = parseFloat(market.resolutionPrice ?? "0");
        const scannerDirection = scannerDirections.get(row.slug);
        const resolvedDirection = resolveExecutionDirection(row, scannerDirection).direction;

        // Voided market (resolution price is not 0 or 1)
        if (resolutionPrice !== 0 && resolutionPrice !== 1) {
          db.prepare(`UPDATE executions SET status = 'voided', pnl = 0 WHERE id = ?`).run(row.id);
          console.log(`[pnlSettler] Voided: ${row.slug}`);
          continue;
        }

        // Get fill price — from execution row or compute from market implied price
        let fillPrice = row.fill_price;
        if (fillPrice == null || fillPrice === 0) {
          // FIXED PS2: don't use oracle probability as fill_price — use latest market price as estimate
          const priceRes = await fetch(`https://gamma-api.polymarket.com/markets?slug=${row.slug}`).catch(() => null);
          if (priceRes?.ok) {
            const mkt = await priceRes.json().catch(() => []) as any[];
            if (Array.isArray(mkt) && mkt[0]) {
              try {
                const prices = JSON.parse(mkt[0].outcomePrices || "[]");
                const yesPrice = Number(prices[1] ?? prices[0] ?? 0.5);
                fillPrice = resolvedDirection === "YES"
                  ? yesPrice
                  : (1 - yesPrice);
              } catch { fillPrice = 0.5; }
            }
          }
        }

        if (fillPrice == null || fillPrice === 0) {
          console.log(`[pnlSettler] No fill price for ${row.slug}, skipping`);
          continue;
        }

        const fillRow = { ...row, fill_price: fillPrice };
        const entryYesPrice = getEntryYesPrice(fillRow, scannerDirection);
        const entryTokenPrice = resolvedDirection === "YES"
          ? entryYesPrice
          : Math.max(0.01, Math.min(0.99, 1 - entryYesPrice));
        const weWon = resolvedDirection === "NO" ? resolutionPrice === 0 : resolutionPrice === 1;
        const shares = row.amount / entryTokenPrice;
        const pnl = weWon ? shares * (1 - entryTokenPrice) : -row.amount;

        db.prepare(`UPDATE executions SET pnl = ?, status = 'settled' WHERE id = ?`).run(pnl, row.id);
        db.prepare(`UPDATE oracle_results SET resolved_correctly = ? WHERE market_slug = ?`).run(pnl > 0 ? 1 : 0, row.slug);

        console.log(`[pnlSettler] Settled ${row.slug}: pnl=$${pnl.toFixed(2)}`);
      } catch (err) {
        console.error(`[pnlSettler] Error settling ${row.slug}:`, err);
      }
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
