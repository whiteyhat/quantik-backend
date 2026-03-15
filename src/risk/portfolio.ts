import { getDb } from "../db/schema";
import { getUsdcBalance, getClobBalance } from "../utils/balances";
import { tryLoadActiveAgentContext } from "../utils/agentKey";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerDirectionMap,
} from "../utils/executionDirection";

// ── Types ──────────────────────────────────────────────────────

interface ExecutionRow {
  id: number;
  slug: string;
  side: string;
  direction: string | null;
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
  async getOpenPositions(): Promise<Position[]> {
    const db = getDb();
    const rows = db
      .prepare<[], ExecutionRow>(
        "SELECT * FROM executions WHERE status IN ('placed', 'paper', 'submitted') AND pnl IS NULL ORDER BY executed_at DESC"
      )
      .all();

    // Fetch current prices from scanner_results for open P&L
    const priceRows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as any[];
    const currentPrices = new Map(priceRows.map(r => [r.slug, r.probability]));
    const scannerDirections = await getLatestScannerDirectionMap();

    return rows.map((r) => {
      const scannerDirection = scannerDirections.get(r.slug);
      const currentYes = currentPrices.get(r.slug) ?? getEntryYesPrice(r, scannerDirection);
      const metrics = calculateOpenExecutionMetrics(r, currentYes, scannerDirection);

      return {
        slug: r.slug,
        direction: metrics.direction,
        sizeUsdc: r.amount,
        entryPrice: metrics.entryTokenPrice,
        openPnl: metrics.pnl,
        createdAt: r.executed_at,
      };
    });
  }

  /** Total Portfolio Value: On-chain + Deployed (unified async source) */
  async getTotalCapital(): Promise<number> {
    const agentCtx = await tryLoadActiveAgentContext();
    const [onChain, clob] = await Promise.all([
      getUsdcBalance(agentCtx?.walletAddress),
      getClobBalance(agentCtx?.privateKey),
    ]);
    const deployed = await this.getDeployedCapital();
    const openPnl = (await this.getOpenPositions()).reduce((sum, p) => sum + p.openPnl, 0);

    const total = onChain + clob + deployed + openPnl;
    if (total <= 0) {
      console.warn("[PortfolioManager] getTotalCapital resolved to 0 — wallet RPC or CLOB balance may be unreachable");
    }
    return total;
  }

  /** Capital not currently deployed in open positions */
  async getAvailableCapital(): Promise<number> {
    const agentCtx = await tryLoadActiveAgentContext();
    const [onChain, clob] = await Promise.all([
      getUsdcBalance(agentCtx?.walletAddress),
      getClobBalance(agentCtx?.privateKey),
    ]);
    return onChain + clob;
  }

  /** Total USDC currently in open positions */
  async getDeployedCapital(): Promise<number> {
    const positions = await this.getOpenPositions();
    return positions.reduce((sum, p) => sum + p.sizeUsdc, 0);
  }

  /** Check if a new position would exceed the 5% per-market limit */
  async checkPositionLimit(slug: string, sizeUsdc: number): Promise<boolean> {
    const total = await this.getTotalCapital();
    const maxSize = total * MAX_POSITION_PCT;
    const existing = (await this.getOpenPositions())
      .filter((p) => p.slug === slug)
      .reduce((sum, p) => sum + p.sizeUsdc, 0);
    return (existing + sizeUsdc) <= maxSize;
  }

  /** Check if total deployed would exceed 50% exposure limit */
  async checkExposureLimit(additionalUsdc: number = 0): Promise<boolean> {
    const total = await this.getTotalCapital();
    const maxExposure = total * MAX_EXPOSURE_PCT;
    const deployed = await this.getDeployedCapital();
    return (deployed + additionalUsdc) <= maxExposure;
  }

  /** Daily P&L from realized trades closed today + unrealized on ALL open positions */
  async getDailyPnL(): Promise<number> {
    const db = getDb();
    const todayStart = new Date().setUTCHours(0, 0, 0, 0);

    // Realized: trades that settled today
    const { realized } = db.prepare("SELECT COALESCE(SUM(pnl), 0) as realized FROM executions WHERE executed_at >= ? AND pnl IS NOT NULL").get(todayStart) as { realized: number };

    // Unrealized: ALL open positions (not just today's), since price moves affect daily P&L
    const openPositions = await this.getOpenPositions();
    const unrealized = openPositions.reduce((sum, p) => sum + p.openPnl, 0);

    return realized + unrealized;
  }
}
