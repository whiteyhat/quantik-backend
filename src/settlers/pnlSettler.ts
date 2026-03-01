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

        // Get fill price — from execution row or fall back to scanner_results
        let fillPrice = row.fill_price;
        if (fillPrice == null) {
          const scanRow = db.prepare(`SELECT probability FROM scanner_results WHERE slug = ? ORDER BY scanned_at DESC LIMIT 1`).get(row.slug) as { probability: number } | undefined;
          if (scanRow) fillPrice = scanRow.probability;
        }

        if (fillPrice == null || fillPrice === 0) {
          console.log(`[pnlSettler] No fill price for ${row.slug}, skipping`);
          continue;
        }

        const pnl = (resolutionPrice - fillPrice) * row.amount / fillPrice;

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
