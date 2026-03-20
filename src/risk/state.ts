import { getDb } from "../db/schema";
import { isPgEnabled, pgExec, pgQueryOne } from "../db/postgres";

export type PersistedCircuitBreakerState = "ARMED" | "WARNING" | "TRIGGERED";

export interface CircuitBreakerStateRow {
  id: number;
  state: PersistedCircuitBreakerState;
  drawdown_pct: number;
  triggered_at: number | null;
  last_checked_at: number;
}

export const DEFAULT_RISK_CONFIGURATION_ID = "rc-default-001";
export const DEFAULT_GLOBAL_CIRCUIT_BREAKER_ID = "gcb-default-001";

function defaultCircuitBreakerState(): CircuitBreakerStateRow {
  return {
    id: 1,
    state: "ARMED",
    drawdown_pct: 0,
    triggered_at: null,
    last_checked_at: Date.now(),
  };
}

export function ensureSqliteRiskState(): void {
  if (isPgEnabled()) return;

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

  db.prepare(
    `INSERT OR IGNORE INTO circuit_breaker_state (id, state, drawdown_pct, triggered_at, last_checked_at)
     VALUES (1, 'ARMED', 0, NULL, ?)`
  ).run(Date.now());
}

export async function loadCircuitBreakerState(): Promise<CircuitBreakerStateRow> {
  if (isPgEnabled()) {
    const row = await pgQueryOne<CircuitBreakerStateRow>(
      `SELECT id, state, drawdown_pct, triggered_at, last_checked_at
       FROM circuit_breaker_state
       WHERE id = 1`
    );
    return row ?? defaultCircuitBreakerState();
  }

  ensureSqliteRiskState();
  const db = getDb();
  const row = db.prepare<[], CircuitBreakerStateRow>(
    `SELECT id, state, drawdown_pct, triggered_at, last_checked_at
     FROM circuit_breaker_state
     WHERE id = 1`
  ).get();
  return row ?? defaultCircuitBreakerState();
}

export async function isPanicModeEnabled(): Promise<boolean> {
  if (isPgEnabled()) {
    const row = await pgQueryOne<{ panic_mode_enabled: number }>(
      `SELECT panic_mode_enabled
       FROM global_circuit_breakers
       WHERE id = $1
       LIMIT 1`,
      [DEFAULT_GLOBAL_CIRCUIT_BREAKER_ID]
    );
    return row?.panic_mode_enabled === 1;
  }

  const db = getDb();
  const row = db.prepare<[], { panic_mode_enabled: number }>(
    `SELECT panic_mode_enabled
     FROM global_circuit_breakers
     WHERE id = 'gcb-default-001'
     LIMIT 1`
  ).get();
  return row?.panic_mode_enabled === 1;
}

export async function setPanicModeEnabled(enabled: boolean, updatedAt: number): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      `UPDATE global_circuit_breakers
       SET panic_mode_enabled = $1, updated_at = $2
       WHERE id = $3`,
      [enabled ? 1 : 0, updatedAt, DEFAULT_GLOBAL_CIRCUIT_BREAKER_ID]
    );
    return;
  }

  const db = getDb();
  db.prepare(
    `UPDATE global_circuit_breakers
     SET panic_mode_enabled = ?, updated_at = ?
     WHERE id = 'gcb-default-001'`
  ).run(enabled ? 1 : 0, updatedAt);
}

export async function updateCircuitBreakerAfterCheck(
  state: PersistedCircuitBreakerState,
  drawdownPct: number,
  now: number,
): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO circuit_breaker_state (id, state, drawdown_pct, triggered_at, last_checked_at)
       VALUES (1, $1, $2, CASE WHEN $1 = 'TRIGGERED' THEN $3::BIGINT ELSE NULL END, $3::BIGINT)
       ON CONFLICT (id) DO UPDATE
       SET state = EXCLUDED.state,
           drawdown_pct = EXCLUDED.drawdown_pct,
           triggered_at = CASE
             WHEN EXCLUDED.state = 'TRIGGERED' AND circuit_breaker_state.state != 'TRIGGERED' THEN EXCLUDED.last_checked_at
             ELSE circuit_breaker_state.triggered_at
           END,
           last_checked_at = EXCLUDED.last_checked_at`,
      [state, drawdownPct, now]
    );
    return;
  }

  ensureSqliteRiskState();
  const db = getDb();
  db.prepare(
    `UPDATE circuit_breaker_state
     SET state = ?, drawdown_pct = ?, triggered_at = CASE WHEN ? = 'TRIGGERED' AND state != 'TRIGGERED' THEN ? ELSE triggered_at END, last_checked_at = ?
     WHERE id = 1`
  ).run(state, drawdownPct, state, now, now);
}

export async function tripCircuitBreaker(now: number, drawdownPct?: number | null): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO circuit_breaker_state (id, state, drawdown_pct, triggered_at, last_checked_at)
       VALUES (1, 'TRIGGERED', COALESCE($2, 0), $1, $1)
       ON CONFLICT (id) DO UPDATE
       SET state = 'TRIGGERED',
           drawdown_pct = COALESCE($2, circuit_breaker_state.drawdown_pct),
           triggered_at = $1,
           last_checked_at = $1`,
      [now, drawdownPct ?? null]
    );
    return;
  }

  ensureSqliteRiskState();
  const db = getDb();
  db.prepare(
    `UPDATE circuit_breaker_state
     SET state = 'TRIGGERED',
         drawdown_pct = COALESCE(?, drawdown_pct),
         triggered_at = ?,
         last_checked_at = ?
     WHERE id = 1`
  ).run(drawdownPct ?? null, now, now);
}

export async function armCircuitBreaker(now: number): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO circuit_breaker_state (id, state, drawdown_pct, triggered_at, last_checked_at)
       VALUES (1, 'ARMED', 0, NULL, $1)
       ON CONFLICT (id) DO UPDATE
       SET state = 'ARMED',
           drawdown_pct = 0,
           triggered_at = NULL,
           last_checked_at = $1`,
      [now]
    );
    return;
  }

  ensureSqliteRiskState();
  const db = getDb();
  db.prepare(
    `UPDATE circuit_breaker_state
     SET state = 'ARMED', drawdown_pct = 0, triggered_at = NULL, last_checked_at = ?
     WHERE id = 1`
  ).run(now);
}

export async function resetRiskState(now: number): Promise<void> {
  await setPanicModeEnabled(false, now);
  await armCircuitBreaker(now);
}
