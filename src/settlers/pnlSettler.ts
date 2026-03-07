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

export async function settle(): Promise<void> {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL`).all() as ExecutionRow[];

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

        // FIXED PS1: Correct PnL using recommendation from scanner_results for direction
        // For both YES and NO bets: shares = amount / fillPrice; payout = shares * 1.0 when winning
        const scanRec = db.prepare("SELECT recommendation FROM scanner_results WHERE slug = ? ORDER BY scanned_at DESC LIMIT 1").get(row.slug) as { recommendation: string } | undefined;
        const isBetNo = (scanRec?.recommendation === "BET_NO"); // use recommendation as direction source
        // Fallback direction heuristic: fillPrice > 0.5 → NO token (when oracle prob stored)
        const isBetNoFallback = !scanRec ? fillPrice > 0.5 : isBetNo;
        // Win condition: NO bet wins when YES resolves false (resolutionPrice=0); YES bet wins when resolutionPrice=1
        const weWon = isBetNoFallback ? resolutionPrice === 0 : resolutionPrice === 1;
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
