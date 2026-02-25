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
// Returns a liquidation report with its line items.

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

  // Compute aggregates from line items for a richer mock response
  const totalPnlImpact = lineItems.reduce((acc, li) => acc + li.pnl_impact, 0);
  const totalRealizedValue =
    report.total_realized_value ??
    lineItems.reduce((acc, li) => acc + li.execution_price * li.size, 0);

  res.json({
    id: report.id,
    reportCode: report.report_code,
    panicModeEventId: report.panic_mode_event_id,
    status: report.status,
    completionTimestamp: report.completion_timestamp,
    totalRealizedValue,
    slippagePct: report.slippage_pct ?? 0.012,
    gasExecutionCost: report.gas_execution_cost ?? 0.85,
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
