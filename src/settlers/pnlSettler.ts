import { getDb } from "../db/schema";

interface ExecutionRow {
  id: number;
  slug: string;
  side: string;
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

async function settle(): Promise<void> {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM executions WHERE status = 'placed' AND pnl IS NULL`).all() as ExecutionRow[];

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
                const yesPrice = Number(prices[0] ?? 0.5);
                // Approximate fill price: if it was a NO bet, fillPrice ≈ 1 - yesPrice at resolution
                fillPrice = yesPrice < 0.5 ? (1 - yesPrice) : yesPrice;
              } catch { fillPrice = 0.5; }
            }
          }
        }

        if (fillPrice == null || fillPrice === 0) {
          console.log(`[pnlSettler] No fill price for ${row.slug}, skipping`);
          continue;
        }

        // FIXED PS1: Correct PnL for both BET_YES and BET_NO positions
        // For both: shares = amount / fillPrice. If our bet wins, payout = shares * 1.0.
        // Win condition: BET_YES wins when resolutionPrice=1; BET_NO wins when resolutionPrice=0
        // Direction: if fillPrice < 0.5 → likely YES token (BET_YES); if fillPrice > 0.5 → likely NO token (BET_NO)
        const isBetNo = fillPrice > 0.5; // NO tokens trade > 0.5 when YES is unlikely
        const weWon = isBetNo ? resolutionPrice === 0 : resolutionPrice === 1;
        const shares = row.amount / fillPrice;
        const pnl = weWon ? shares * (1 - fillPrice) : -row.amount;

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
