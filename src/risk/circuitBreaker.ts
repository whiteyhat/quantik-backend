import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import {
  ensureSqliteRiskState,
  loadCircuitBreakerState,
  resetRiskState,
  updateCircuitBreakerAfterCheck,
} from "./state";
import { PortfolioManager } from "./portfolio";

// ── Types ──────────────────────────────────────────────────────

export type CircuitBreakerState = "ARMED" | "WARNING" | "TRIGGERED";

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  drawdownPct: number;
  triggered: boolean;
  lastCheckedAt: number;
}

// ── Thresholds ─────────────────────────────────────────────────

const DEFAULT_WARNING_DRAWDOWN = 0.075;
const DEFAULT_TRIGGER_DRAWDOWN = 0.10;

/** Read drawdown limit from DB config; derive WARNING at 75% of limit, TRIGGER at limit */
async function getDrawdownThresholds(): Promise<{ warning: number; trigger: number }> {
  try {
    if (isPgEnabled()) {
      const row = await pgQueryOne<{ drawdown_limit_pct: number }>(
        `SELECT gcb.drawdown_limit_pct
         FROM global_circuit_breakers gcb
         JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
         WHERE rc.is_active = 1
         LIMIT 1`
      );
      if (row) {
        const limit = row.drawdown_limit_pct;
        return { warning: limit * 0.75, trigger: limit };
      }
    } else {
      const db = getDb();
      const row = db.prepare<[], { drawdown_limit_pct: number }>(
        `SELECT gcb.drawdown_limit_pct
         FROM global_circuit_breakers gcb
         JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
         WHERE rc.is_active = 1 LIMIT 1`
      ).get();
      if (row) {
        const limit = row.drawdown_limit_pct;
        return { warning: limit * 0.75, trigger: limit };
      }
    }
  } catch {
    // Fall back to defaults when configuration is unavailable.
  }
  return { warning: DEFAULT_WARNING_DRAWDOWN, trigger: DEFAULT_TRIGGER_DRAWDOWN };
}

// ── Schema migration ───────────────────────────────────────────

export function ensureCircuitBreakerTable(): void {
  ensureSqliteRiskState();
}

// ── CircuitBreaker ─────────────────────────────────────────────

export class CircuitBreaker {
  private portfolio: PortfolioManager;

  constructor() {
    this.portfolio = new PortfolioManager();
    ensureCircuitBreakerTable();
  }

  /** Get current circuit breaker status */
  async getStatus(): Promise<CircuitBreakerStatus> {
    const row = await loadCircuitBreakerState();

    return {
      state: row.state as CircuitBreakerState,
      drawdownPct: row.drawdown_pct,
      triggered: row.state === "TRIGGERED",
      lastCheckedAt: row.last_checked_at,
    };
  }

  /** Check daily drawdown and auto-trip if thresholds exceeded */
  async checkAndTrip(): Promise<CircuitBreakerStatus> {
    const dailyPnl = await this.portfolio.getDailyPnL();
    const totalCapital = await this.portfolio.getTotalCapital();
    const drawdownPct = totalCapital > 0 ? Math.abs(Math.min(dailyPnl, 0)) / totalCapital : 0;
    const now = Date.now();
    const { warning, trigger } = await getDrawdownThresholds();

    // Determine new state based on drawdown
    let newState: CircuitBreakerState;
    if (drawdownPct >= trigger) {
      newState = "TRIGGERED";
    } else if (drawdownPct >= warning) {
      newState = "WARNING";
    } else {
      // Only go back to ARMED if currently not TRIGGERED (manual reset required)
      const current = await this.getStatus();
      newState = current.state === "TRIGGERED" ? "TRIGGERED" : "ARMED";
    }

    await updateCircuitBreakerAfterCheck(newState, drawdownPct, now);

    return {
      state: newState,
      drawdownPct,
      triggered: newState === "TRIGGERED",
      lastCheckedAt: now,
    };
  }

  /** Manual reset — only way to go from TRIGGERED back to ARMED */
  async reset(): Promise<void> {
    await resetRiskState(Date.now());
  }
}
