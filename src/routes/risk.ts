import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { runCliWithWallet } from "../cli";
import { tryLoadActiveAgentContext } from "../utils/agentKey";
import {
  isPanicModeEnabled,
  resetRiskState,
  setPanicModeEnabled,
  tripCircuitBreaker,
} from "../risk/state";
import {
  emitAutopilotStatus,
  emitNotification,
  emitPanicCooldown,
  emitToAll,
} from "../infra/socket";
import { sendStatusUpdate } from "../alerts/telegramAlert";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerDirectionMap,
} from "../utils/executionDirection";
import {
  type PanicModeEventRow,
  type LiquidationLineItemRow,
  type LiquidationLineItemInput,
  type LiquidationUpdate,
  getLatestPanicModeEvent,
  getReportIdForEvent,
  insertPanicModeEvent,
  finalizePanicModeEvent,
  rearmPanicModeEvent,
  insertLiquidationReport,
  finalizeLiquidationReport,
  getLiquidationReportById,
  getLiquidationLineItems,
  getPanicModeEventById,
  insertLiquidationLineItemsBatch,
  liquidateExecutionsBatch,
  getOpenExecutions,
  getCurrentPrices,
  cancelPaperOrders,
  disableAllAutopilots,
  getActiveRiskConfig,
  getActiveCircuitBreakerAndThresholds,
  updateRiskConfig,
} from "../db/panicQueries";

const router = Router();

// ── Constants ─────────────────────────────────────────────────

const PANIC_COOLDOWN_MS = 60_000;
const PANIC_REARM_CONFIRMATION = "CONFIRM";

// ── Helpers ───────────────────────────────────────────────────

interface PanicModeStatusPayload {
  active: boolean;
  cooldownEndsAt: number | null;
  cooldownRemainingMs: number;
  canRearm: boolean;
  latestEvent: {
    id: string;
    requestCode: string;
    reason: string | null;
    status: string;
    initiatedAt: number;
    completedAt: number | null;
    reportId: string | null;
    cooldownEndsAt: number | null;
    rearmedAt: number | null;
  } | null;
}

async function getPanicModeStatus(): Promise<PanicModeStatusPayload> {
  const now = Date.now();
  const latestEvent = await getLatestPanicModeEvent();
  const reportId = latestEvent ? await getReportIdForEvent(latestEvent.id) : null;
  const cooldownEndsAt = latestEvent?.cooldown_until ?? null;
  const cooldownRemainingMs =
    cooldownEndsAt && cooldownEndsAt > now ? cooldownEndsAt - now : 0;
  const active = await isPanicModeEnabled();

  return {
    active,
    cooldownEndsAt,
    cooldownRemainingMs,
    canRearm: active && cooldownRemainingMs === 0,
    latestEvent: latestEvent
      ? {
          id: latestEvent.id,
          requestCode: latestEvent.request_code,
          reason: latestEvent.reason,
          status: latestEvent.status,
          initiatedAt: latestEvent.initiated_at,
          completedAt: latestEvent.completed_at,
          reportId,
          cooldownEndsAt,
          rearmedAt: latestEvent.rearmed_at,
        }
      : null,
  };
}

// ── GET /api/v1/risk-config/active ────────────────────────────

