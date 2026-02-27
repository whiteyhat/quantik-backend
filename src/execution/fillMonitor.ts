// ── FillMonitor — polls open paper orders & auto-fills ───────────

import { getDb } from "../db/schema";
import type { PaperOrder } from "./paperMode";

interface PaperOrderRow {
  id: string;
  slug: string;
  direction: string;
  size: number;
  entry_price: number;
  status: string;
  created_at: number;
  filled_at: number | null;
}

function rowToOrder(row: PaperOrderRow): PaperOrder {
  return {
    id: row.id,
    slug: row.slug,
    direction: row.direction as "YES" | "NO",
    size: row.size,
    entryPrice: row.entry_price,
    status: row.status as PaperOrder["status"],
    filledAt: row.filled_at,
  };
}

const POLL_INTERVAL_MS = 30_000; // 30 seconds

export class FillMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** Start polling open orders every 30s. */
  start(): void {
    if (this.intervalId) return;
    console.log("[FillMonitor] Started — polling every 30s");
    this.intervalId = setInterval(() => this.pollOrders(), POLL_INTERVAL_MS);
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[FillMonitor] Stopped");
    }
  }

  /** Check all open paper orders and fill any that have been open > 2s. */
  pollOrders(): void {
    const db = getDb();
    const cutoff = Date.now() - 2000; // orders older than 2s get filled

    const openRows = db
      .prepare(
        "SELECT * FROM paper_orders WHERE status = 'open' AND created_at <= ?"
      )
      .all(cutoff) as PaperOrderRow[];

    if (openRows.length === 0) return;

    const fillStmt = db.prepare(
      "UPDATE paper_orders SET status = 'filled', entry_price = ?, filled_at = ? WHERE id = ?"
    );

    const now = Date.now();
    for (const row of openRows) {
      const midPrice = 0.5; // simulated mid price
      fillStmt.run(midPrice, now, row.id);
      console.log(`[FillMonitor] Filled order ${row.id} (${row.slug} ${row.direction})`);
    }
  }

  /** Get a single order's current status. */
  getOrderStatus(orderId: string): PaperOrder | null {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM paper_orders WHERE id = ?")
      .get(orderId) as PaperOrderRow | undefined;

    return row ? rowToOrder(row) : null;
  }
}
