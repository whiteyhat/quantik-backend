import { getDb } from "../db/schema";
import { PortfolioManager } from "./portfolio";

// ── Types ──────────────────────────────────────────────────────

export type CircuitBreakerState = "ARMED" | "WARNING" | "TRIGGERED";

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  drawdownPct: number;
  triggered: boolean;
  lastCheckedAt: number;
}

interface CircuitBreakerRow {
  id: number;
  state: string;
  drawdown_pct: number;
  triggered_at: number | null;
  last_checked_at: number;
}

// ── Thresholds ─────────────────────────────────────────────────

const WARNING_DRAWDOWN = 0.075;   // 7.5% daily drawdown → WARNING
const TRIGGER_DRAWDOWN = 0.10;    // 10% daily drawdown → TRIGGERED

// ── Schema migration ───────────────────────────────────────────

export function ensureCircuitBreakerTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS circuit_breaker_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'ARMED',
      drawdown_pct REAL NOT NULL DEFAULT 0,
      triggered_at INTEGER,
      last_checked_at INTEGER NOT NULL
    )
  `);

  // Seed default row
  const existing = db
    .prepare<[], { id: number }>("SELECT id FROM circuit_breaker_state WHERE id = 1")
    .get();

  if (!existing) {
    db.prepare(
      "INSERT INTO circuit_breaker_state (id, state, drawdown_pct, triggered_at, last_checked_at) VALUES (1, 'ARMED', 0, NULL, ?)"
    ).run(Date.now());
  }
}

// ── CircuitBreaker ─────────────────────────────────────────────

export class CircuitBreaker {
  private portfolio: PortfolioManager;

  constructor() {
    this.portfolio = new PortfolioManager();
    ensureCircuitBreakerTable();
  }

  /** Get current circuit breaker status */
  getStatus(): CircuitBreakerStatus {
    const db = getDb();
    const row = db
      .prepare<[], CircuitBreakerRow>("SELECT * FROM circuit_breaker_state WHERE id = 1")
      .get();

    if (!row) {
      return {
        state: "ARMED",
        drawdownPct: 0,
        triggered: false,
        lastCheckedAt: Date.now(),
      };
    }

    return {
      state: row.state as CircuitBreakerState,
      drawdownPct: row.drawdown_pct,
      triggered: row.state === "TRIGGERED",
      lastCheckedAt: row.last_checked_at,
    };
  }

  /** Check daily drawdown and auto-trip if thresholds exceeded */
  checkAndTrip(): CircuitBreakerStatus {
    const db = getDb();
    const dailyPnl = this.portfolio.getDailyPnL();
    const totalCapital = this.portfolio.getTotalCapital();
    const drawdownPct = totalCapital > 0 ? Math.abs(Math.min(dailyPnl, 0)) / totalCapital : 0;
    const now = Date.now();

    // Determine new state based on drawdown
    let newState: CircuitBreakerState;
    if (drawdownPct >= TRIGGER_DRAWDOWN) {
      newState = "TRIGGERED";
    } else if (drawdownPct >= WARNING_DRAWDOWN) {
      newState = "WARNING";
    } else {
      // Only go back to ARMED if currently not TRIGGERED (manual reset required)
      const current = this.getStatus();
      newState = current.state === "TRIGGERED" ? "TRIGGERED" : "ARMED";
    }

    // Persist state
    db.prepare(
      `UPDATE circuit_breaker_state
       SET state = ?, drawdown_pct = ?, triggered_at = CASE WHEN ? = 'TRIGGERED' AND state != 'TRIGGERED' THEN ? ELSE triggered_at END, last_checked_at = ?
       WHERE id = 1`
    ).run(newState, drawdownPct, newState, now, now);

    return {
      state: newState,
      drawdownPct,
      triggered: newState === "TRIGGERED",
      lastCheckedAt: now,
    };
  }

  /** Manual reset — only way to go from TRIGGERED back to ARMED */
  reset(): void {
    const db = getDb();
    db.prepare(
      "UPDATE circuit_breaker_state SET state = 'ARMED', drawdown_pct = 0, triggered_at = NULL, last_checked_at = ? WHERE id = 1"
    ).run(Date.now());
  }
}
