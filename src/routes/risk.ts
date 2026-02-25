import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";

const router = Router();

// ── Types ──────────────────────────────────────────────────────

interface RiskConfigRow {
  id: string;
  user_id: string;
  version: number;
  is_active: number;
  created_at: number;
  updated_at: number;
}

interface AgentThresholdRow {
  id: string;
  risk_configuration_id: string;
  agent_name: string;
  agent_status: string;
  var_threshold: number;
  auto_exec_enabled: number;
  created_at: number;
  updated_at: number;
}

interface GlobalCircuitBreakerRow {
  id: string;
  risk_configuration_id: string;
  panic_mode_enabled: number;
  drawdown_limit_pct: number;
  max_position_size_pct: number;
  kelly_fraction_multiplier: number;
  created_at: number;
  updated_at: number;
}

interface PanicModeEventRow {
  id: string;
  request_code: string;
  status: string;
  pending_orders_count: number;
  active_positions_count: number;
  estimated_total_value: number;
  initiated_at: number;
  completed_at: number | null;
}

interface LiquidationReportRow {
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

interface LiquidationLineItemRow {
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

// ── GET /api/v1/risk-config/active ────────────────────────────
// Returns the active risk configuration with its agent thresholds
// and global circuit breaker settings.

router.get("/risk-config/active", (_req: Request, res: Response) => {
  const db = getDb();

  const config = db
    .prepare<[], RiskConfigRow>(
      "SELECT * FROM risk_configurations WHERE is_active = 1 LIMIT 1"
    )
    .get();

  if (!config) {
    res.status(404).json({ error: "No active risk configuration found" });
    return;
  }

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

  res.json({
    id: config.id,
    userId: config.user_id,
    version: config.version,
    isActive: config.is_active === 1,
    createdAt: config.created_at,
    updatedAt: config.updated_at,
    agentThresholds: thresholds.map((t) => ({
      id: t.id,
      agentName: t.agent_name,
      agentStatus: t.agent_status,
      varThreshold: t.var_threshold,
      autoExecEnabled: t.auto_exec_enabled === 1,
    })),
    globalCircuitBreaker: circuitBreaker
      ? {
          id: circuitBreaker.id,
          panicModeEnabled: circuitBreaker.panic_mode_enabled === 1,
          drawdownLimitPct: circuitBreaker.drawdown_limit_pct,
          maxPositionSizePct: circuitBreaker.max_position_size_pct,
          kellyFractionMultiplier: circuitBreaker.kelly_fraction_multiplier,
        }
      : null,
  });
});

// ── GET /api/v1/risk-config ───────────────────────────────────
// Returns the active risk config in the flat shape the Prism frontend
// settings page expects: { agentVarThreshold, maxPositionSize, drawdownLimit, kellyMultiplier }

router.get("/risk-config", (_req: Request, res: Response) => {
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

  const avgVar =
    thresholds.length > 0
      ? thresholds.reduce((sum, t) => sum + t.var_threshold, 0) / thresholds.length
      : 0.05;

  // max_position_size_pct may have been seeded as 5.0 (legacy percent scale).
  // Normalise to 0–1 if the stored value exceeds 1.
  const rawMaxPos = cb?.max_position_size_pct ?? 0.1;
  const maxPositionSize = rawMaxPos > 1 ? rawMaxPos / 100 : rawMaxPos;

  res.json({
    agentVarThreshold: parseFloat(avgVar.toFixed(4)),
    maxPositionSize,
    drawdownLimit: cb?.drawdown_limit_pct ?? 0.15,
    kellyMultiplier: cb?.kelly_fraction_multiplier ?? 0.25,
  });
});

// ── PUT /api/v1/risk-config ───────────────────────────────────
// Accepts the flat shape from the Prism settings page and persists it.

router.put("/risk-config", (req: Request, res: Response) => {
  const db = getDb();
  const {
    agentVarThreshold = 0.05,
    maxPositionSize = 0.1,
    drawdownLimit = 0.15,
    kellyMultiplier = 0.25,
  } = req.body as {
    agentVarThreshold?: number;
    maxPositionSize?: number;
    drawdownLimit?: number;
    kellyMultiplier?: number;
  };

  const now = Date.now();

  // Update global circuit breaker
  db.prepare(
    `UPDATE global_circuit_breakers
     SET max_position_size_pct = ?,
         drawdown_limit_pct    = ?,
         kelly_fraction_multiplier = ?,
         updated_at = ?
     WHERE id = 'gcb-default-001'`
  ).run(maxPositionSize, drawdownLimit, kellyMultiplier, now);

  // Update all agent var thresholds to the new global value
  db.prepare(
    `UPDATE agent_thresholds
     SET var_threshold = ?,
         updated_at    = ?
     WHERE risk_configuration_id = 'rc-default-001'`
  ).run(agentVarThreshold, now);

  // Bump config version + timestamp
  db.prepare(
    `UPDATE risk_configurations
     SET version    = version + 1,
         updated_at = ?
     WHERE id = 'rc-default-001'`
  ).run(now);

  res.json({
    agentVarThreshold,
    maxPositionSize,
    drawdownLimit,
    kellyMultiplier,
    updatedAt: now,
  });
});

// ── POST /api/v1/panic-mode/activate ─────────────────────────
// Triggers panic mode, creates a panic_mode_events record, seeds
// a dummy liquidation report, and returns the report ID.

router.post("/panic-mode/activate", (_req: Request, res: Response) => {
  const db = getDb();
  const now = Date.now();

  const eventId = uuidv4();
  const requestCode = `PMR-${Date.now().toString(36).toUpperCase()}`;

  // Create panic mode event
  db.prepare<[string, string, number, number, number, number]>(`
    INSERT INTO panic_mode_events
      (id, request_code, status, pending_orders_count, active_positions_count, estimated_total_value, initiated_at)
    VALUES (?, ?, 'processing', ?, ?, ?, ?)
  `).run(eventId, requestCode, 3, 4, 1287.5, now);

  // Create dummy liquidation report
  const reportId = uuidv4();
  const reportCode = `LQR-${Date.now().toString(36).toUpperCase()}`;

  db.prepare<[string, string, string]>(`
    INSERT INTO liquidation_reports
      (id, report_code, panic_mode_event_id, status, total_realized_value, slippage_pct, gas_execution_cost, recovery_status)
    VALUES (?, ?, ?, 'processing', NULL, NULL, NULL, 'pending')
  `).run(reportId, reportCode, eventId);

  // Seed dummy line items
  const MOCK_LINE_ITEMS: Omit<LiquidationLineItemRow, "id" | "liquidation_report_id">[] = [
    {
      asset_symbol: "US-ELECTION-YES",
      asset_label: "US Election 2026 — YES",
      execution_price: 0.61,
      trigger_price: 0.65,
      size: 200,
      size_unit: "shares",
      pnl_impact: -8.0,
    },
    {
      asset_symbol: "BTC-100K-YES",
      asset_label: "BTC $100K EoY — YES",
      execution_price: 0.44,
      trigger_price: 0.50,
      size: 150,
      size_unit: "shares",
      pnl_impact: -9.0,
    },
    {
      asset_symbol: "ETH-MERGE-NO",
      asset_label: "ETH Merge v2 — NO",
      execution_price: 0.72,
      trigger_price: 0.70,
      size: 80,
      size_unit: "shares",
      pnl_impact: 1.6,
    },
    {
      asset_symbol: "NBA-FINALS-LAL",
      asset_label: "NBA Finals 2026 — Lakers",
      execution_price: 0.33,
      trigger_price: 0.35,
      size: 120,
      size_unit: "shares",
      pnl_impact: -2.4,
    },
  ];

  const insertItem = db.prepare<[string, string, string, string, number, number, number, string, number]>(`
    INSERT INTO liquidation_line_items
      (id, liquidation_report_id, asset_symbol, asset_label, execution_price, trigger_price, size, size_unit, pnl_impact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of MOCK_LINE_ITEMS) {
    insertItem.run(
      uuidv4(),
      reportId,
      item.asset_symbol,
      item.asset_label,
      item.execution_price,
      item.trigger_price,
      item.size,
      item.size_unit,
      item.pnl_impact
    );
  }

  // Mark circuit breaker as panic mode enabled
  db.prepare(
    "UPDATE global_circuit_breakers SET panic_mode_enabled = 1, updated_at = ? WHERE id = 'gcb-default-001'"
  ).run(now);

  res.status(202).json({
    eventId,
    requestCode,
    status: "processing",
    liquidationReportId: reportId,
    message: "Panic mode activated. Liquidation in progress.",
  });
});

// ── GET /api/v1/liquidation-reports/:id ──────────────────────
// Returns a liquidation report with its line items in the shape
// the Prism LiquidationReportPage expects.

router.get("/liquidation-reports/:id", (req: Request, res: Response) => {
  const db = getDb();
  const id = Array.isArray(req.params["id"]) ? req.params["id"][0] : req.params["id"];

  const report = db
    .prepare<[string], LiquidationReportRow>(
      "SELECT * FROM liquidation_reports WHERE id = ?"
    )
    .get(id);

  if (!report) {
    res.status(404).json({ error: `Liquidation report '${id}' not found` });
    return;
  }

  const lineItems = db
    .prepare<[string], LiquidationLineItemRow>(
      "SELECT * FROM liquidation_line_items WHERE liquidation_report_id = ?"
    )
    .all(report.id);

  // Look up the originating panic event for timestamp + triggeredBy context
  const event = db
    .prepare<[string], PanicModeEventRow>(
      "SELECT * FROM panic_mode_events WHERE id = ?"
    )
    .get(report.panic_mode_event_id);

  // Compute aggregates
  const totalPnlImpact = lineItems.reduce((acc, li) => acc + li.pnl_impact, 0);
  const totalRealizedValue =
    report.total_realized_value ??
    lineItems.reduce((acc, li) => acc + li.execution_price * li.size, 0);

  const slippagePct = report.slippage_pct ?? 0.012;
  const gasExecutionCost = report.gas_execution_cost ?? 0.85;

  // Use initiated_at from the event as the canonical report timestamp
  const reportTimestamp = event?.initiated_at ?? (report.completion_timestamp ?? Date.now());

  // Map DB status → Prism status union
  const statusMap: Record<string, "complete" | "partial" | "failed"> = {
    complete: "complete",
    partial: "partial",
    failed: "failed",
    processing: "partial",
  };
  const frontendStatus: "complete" | "partial" | "failed" =
    statusMap[report.status] ?? "partial";

  // Build synthetic timeline from event data (Prism IncidentTimeline)
  const timeline = [
    {
      timestamp: reportTimestamp,
      type: "protocol_start",
      message: "Emergency protocol initiated by operator.",
    },
    {
      timestamp: reportTimestamp + 1_200,
      type: "circuit_break",
      message: "Circuit breaker engaged — pipeline halted.",
    },
    {
      timestamp: reportTimestamp + 3_400,
      type: "order_cancel",
      message: `${event?.pending_orders_count ?? 0} open order(s) cancelled across all markets.`,
    },
    ...lineItems.map((li, i) => ({
      timestamp: reportTimestamp + 5_000 + i * 2_000,
      type: "position_close",
      message: `${li.asset_symbol} position closed at ${Math.round(li.execution_price * 100)}¢.`,
    })),
    {
      timestamp: reportTimestamp + 5_000 + lineItems.length * 2_000 + 1_000,
      type: "protocol_end",
      message: "Liquidation complete. Report generated.",
    },
  ];

  res.json({
    // ── Core identity ──────────────────────────────────────────────
    id: report.id,
    reportCode: report.report_code,
    panicModeEventId: report.panic_mode_event_id,
    status: frontendStatus,
    // ── Prism-expected fields ──────────────────────────────────────
    timestamp: reportTimestamp,
    triggeredBy: "Manual Panic Protocol",
    totalRealizedValue,
    totalSlippage: parseFloat((slippagePct * totalRealizedValue).toFixed(2)),
    totalGas: gasExecutionCost,
    assets: lineItems.map((li) => ({
      asset: li.asset_symbol,
      executionPrice: li.execution_price,
      triggerPrice: li.trigger_price,
      size: li.size,
      pnlImpact: li.pnl_impact,
    })),
    timeline,
    // ── Legacy / extended fields (kept for backward compat) ────────
    completionTimestamp: report.completion_timestamp,
    slippagePct,
    gasExecutionCost,
    recoveryStatus: report.recovery_status ?? "pending",
    totalPnlImpact,
    lineItems: lineItems.map((li) => ({
      id: li.id,
      assetSymbol: li.asset_symbol,
      assetLabel: li.asset_label,
      executionPrice: li.execution_price,
      triggerPrice: li.trigger_price,
      size: li.size,
      sizeUnit: li.size_unit,
      pnlImpact: li.pnl_impact,
    })),
  });
});

export default router;
