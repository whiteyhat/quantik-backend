import { getDb } from "../db/schema";

// ── Types ──────────────────────────────────────────────────────

interface ExecutionRow {
  id: number;
  slug: string;
  side: string;
  amount: number;
  executed_at: number;
  status: string;
  fill_price: number | null;
  pnl: number | null;
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
  /** All open/submitted positions from executions table (unsettled trades) */
  getOpenPositions(): Position[] {
    const db = getDb();
    const rows = db
      .prepare<[], ExecutionRow>(
        "SELECT * FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL ORDER BY executed_at DESC"
      )
      .all();

    // Fetch current prices from scanner_results for open P&L
    const priceRows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as any[];
    const currentPrices = new Map(priceRows.map(r => [r.slug, r.probability]));

    return rows.map((r) => {
      const current = currentPrices.get(r.slug) ?? r.fill_price ?? 0.5;
      const entry = r.fill_price ?? 0.5;
      const shares = entry > 0 ? r.amount / entry : 0;
      const pnl = r.side === "buy" ? (current - entry) * shares : (entry - current) * shares;

      return {
        slug: r.slug,
        direction: r.side === "buy" ? "YES" : "NO",
        sizeUsdc: r.amount,
        entryPrice: entry,
        openPnl: pnl,
        createdAt: r.executed_at,
      };
    });
  }

  /** Total Portfolio Value: On-chain + Deployed (approximate) */
  getTotalCapital(): number {
    const db = getDb();
    // In production we'd call the wallet RPC, here we use a proxy from settings or historical max
    // Use $3000 as a base for calculations if empty
    return 3000; 
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

  /** Daily P&L from realized + unrealized trades today */
  getDailyPnL(): number {
    const db = getDb();
    const todayStart = new Date().setUTCHours(0, 0, 0, 0);
    
    // Realized
    const { realized } = db.prepare("SELECT COALESCE(SUM(pnl), 0) as realized FROM executions WHERE executed_at >= ? AND pnl IS NOT NULL").get(todayStart) as { realized: number };
    
    // Unrealized
    const openPositions = this.getOpenPositions().filter(p => p.createdAt >= todayStart);
    const unrealized = openPositions.reduce((sum, p) => sum + p.openPnl, 0);

    return realized + unrealized;
  }

  /** Insert a position into the executions table (for risk tracking only) */
  updatePosition(slug: string, sizeUsdc: number, direction: string): void {
    // This is now redundant as MarketScanner handles insertion into executions
  }
}
