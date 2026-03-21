import { getDb } from "./schema";
import { isPgEnabled, pgQuery, pgQueryOne, pgExec } from "./postgres";

// ── Types ──────────────────────────────────────────────────────

export interface RiskConfigRow {
  id: string;
  user_id: string;
  version: number;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export interface AgentThresholdRow {
  id: string;
  risk_configuration_id: string;
  agent_name: string;
  agent_status: string;
  var_threshold: number;
  auto_exec_enabled: number;
  created_at: number;
  updated_at: number;
}

export interface GlobalCircuitBreakerRow {
  id: string;
  risk_configuration_id: string;
  panic_mode_enabled: number;
  drawdown_limit_pct: number;
  max_position_size_pct: number;
  kelly_fraction_multiplier: number;
  created_at: number;
  updated_at: number;
}

export interface PanicModeEventRow {
  id: string;
  request_code: string;
  status: string;
  reason: string | null;
  pending_orders_count: number;
  active_positions_count: number;
  estimated_total_value: number;
  cooldown_until: number | null;
  rearmed_at: number | null;
  initiated_at: number;
  completed_at: number | null;
}

export interface LiquidationReportRow {
  id: string;
  report_code: string;
  panic_mode_event_id: string;
  status: string;
  completion_timestamp: number | null;
  total_realized_value: number | null;
  slippage_pct: number | null;
  gas_execution_cost: number | null;
  recovery_status: string | null;
}

export interface LiquidationLineItemRow {
  id: string;
  liquidation_report_id: string;
  asset_symbol: string;
  asset_label: string;
  execution_price: number;
  trigger_price: number;
  size: number;
  size_unit: string;
  pnl_impact: number;
}

export interface OpenPositionRow {
  id: string;
  slug: string;
  side: string;
  direction: string | null;
  amount: number;
  fill_price: number | null;
  order_id: string | null;
  status: string;
}

export interface LiquidationLineItemInput {
  id: string;
  liquidationReportId: string;
  assetSymbol: string;
  assetLabel: string;
  executionPrice: number;
  triggerPrice: number;
  size: number;
  sizeUnit: string;
  pnlImpact: number;
}

export interface LiquidationUpdate {
  executionId: string;
  pnl: number;
}

// ── Panic Mode Events ──────────────────────────────────────────

export async function getLatestPanicModeEvent(): Promise<PanicModeEventRow | null> {
  if (isPgEnabled()) {
    return pgQueryOne<PanicModeEventRow>(
      "SELECT * FROM panic_mode_events ORDER BY initiated_at DESC LIMIT 1"
    );
  }
  const db = getDb();
  return (
    db.prepare<[], PanicModeEventRow>(
      "SELECT * FROM panic_mode_events ORDER BY initiated_at DESC LIMIT 1"
    ).get() ?? null
  );
}

export async function getReportIdForEvent(eventId: string): Promise<string | null> {
  if (isPgEnabled()) {
    const row = await pgQueryOne<{ id: string }>(
      "SELECT id FROM liquidation_reports WHERE panic_mode_event_id = $1 ORDER BY completion_timestamp DESC LIMIT 1",
      [eventId]
    );
    return row?.id ?? null;
  }
  const db = getDb();
  const row = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM liquidation_reports WHERE panic_mode_event_id = ? ORDER BY completion_timestamp DESC LIMIT 1"
    )
    .get(eventId);
  return row?.id ?? null;
}

