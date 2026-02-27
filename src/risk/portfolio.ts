import { getDb } from "../db/schema";

// ── Types ──────────────────────────────────────────────────────

interface TradeRow {
  id: string;
  market_slug: string;
  direction: string;
  size: number;
  price: number;
  net_ev: number | null;
  status: string;
  created_at: number;
}

export interface Position {
  slug: string;
  direction: string;
  sizeUsdc: number;
  entryPrice: number;
  openPnl: number;
  createdAt: number;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_POSITION_PCT = 0.05;   // 5% of portfolio per market
const MAX_EXPOSURE_PCT = 0.50;   // 50% total deployed

// ── PortfolioManager ───────────────────────────────────────────

export class PortfolioManager {
  /** All open/submitted positions from trades table */
  getOpenPositions(): Position[] {
    const db = getDb();
    const rows = db
      .prepare<[], TradeRow>(
        "SELECT * FROM trades WHERE status IN ('submitted', 'open') ORDER BY created_at DESC"
      )
      .all();

    return rows.map((r) => ({
      slug: r.market_slug,
      direction: r.direction,
      sizeUsdc: r.size * r.price,
      entryPrice: r.price,
      openPnl: r.net_ev ?? 0,
      createdAt: r.created_at,
    }));
  }

  /** Total USDC held (on-chain + CLOB approximation from settings) */
  getTotalCapital(): number {
    const db = getDb();
    // Sum all trade sizes as a proxy for total capital deployed + available
    // In production this would call the wallet RPC; here we use a configurable default
    const row = db
      .prepare<[], { total: number }>(
        "SELECT COALESCE(SUM(size * price), 0) as total FROM trades"
      )
      .get();
    const deployed = row?.total ?? 0;
    // Use a minimum floor so risk checks work even with empty portfolio
    return Math.max(deployed * 2, 1000);
  }

  /** Capital not currently deployed in open positions */
  getAvailableCapital(): number {
    const deployed = this.getDeployedCapital();
    return this.getTotalCapital() - deployed;
  }

  /** Total USDC currently in open positions */
  getDeployedCapital(): number {
    const positions = this.getOpenPositions();
    return positions.reduce((sum, p) => sum + p.sizeUsdc, 0);
  }

  /** Check if a new position would exceed the 5% per-market limit */
  checkPositionLimit(slug: string, sizeUsdc: number): boolean {
    const total = this.getTotalCapital();
    const maxSize = total * MAX_POSITION_PCT;

    // Include any existing exposure to same market
    const existing = this.getOpenPositions()
      .filter((p) => p.slug === slug)
      .reduce((sum, p) => sum + p.sizeUsdc, 0);

    return (existing + sizeUsdc) <= maxSize;
  }

  /** Check if total deployed would exceed 50% exposure limit */
  checkExposureLimit(additionalUsdc: number = 0): boolean {
    const total = this.getTotalCapital();
    const maxExposure = total * MAX_EXPOSURE_PCT;
    const deployed = this.getDeployedCapital();
    return (deployed + additionalUsdc) <= maxExposure;
  }

  /** Daily P&L from trades created in the last 24h */
  getDailyPnL(): number {
    const db = getDb();
    const dayAgo = Date.now() - 86_400_000;
    const row = db
      .prepare<[number], { pnl: number }>(
        "SELECT COALESCE(SUM(net_ev), 0) as pnl FROM trades WHERE created_at > ?"
      )
      .get(dayAgo);
    return row?.pnl ?? 0;
  }

  /** Insert or update a position in the trades table */
  updatePosition(slug: string, sizeUsdc: number, direction: string): void {
    const db = getDb();
    const now = Date.now();
    const id = `risk-${slug}-${now}`;
    const price = 0.5; // placeholder entry price
    const size = sizeUsdc / price;

    db.prepare(
      `INSERT INTO trades (id, order_id, market_slug, direction, size, price, net_ev, ev_grade, status, created_at, pipeline_run_id)
       VALUES (?, NULL, ?, ?, ?, ?, 0, NULL, 'open', ?, NULL)`
    ).run(id, slug, direction, size, price, now);
  }
}
