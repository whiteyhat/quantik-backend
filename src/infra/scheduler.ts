import { isRedisEnabled } from "./redis";
import { scheduleRepeatable, QUEUE_NAMES } from "./queues";
import { MarketScanner } from "../scanner/marketScanner";
import { AlertPoller, ensureAlertColumns } from "../alerts/telegramAlert";
import { ResolutionMonitor } from "../monitoring/resolution";

// ── BullMQ Scheduler Bootstrap ────────────────────────────────────────────────
// Replaces all setInterval-based scheduling with BullMQ repeatable jobs.
// When REDIS_URL is not set, falls back to legacy setInterval mode.

export async function startBullMQScheduler(): Promise<void> {
  // Scanner (5min)
  const autoScanner = new MarketScanner();
  await scheduleRepeatable({
    name: QUEUE_NAMES.SCANNER,
    intervalMs: 5 * 60 * 1000,
    processor: () => autoScanner.scan(),
    immediate: true,
  });

  // Orchestrator (10min)
  const { startSchedulerOnce } = await import("../orchestrator/index");
  await scheduleRepeatable({
    name: QUEUE_NAMES.ORCHESTRATOR,
    intervalMs: 10 * 60 * 1000,
    processor: startSchedulerOnce,
    immediate: true,
  });

  // Hot scanner (60s)
  const { runHotScan } = await import("../oracle/hot-scanner");
  await scheduleRepeatable({
    name: QUEUE_NAMES.HOT_SCANNER,
    intervalMs: 60 * 1000,
    processor: runHotScan,
    immediate: true,
  });

  // Fill monitor (30s)
  const { runFillCheck } = await import("../execution/index");
  await scheduleRepeatable({
    name: QUEUE_NAMES.FILL_MONITOR,
    intervalMs: 30 * 1000,
    processor: runFillCheck,
    immediate: false,
  });

  // PnL settler (30min)
  const { settle } = await import("../settlers/pnlSettler");
  await scheduleRepeatable({
    name: QUEUE_NAMES.PNL_SETTLER,
    intervalMs: 30 * 60 * 1000,
    processor: settle,
    immediate: true,
  });

  // Alert poller (60s)
  ensureAlertColumns();
  const alertPoller = new AlertPoller();
  await scheduleRepeatable({
    name: QUEUE_NAMES.ALERT_POLLER,
    intervalMs: 60 * 1000,
    processor: () => alertPoller.pollAndAlert(),
    immediate: true,
  });

  // Resolution monitor (5min)
  const resolutionMonitor = new ResolutionMonitor();
  await scheduleRepeatable({
    name: QUEUE_NAMES.RESOLUTION,
    intervalMs: 5 * 60 * 1000,
    processor: async () => { await resolutionMonitor.checkResolutions(); },
    immediate: true,
  });
}

// ── Legacy Fallback (setInterval) ─────────────────────────────────────────────

export function startLegacyScheduler(): void {
  const { startScheduler } = require("../orchestrator/index");
  const { startHotScanner } = require("../oracle/hot-scanner");
  const { startFillMonitor } = require("../execution");
  const { startPnlSettler } = require("../settlers/pnlSettler");

  startScheduler();
  startHotScanner();
  startFillMonitor();
  startPnlSettler();

  const autoScanner = new MarketScanner();
  autoScanner.scan().catch(console.error);
  setInterval(() => {
    autoScanner.scan().catch(console.error);
  }, 5 * 60 * 1000);

  ensureAlertColumns();
  const alertPoller = new AlertPoller();
  setInterval(() => alertPoller.pollAndAlert().catch(console.error), 60 * 1000);
  alertPoller.pollAndAlert().catch(console.error);

  const resolutionMonitor = new ResolutionMonitor();
  resolutionMonitor.checkResolutions().catch(console.error);
  setInterval(() => {
    resolutionMonitor.checkResolutions().catch(console.error);
  }, 5 * 60 * 1000);
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

export async function initScheduler(): Promise<void> {
  if (isRedisEnabled()) {
    console.log("[scheduler] BullMQ mode (Redis detected)");
    await startBullMQScheduler();
  } else {
    console.log("[scheduler] Legacy mode (no Redis — using setInterval)");
    startLegacyScheduler();
  }
}