export async function insertPanicModeEvent(event: {
  id: string;
  requestCode: string;
  reason: string;
  pendingOrdersCount: number;
  activePositionsCount: number;
  estimatedTotalValue: number;
  cooldownUntil: number;
  initiatedAt: number;
}): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(`
      INSERT INTO panic_mode_events
        (id, request_code, status, reason, pending_orders_count, active_positions_count, estimated_total_value, cooldown_until, initiated_at)
      VALUES ($1, $2, 'processing', $3, $4, $5, $6, $7, $8)
    `, [event.id, event.requestCode, event.reason, event.pendingOrdersCount, event.activePositionsCount, event.estimatedTotalValue, event.cooldownUntil, event.initiatedAt]);
    return;
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO panic_mode_events
      (id, request_code, status, reason, pending_orders_count, active_positions_count, estimated_total_value, cooldown_until, initiated_at)
    VALUES (?, ?, 'processing', ?, ?, ?, ?, ?, ?)
  `).run(event.id, event.requestCode, event.reason, event.pendingOrdersCount, event.activePositionsCount, event.estimatedTotalValue, event.cooldownUntil, event.initiatedAt);
}

export async function finalizePanicModeEvent(
  eventId: string, status: string, completedAt: number
): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      "UPDATE panic_mode_events SET status = $1, completed_at = $2 WHERE id = $3",
      [status, completedAt, eventId]
    );
    return;
  }
  const db = getDb();
  db.prepare(
    "UPDATE panic_mode_events SET status = ?, completed_at = ? WHERE id = ?"
  ).run(status, completedAt, eventId);
}

export async function rearmPanicModeEvent(eventId: string, rearmedAt: number): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      "UPDATE panic_mode_events SET rearmed_at = $1, status = CASE WHEN status = 'processing' THEN 'rearmed' ELSE status END WHERE id = $2",
      [rearmedAt, eventId]
    );
    return;
  }
  const db = getDb();
  db.prepare(
    "UPDATE panic_mode_events SET rearmed_at = ?, status = CASE WHEN status = 'processing' THEN 'rearmed' ELSE status END WHERE id = ?"
  ).run(rearmedAt, eventId);
}

export async function getPanicModeEventById(id: string): Promise<PanicModeEventRow | null> {
  if (isPgEnabled()) {
    return pgQueryOne<PanicModeEventRow>(
      "SELECT * FROM panic_mode_events WHERE id = $1",
      [id]
    );
  }
  const db = getDb();
  return (
    db.prepare<[string], PanicModeEventRow>(
      "SELECT * FROM panic_mode_events WHERE id = ?"
    ).get(id) ?? null
  );
}

// ── Liquidation Reports ────────────────────────────────────────

export async function insertLiquidationReport(report: {
  id: string;
  reportCode: string;
  panicModeEventId: string;
}): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(`
      INSERT INTO liquidation_reports
        (id, report_code, panic_mode_event_id, status, total_realized_value, slippage_pct, gas_execution_cost, recovery_status)
      VALUES ($1, $2, $3, 'processing', NULL, NULL, NULL, 'pending')
    `, [report.id, report.reportCode, report.panicModeEventId]);
    return;
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO liquidation_reports
      (id, report_code, panic_mode_event_id, status, total_realized_value, slippage_pct, gas_execution_cost, recovery_status)
    VALUES (?, ?, ?, 'processing', NULL, NULL, NULL, 'pending')
  `).run(report.id, report.reportCode, report.panicModeEventId);
}

export async function finalizeLiquidationReport(
  reportId: string, status: string, completedAt: number,
  totalRealizedValue: number, recoveryStatus: string
): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      "UPDATE liquidation_reports SET status = $1, completion_timestamp = $2, total_realized_value = $3, slippage_pct = 0, gas_execution_cost = 0, recovery_status = $4 WHERE id = $5",
      [status, completedAt, totalRealizedValue, recoveryStatus, reportId]
    );
    return;
  }
  const db = getDb();
  db.prepare(
    "UPDATE liquidation_reports SET status = ?, completion_timestamp = ?, total_realized_value = ?, slippage_pct = 0, gas_execution_cost = 0, recovery_status = ? WHERE id = ?"
  ).run(status, completedAt, totalRealizedValue, recoveryStatus, reportId);
}

export async function getLiquidationReportById(id: string): Promise<LiquidationReportRow | null> {
  if (isPgEnabled()) {
    return pgQueryOne<LiquidationReportRow>(
      "SELECT * FROM liquidation_reports WHERE id = $1",
      [id]
    );
  }
  const db = getDb();
  return (
    db.prepare<[string], LiquidationReportRow>(
      "SELECT * FROM liquidation_reports WHERE id = ?"
    ).get(id) ?? null
  );
}

export async function getLiquidationLineItems(reportId: string): Promise<LiquidationLineItemRow[]> {
  if (isPgEnabled()) {
    return pgQuery<LiquidationLineItemRow>(
      "SELECT * FROM liquidation_line_items WHERE liquidation_report_id = $1",
      [reportId]
    );
  }
  const db = getDb();
  return db
    .prepare<[string], LiquidationLineItemRow>(
      "SELECT * FROM liquidation_line_items WHERE liquidation_report_id = ?"
    )
    .all(reportId);
}

