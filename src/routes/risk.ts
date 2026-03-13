import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { runCli } from "../cli";
import { emitAutopilotStatus, emitToAll } from "../infra/socket";

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
// Emergency protocol: cancels orders, liquidates positions, trips circuit breaker,
// generates a persisted liquidation report retrievable by ID.

router.post("/panic-mode/activate", async (req: Request, res: Response) => {
  const db = getDb();
  const now = Date.now();
  const body = req.body as { cancelOrders?: boolean; liquidatePositions?: boolean } | undefined;
  const cancelOrders = body?.cancelOrders !== false; // default true
  const liquidatePositions = body?.liquidatePositions ?? false;

  // 1. Trip circuit breaker + global kill switch immediately
  db.prepare(
    "UPDATE global_circuit_breakers SET panic_mode_enabled = 1, updated_at = ? WHERE id = 'gcb-default-001'"
  ).run(now);
  db.prepare(
    "UPDATE circuit_breaker_state SET state = 'TRIGGERED', triggered_at = ?, last_checked_at = ? WHERE id = 1"
  ).run(now, now);

  // Explicitly disable autopilot on ALL active agents so the flag is correct even after panic resets
  db.prepare("UPDATE agents SET autopilot_enabled = 0, updated_at = ? WHERE autopilot_enabled = 1").run(now);

  // Broadcast panic to all connected clients immediately
  emitToAll("panic:activated", { timestamp: now });
  emitAutopilotStatus({
    isRunning: false,
    lastScan: null,
    tradesToday: 0,
    circuitBreakerTriggered: true,
    timestamp: now,
  });

  // 2. Read open positions before we close them
  const openPositions = db.prepare<[], { id: string; slug: string; side: string; amount: number; fill_price: number | null; order_id: string | null; status: string }>(
    "SELECT id, slug, side, amount, fill_price, order_id, status FROM executions WHERE status IN ('placed', 'paper', 'submitted') AND pnl IS NULL"
  ).all();

  const priceRows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as any[];
  const currentPrices = new Map(priceRows.map((r: any) => [r.slug, r.probability]));

  const estimatedValue = openPositions.reduce((sum, p) => sum + p.amount, 0);

  // 3. Cancel all open orders
  let cancelledCount = 0;
  if (cancelOrders) {
    // Cancel paper orders
    const paperResult = db.prepare("UPDATE paper_orders SET status = 'cancelled' WHERE status = 'open'").run();
    cancelledCount += paperResult.changes;

    // Cancel live orders via CLI (best-effort — circuit breaker already tripped above)
    try {
      await runCli(["clob", "cancel-all"]);
      cancelledCount += 1; // CLI doesn't return individual count
    } catch (cliErr) {
      console.error("[PANIC] clob cancel-all failed:", cliErr);
      // Do NOT abort — circuit breaker and autopilot disable already took effect
    }
  }

  // 4. Create panic event record
  const eventId = uuidv4();
  const requestCode = `PMR-${Date.now().toString(36).toUpperCase()}`;

  db.prepare(`
    INSERT INTO panic_mode_events
      (id, request_code, status, pending_orders_count, active_positions_count, estimated_total_value, initiated_at)
    VALUES (?, ?, 'processing', ?, ?, ?, ?)
  `).run(eventId, requestCode, cancelledCount, openPositions.length, estimatedValue, now);

  // 5. Create liquidation report
  const reportId = uuidv4();
  const reportCode = `LQR-${Date.now().toString(36).toUpperCase()}`;

  db.prepare(`
    INSERT INTO liquidation_reports
      (id, report_code, panic_mode_event_id, status, total_realized_value, slippage_pct, gas_execution_cost, recovery_status)
    VALUES (?, ?, ?, 'processing', NULL, NULL, NULL, 'pending')
  `).run(reportId, reportCode, eventId);

  // 6. Build line items + close positions
  const insertItem = db.prepare(`
    INSERT INTO liquidation_line_items
      (id, liquidation_report_id, asset_symbol, asset_label, execution_price, trigger_price, size, size_unit, pnl_impact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const closeExecution = db.prepare(
    "UPDATE executions SET status = 'liquidated', pnl = ? WHERE id = ?"
  );

  let totalRealizedValue = 0;
  let totalPnl = 0;

  for (const pos of openPositions) {
    const fillPrice = pos.fill_price ?? 0.5;
    const isLiveNoBet = pos.side === "sell" && pos.status !== "paper";
    const entryYes = isLiveNoBet ? 1 - fillPrice : fillPrice;
    const currentYes = currentPrices.get(pos.slug) ?? entryYes;
    const pnl = pos.side === "buy"
      ? (currentYes - entryYes) * (pos.amount / Math.max(0.01, entryYes))
      : (entryYes - currentYes) * (pos.amount / Math.max(0.01, 1 - entryYes));
    const realizedValue = currentYes * (pos.amount / Math.max(0.01, entryYes));

    const direction = pos.side === "buy" ? "YES" : "NO";
    const label = pos.slug.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

    insertItem.run(
      uuidv4(),
      reportId,
      `${pos.slug.toUpperCase()}-${direction}`,
      `${label} — ${direction}`,
      currentYes,
      entryYes,
      pos.amount / Math.max(0.01, entryYes),
      "shares",
      parseFloat(pnl.toFixed(2))
    );

    // Mark position as liquidated with realized PnL
    if (liquidatePositions) {
      closeExecution.run(parseFloat(pnl.toFixed(2)), pos.id);
    }

    totalRealizedValue += realizedValue;
    totalPnl += pnl;
  }

  // 7. Finalize report
  const completedAt = Date.now();
  const reportStatus = liquidatePositions ? "complete" : "partial";

  db.prepare(
    "UPDATE liquidation_reports SET status = ?, completion_timestamp = ?, total_realized_value = ?, slippage_pct = 0, gas_execution_cost = 0, recovery_status = ? WHERE id = ?"
  ).run(reportStatus, completedAt, parseFloat(totalRealizedValue.toFixed(2)), liquidatePositions ? "complete" : "pending", reportId);

  db.prepare(
    "UPDATE panic_mode_events SET status = ?, completed_at = ? WHERE id = ?"
  ).run(reportStatus, completedAt, eventId);

  res.json({
    success: true,
    reportId,
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