router.get("/risk-config/active", async (_req: Request, res: Response) => {
  const result = await getActiveRiskConfig();
  if (!result) {
    res.status(404).json({ error: "No active risk configuration found" });
    return;
  }

  const { config, thresholds, circuitBreaker } = result;
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

router.get("/risk-config", async (_req: Request, res: Response) => {
  const { circuitBreaker: cb, thresholds } = await getActiveCircuitBreakerAndThresholds();

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

router.put("/risk-config", async (req: Request, res: Response) => {
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
  await updateRiskConfig({ agentVarThreshold, maxPositionSize, drawdownLimit, kellyMultiplier, now });

  res.json({
    agentVarThreshold,
    maxPositionSize,
    drawdownLimit,
    kellyMultiplier,
    updatedAt: now,
  });
});

// ── GET /api/v1/panic-mode/status ─────────────────────────────

router.get("/panic-mode/status", async (_req: Request, res: Response) => {
  try {
    res.json(await getPanicModeStatus());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/panic-mode/activate ──────────────────────────

router.post("/panic-mode/activate", async (req: Request, res: Response) => {
  const now = Date.now();
  const body = req.body as {
    cancelOrders?: boolean;
    liquidatePositions?: boolean;
    reason?: string;
  } | undefined;
  const cancelOrders = body?.cancelOrders !== false;
  const liquidatePositions = body?.liquidatePositions ?? false;
  const reason =
    typeof body?.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 240)
      : "Operator triggered emergency protocol.";

  // ── Validate ──
  const existingStatus = await getPanicModeStatus();
  if (existingStatus.active || existingStatus.cooldownRemainingMs > 0) {
    res.status(409).json({
      error: "Panic mode is already active or cooling down.",
      ...existingStatus,
    });
    return;
  }
  const cooldownEndsAt = now + PANIC_COOLDOWN_MS;

  // ── Step 1: Trip breakers + disable autopilot (parallel) ──
  await Promise.all([
    setPanicModeEnabled(true, now),
    tripCircuitBreaker(now),
    disableAllAutopilots(now),
  ]);

  // ── Step 2: Broadcast panic to clients immediately ──
  emitToAll("panic:activated", { timestamp: now, reason, cooldownEndsAt });
  emitAutopilotStatus({
    isRunning: false,
    lastScan: null,
    tradesToday: 0,
    circuitBreakerTriggered: true,
    timestamp: now,
  });

  // ── Step 3: Read open positions + prices (parallel) ──
  const [openPositions, currentPrices, scannerDirections] = await Promise.all([
    getOpenExecutions(),
    getCurrentPrices(),
    getLatestScannerDirectionMap(),
  ]);
  const estimatedValue = openPositions.reduce((sum, p) => sum + p.amount, 0);

  // ── Step 4: Cancel open orders ──
  let cancelledCount = 0;
  if (cancelOrders) {
    cancelledCount += await cancelPaperOrders();

    try {
      const agentCtx = await tryLoadActiveAgentContext();
      if (agentCtx) {
        await runCliWithWallet(["clob", "cancel-all"], agentCtx.privateKey);
        cancelledCount += 1;
      }
    } catch (cliErr) {
      console.error("[PANIC] clob cancel-all failed:", cliErr);
    }
  }

  // ── Step 5: Create event + report records ──
  const eventId = uuidv4();
  const requestCode = `PMR-${Date.now().toString(36).toUpperCase()}`;
  const reportId = uuidv4();
  const reportCode = `LQR-${Date.now().toString(36).toUpperCase()}`;

  await insertPanicModeEvent({
    id: eventId,
    requestCode,
    reason,
    pendingOrdersCount: cancelledCount,
    activePositionsCount: openPositions.length,
    estimatedTotalValue: estimatedValue,
    cooldownUntil: cooldownEndsAt,
    initiatedAt: now,
  });
  await insertLiquidationReport({ id: reportId, reportCode, panicModeEventId: eventId });

  // ── Step 6: Build line items (pure computation) ──
  const lineItems: LiquidationLineItemInput[] = [];
  const liquidationUpdates: LiquidationUpdate[] = [];
  let totalRealizedValue = 0;

  for (const pos of openPositions) {
    const scannerDirection = scannerDirections.get(pos.slug);
    const currentYes = currentPrices.get(pos.slug) ?? getEntryYesPrice(pos, scannerDirection);
    const metrics = calculateOpenExecutionMetrics(pos, currentYes, scannerDirection);
    const realizedValue = metrics.currentTokenPrice * (pos.amount / Math.max(0.01, metrics.entryTokenPrice));
    const direction = metrics.direction;
    const label = pos.slug.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

    lineItems.push({
      id: uuidv4(),
      liquidationReportId: reportId,
      assetSymbol: `${pos.slug.toUpperCase()}-${direction}`,
      assetLabel: `${label} — ${direction}`,
      executionPrice: metrics.currentTokenPrice,
      triggerPrice: metrics.entryTokenPrice,
      size: pos.amount / Math.max(0.01, metrics.entryTokenPrice),
      sizeUnit: "shares",
      pnlImpact: parseFloat(metrics.pnl.toFixed(2)),
    });

    if (liquidatePositions) {
      liquidationUpdates.push({
        executionId: pos.id,
        pnl: parseFloat(metrics.pnl.toFixed(2)),
      });
    }

    totalRealizedValue += realizedValue;
  }

  // ── Step 7: Batch insert line items + liquidate ──
  await insertLiquidationLineItemsBatch(lineItems);
  if (liquidationUpdates.length > 0) {
    await liquidateExecutionsBatch(liquidationUpdates);
  }

  // ── Step 8: Finalize records ──
  const completedAt = Date.now();
  const reportStatus = liquidatePositions ? "complete" : "partial";
  const recoveryStatus = liquidatePositions ? "complete" : "pending";

  await finalizeLiquidationReport(reportId, reportStatus, completedAt, parseFloat(totalRealizedValue.toFixed(2)), recoveryStatus);
  await finalizePanicModeEvent(eventId, reportStatus, completedAt);

  // ── Step 9: Notifications ──
  void sendStatusUpdate(
    [
      "🚨 <b>Quantik panic mode activated</b>",
      `Reason: ${reason}`,
      `Orders cancelled: ${cancelledCount}`,
      `Positions affected: ${openPositions.length}`,
      `Cooldown ends: ${new Date(cooldownEndsAt).toISOString()}`,
      `Report: <code>${reportCode}</code>`,
    ].join("\n")
  );
  emitNotification(null, {
    id: `panic-activated-${eventId}`,
    level: "error",
    title: "Panic mode activated",
    message: reason,
    category: "panic",
    timestamp: now,
    action: {
      label: "Open liquidation report",
      href: `/reports/liquidation/${reportId}`,
    },
  });
  emitPanicCooldown({
    active: true,
    cooldownEndsAt,
    canRearm: false,
    reportId,
    reason,
    timestamp: now,
  });

  res.json({ success: true, reportId, cooldownEndsAt, reason });
});

// ── POST /api/v1/panic-mode/rearm ─────────────────────────────

router.post("/panic-mode/rearm", async (req: Request, res: Response) => {
  const now = Date.now();
  const body = req.body as { confirmation?: string } | undefined;
  const status = await getPanicModeStatus();

  if (!status.active) {
    res.status(409).json({ error: "Panic mode is not currently active.", ...status });
    return;
  }
  if (status.cooldownRemainingMs > 0) {
    res.status(409).json({ error: "Panic mode cooldown is still active.", ...status });
    return;
  }
  if (body?.confirmation !== PANIC_REARM_CONFIRMATION) {
    res.status(400).json({ error: `Confirmation must equal ${PANIC_REARM_CONFIRMATION}.` });
    return;
  }

  await resetRiskState(now);
  if (status.latestEvent?.id) {
    await rearmPanicModeEvent(status.latestEvent.id, now);
  }

  void sendStatusUpdate("✅ <b>Quantik panic mode re-armed.</b>");

  emitNotification(null, {
    id: `panic-rearmed-${now}`,
    level: "success",
    title: "Panic mode re-armed",
    message: "Circuit breaker reset to ARMED after cooldown.",
    category: "panic",
    timestamp: now,
  });
  emitPanicCooldown({
    active: false,
    cooldownEndsAt: status.cooldownEndsAt,
    canRearm: false,
    reportId: status.latestEvent?.reportId ?? null,
    reason: status.latestEvent?.reason ?? null,
    timestamp: now,
  });

  res.json({ success: true, status: await getPanicModeStatus() });
});

// ── GET /api/v1/liquidation-reports/:id ───────────────────────

router.get("/liquidation-reports/:id", async (req: Request, res: Response) => {
  const id = Array.isArray(req.params["id"]) ? req.params["id"][0] : req.params["id"];

  const report = await getLiquidationReportById(id);
  if (!report) {
    res.status(404).json({ error: `Liquidation report '${id}' not found` });
    return;
  }

  const [lineItems, event] = await Promise.all([
    getLiquidationLineItems(report.id),
    getPanicModeEventById(report.panic_mode_event_id),
  ]);

  // Compute aggregates
  const totalPnlImpact = lineItems.reduce((acc, li) => acc + li.pnl_impact, 0);
  const totalRealizedValue =
    report.total_realized_value ??
    lineItems.reduce((acc, li) => acc + li.execution_price * li.size, 0);

  const slippagePct = report.slippage_pct ?? 0.012;
  const gasExecutionCost = report.gas_execution_cost ?? 0.85;
  const reportTimestamp = event?.initiated_at ?? (report.completion_timestamp ?? Date.now());

  const statusMap: Record<string, "complete" | "partial" | "failed"> = {
    complete: "complete",
    partial: "partial",
    failed: "failed",
    processing: "partial",
  };
  const frontendStatus: "complete" | "partial" | "failed" =
    statusMap[report.status] ?? "partial";

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
    ...lineItems.map((li: LiquidationLineItemRow, i: number) => ({
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
    id: report.id,
    reportCode: report.report_code,
    panicModeEventId: report.panic_mode_event_id,
    reason: event?.reason ?? null,
    status: frontendStatus,
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
    completionTimestamp: report.completion_timestamp,
    slippagePct,
    gasExecutionCost,
    recoveryStatus: report.recovery_status ?? "pending",
    cooldownEndsAt: event?.cooldown_until ?? null,
    rearmedAt: event?.rearmed_at ?? null,
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