// ── Batch Operations (N+1 fix) ─────────────────────────────────

export async function insertLiquidationLineItemsBatch(
  items: LiquidationLineItemInput[]
): Promise<void> {
  if (items.length === 0) return;

  if (isPgEnabled()) {
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const item of items) {
      values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8})`);
      params.push(
        item.id, item.liquidationReportId, item.assetSymbol,
        item.assetLabel, item.executionPrice, item.triggerPrice,
        item.size, item.sizeUnit, item.pnlImpact
      );
      idx += 9;
    }
    await pgExec(
      `INSERT INTO liquidation_line_items
        (id, liquidation_report_id, asset_symbol, asset_label, execution_price, trigger_price, size, size_unit, pnl_impact)
       VALUES ${values.join(", ")}`,
      params
    );
  } else {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO liquidation_line_items
        (id, liquidation_report_id, asset_symbol, asset_label, execution_price, trigger_price, size, size_unit, pnl_impact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const item of items) {
        insert.run(
          item.id, item.liquidationReportId, item.assetSymbol,
          item.assetLabel, item.executionPrice, item.triggerPrice,
          item.size, item.sizeUnit, item.pnlImpact
        );
      }
    });
    tx();
  }
}

export async function liquidateExecutionsBatch(updates: LiquidationUpdate[]): Promise<void> {
  if (updates.length === 0) return;

  if (isPgEnabled()) {
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const u of updates) {
      values.push(`($${idx}::TEXT, $${idx + 1}::NUMERIC)`);
      params.push(u.executionId, u.pnl);
      idx += 2;
    }
    await pgExec(
      `UPDATE executions SET status = 'liquidated', pnl = v.pnl
       FROM (VALUES ${values.join(", ")}) AS v(id, pnl)
       WHERE executions.id = v.id`,
      params
    );
  } else {
    const db = getDb();
    const update = db.prepare(
      "UPDATE executions SET status = 'liquidated', pnl = ? WHERE id = ?"
    );
    const tx = db.transaction(() => {
      for (const u of updates) {
        update.run(u.pnl, u.executionId);
      }
    });
    tx();
  }
}

// ── Positions + Orders ─────────────────────────────────────────

export async function getOpenExecutions(): Promise<OpenPositionRow[]> {
  if (isPgEnabled()) {
    return pgQuery<OpenPositionRow>(
      "SELECT id, slug, side, direction, amount, fill_price, order_id, status FROM executions WHERE status IN ('placed', 'paper', 'submitted') AND pnl IS NULL"
    );
  }
  const db = getDb();
  return db.prepare<[], OpenPositionRow>(
    "SELECT id, slug, side, direction, amount, fill_price, order_id, status FROM executions WHERE status IN ('placed', 'paper', 'submitted') AND pnl IS NULL"
  ).all();
}

export async function getCurrentPrices(): Promise<Map<string, number>> {
  let rows: { slug: string; probability: number }[];
  if (isPgEnabled()) {
    rows = await pgQuery<{ slug: string; probability: number }>(
      "SELECT DISTINCT ON (slug) slug, probability FROM scanner_results ORDER BY slug, scanned_at DESC"
    );
  } else {
    const db = getDb();
    rows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as { slug: string; probability: number }[];
  }
  return new Map(rows.map((r) => [r.slug, r.probability]));
}

export async function cancelPaperOrders(): Promise<number> {
  if (isPgEnabled()) {
    return pgExec("UPDATE paper_orders SET status = 'cancelled' WHERE status = 'open'");
  }
  const db = getDb();
  return db.prepare("UPDATE paper_orders SET status = 'cancelled' WHERE status = 'open'").run().changes;
}

export async function disableAllAutopilots(now: number): Promise<void> {
  if (isPgEnabled()) {
    await pgExec("UPDATE agents SET autopilot_enabled = 0, updated_at = $1 WHERE autopilot_enabled = 1", [now]);
    return;
  }
  const db = getDb();
  db.prepare("UPDATE agents SET autopilot_enabled = 0, updated_at = ? WHERE autopilot_enabled = 1").run(now);
}

// ── Risk Config ────────────────────────────────────────────────

export async function getActiveRiskConfig(): Promise<{
  config: RiskConfigRow;
  thresholds: AgentThresholdRow[];
  circuitBreaker: GlobalCircuitBreakerRow | null;
} | null> {
  if (isPgEnabled()) {
    const config = await pgQueryOne<RiskConfigRow>(
      "SELECT * FROM risk_configurations WHERE is_active = 1 LIMIT 1"
    );
    if (!config) return null;
    const thresholds = await pgQuery<AgentThresholdRow>(
      "SELECT * FROM agent_thresholds WHERE risk_configuration_id = $1",
      [config.id]
    );
    const circuitBreaker = await pgQueryOne<GlobalCircuitBreakerRow>(
      "SELECT * FROM global_circuit_breakers WHERE risk_configuration_id = $1 LIMIT 1",
      [config.id]
    );
    return { config, thresholds, circuitBreaker: circuitBreaker ?? null };
  }

  const db = getDb();
  const config = db
    .prepare<[], RiskConfigRow>(
      "SELECT * FROM risk_configurations WHERE is_active = 1 LIMIT 1"
    )
    .get();
  if (!config) return null;

  const thresholds = db
    .prepare<[string], AgentThresholdRow>(
      "SELECT * FROM agent_thresholds WHERE risk_configuration_id = ?"
    )
    .all(config.id);

  const circuitBreaker = db
    .prepare<[string], GlobalCircuitBreakerRow>(
      "SELECT * FROM global_circuit_breakers WHERE risk_configuration_id = ? LIMIT 1"
    )
    .get(config.id);

  return { config, thresholds, circuitBreaker: circuitBreaker ?? null };
}

export async function getActiveCircuitBreakerAndThresholds(): Promise<{
  circuitBreaker: GlobalCircuitBreakerRow | null;
  thresholds: AgentThresholdRow[];
}> {
  if (isPgEnabled()) {
    const cb = await pgQueryOne<GlobalCircuitBreakerRow>(
      `SELECT gcb.*
       FROM global_circuit_breakers gcb
       JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 LIMIT 1`
    );
    const thresholds = await pgQuery<AgentThresholdRow>(
      `SELECT at.*
       FROM agent_thresholds at
       JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
       WHERE rc.is_active = 1`
    );
    return { circuitBreaker: cb ?? null, thresholds };
  }

  const db = getDb();
  const cb = db
    .prepare<[], GlobalCircuitBreakerRow>(
      `SELECT gcb.*
       FROM global_circuit_breakers gcb
       JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 LIMIT 1`
    )
    .get();

  const thresholds = db
    .prepare<[], AgentThresholdRow>(
      `SELECT at.*
       FROM agent_thresholds at
       JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
       WHERE rc.is_active = 1`
    )
    .all();

  return { circuitBreaker: cb ?? null, thresholds };
}

export async function updateRiskConfig(params: {
  agentVarThreshold: number;
  maxPositionSize: number;
  drawdownLimit: number;
  kellyMultiplier: number;
  now: number;
}): Promise<void> {
  const { agentVarThreshold, maxPositionSize, drawdownLimit, kellyMultiplier, now } = params;

  if (isPgEnabled()) {
    await pgExec(
      `UPDATE global_circuit_breakers
       SET max_position_size_pct = $1, drawdown_limit_pct = $2, kelly_fraction_multiplier = $3, updated_at = $4
       WHERE id = 'gcb-default-001'`,
      [maxPositionSize, drawdownLimit, kellyMultiplier, now]
    );
    await pgExec(
      `UPDATE agent_thresholds SET var_threshold = $1, updated_at = $2
       WHERE risk_configuration_id = 'rc-default-001'`,
      [agentVarThreshold, now]
    );
    await pgExec(
      `UPDATE risk_configurations SET version = version + 1, updated_at = $1
       WHERE id = 'rc-default-001'`,
      [now]
    );
    return;
  }

  const db = getDb();
  db.prepare(
    `UPDATE global_circuit_breakers
     SET max_position_size_pct = ?, drawdown_limit_pct = ?, kelly_fraction_multiplier = ?, updated_at = ?
     WHERE id = 'gcb-default-001'`
  ).run(maxPositionSize, drawdownLimit, kellyMultiplier, now);

  db.prepare(
    `UPDATE agent_thresholds SET var_threshold = ?, updated_at = ?
     WHERE risk_configuration_id = 'rc-default-001'`
  ).run(agentVarThreshold, now);

  db.prepare(
    `UPDATE risk_configurations SET version = version + 1, updated_at = ?
     WHERE id = 'rc-default-001'`
  ).run(now);
}
