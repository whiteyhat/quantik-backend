// ── PaperModeEngine — simulated order execution ──────────────────

import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";

export interface PaperOrder {
  id: string;
  slug: string;
  direction: "YES" | "NO";
  size: number;
  entryPrice: number;
  status: "open" | "filled" | "cancelled";
  filledAt: number | null;
}

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

export class PaperModeEngine {
  /** Place a paper order; auto-fills after ~2 s at mid price. */
  placePaperOrder(
    slug: string,
    direction: "YES" | "NO",
    sizeUsdc: number
  ): PaperOrder {
    const db = getDb();
    const id = `PO-${uuid()}`;
    const midPrice = 0.5; // default mid; overwritten on fill
    const now = Date.now();

    db.prepare(
      `INSERT INTO paper_orders (id, slug, direction, size, entry_price, status, created_at, filled_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, NULL)`
    ).run(id, slug, direction, sizeUsdc, midPrice, now);

    const order: PaperOrder = {
      id,
      slug,
      direction,
      size: sizeUsdc,
      entryPrice: midPrice,
      status: "open",
      filledAt: null,
    };

    // Simulate fill after 2 seconds
    setTimeout(() => this.simulateFill(id), 2000);

    return order;
  }

  /** Mark an open order as filled at mid price. */
  simulateFill(orderId: string): void {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM paper_orders WHERE id = ? AND status = 'open'")
      .get(orderId) as PaperOrderRow | undefined;

    if (!row) return;

    const midPrice = 0.5; // simulated mid price
    const now = Date.now();

    db.prepare(
      "UPDATE paper_orders SET status = 'filled', entry_price = ?, filled_at = ? WHERE id = ?"
    ).run(midPrice, now, orderId);

    console.log(`[PaperMode] Order ${orderId} filled at $${midPrice}`);
  }

  /** Cancel an open order. */
  cancelOrder(orderId: string): void {
    const db = getDb();
    const result = db
      .prepare(
        "UPDATE paper_orders SET status = 'cancelled' WHERE id = ? AND status = 'open'"
      )
      .run(orderId);

    if (result.changes === 0) {
      throw new Error(`Order ${orderId} not found or not open`);
    }
  }

  /** Get all open paper orders. */
  getOpenOrders(): PaperOrder[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM paper_orders WHERE status = 'open' ORDER BY created_at DESC")
      .all() as PaperOrderRow[];

    return rows.map(rowToOrder);
  }

  /** Get a single order by ID. */
  getOrder(orderId: string): PaperOrder | null {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM paper_orders WHERE id = ?")
      .get(orderId) as PaperOrderRow | undefined;

    return row ? rowToOrder(row) : null;
  }
}
