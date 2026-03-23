import { isRedisEnabled, getRedis } from "./redis";
import { scheduleRepeatable, QUEUE_NAMES } from "./queues";
import { MarketScanner } from "../scanner/marketScanner";
import { AlertPoller, ensureAlertColumns } from "../alerts/telegramAlert";
import { ResolutionMonitor } from "../monitoring/resolution";
import { checkByoHealth } from "../monitoring/byoHealth";
import { getDb } from "../db/schema";
import { emitPositionUpdate, emitPriceUpdate } from "./socket";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerDirectionMap,
} from "../utils/executionDirection";
import { evaluateMarketAlerts } from "../services/marketAlerts";

// ── Position Update Emitter ───────────────────────────────────────────────────
// Periodically computes current P&L for open positions and emits Socket.IO
// events so the manage-agent page receives live position updates.

async function emitPositionUpdates(): Promise<void> {
  try {
    const db = getDb();
    const positions = db.prepare(
      "SELECT slug, side, direction, status, amount, fill_price FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL"
    ).all() as { slug: string; side: string; direction: string | null; status: string; amount: number; fill_price: number | null }[];

    if (positions.length === 0) return;

    const priceRows = db.prepare(
      `SELECT s.slug, s.probability FROM scanner_results s
       INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) t
       ON s.slug = t.slug AND s.scanned_at = t.latest`
    ).all() as { slug: string; probability: number }[];
    const priceMap = new Map(priceRows.map(r => [r.slug, r.probability]));
    const scannerDirections = await getLatestScannerDirectionMap();

    const now = Date.now();
    const priceUpdates = new Map<string, { slug: string; yes: number; no: number; timestamp: number }>();
    for (const pos of positions) {
      const scannerDirection = scannerDirections.get(pos.slug);
      const currentYes = priceMap.get(pos.slug) ?? getEntryYesPrice(pos, scannerDirection);
      const metrics = calculateOpenExecutionMetrics(pos, currentYes, scannerDirection);
      const pnlPct = pos.amount > 0 ? metrics.pnl / pos.amount : 0;

      if (!priceUpdates.has(pos.slug)) {
        priceUpdates.set(pos.slug, {
          slug: pos.slug,
          yes: currentYes,
          no: Math.max(0, 1 - currentYes),
          timestamp: now,
        });
      }

      emitPositionUpdate(null, {
        slug: pos.slug,
        currentPrice: metrics.currentTokenPrice,
        pnl: metrics.pnl,
        pnlPct,
        timestamp: now,
      });
    }

    if (priceUpdates.size > 0) {
      const batchedUpdates = Array.from(priceUpdates.values());
      emitPriceUpdate(batchedUpdates);
      await evaluateMarketAlerts(batchedUpdates);
    }
  } catch (err) {
    console.error("[scheduler:position-update] error:", err);
  }
}

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

  // Position update emitter (30s) — live P&L push via Socket.IO
  await scheduleRepeatable({
    name: QUEUE_NAMES.POSITION_UPDATE,
    intervalMs: 30 * 1000,
    processor: emitPositionUpdates,
    immediate: false,
  });

  // BYO agent health monitor (60s) — heartbeat staleness + offline alerts
  await scheduleRepeatable({
    name: QUEUE_NAMES.BYO_HEALTH,
    intervalMs: 60 * 1000,
    processor: checkByoHealth,
    immediate: false,
  });

  // Arena rank snapshots (60min) — historical tracking + rank-change deltas
  const { processArenaSnapshots } = await import("../performance/arenaSnapshots");
  await scheduleRepeatable({
    name: QUEUE_NAMES.ARENA_SNAPSHOTS,
    intervalMs: 60 * 60 * 1000,
    processor: processArenaSnapshots,
    immediate: true,
  });

  // Weekly buyback + distribution (every Friday midnight UTC)
  // BullMQ's scheduleRepeatable uses intervalMs — 7-day interval.
  // Friday alignment is handled by computing the current week window inside runWeeklyBuyback.
  const { runWeeklyBuyback } = await import("../solana/airdropService");
  await scheduleRepeatable({
    name: QUEUE_NAMES.WEEKLY_BUYBACK,
    intervalMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    processor: runWeeklyBuyback,
    immediate: false,
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

  // Position update emitter (30s) — live P&L push via Socket.IO
  setInterval(() => {
    emitPositionUpdates().catch(console.error);
  }, 30 * 1000);

  // BYO agent health monitor (60s) — heartbeat staleness + offline alerts
  setInterval(() => {
    checkByoHealth().catch(console.error);
  }, 60 * 1000);

  // Arena rank snapshots (60min) — historical tracking + rank-change deltas
  const { processArenaSnapshots } = require("../performance/arenaSnapshots");
  processArenaSnapshots().catch(console.error);
  setInterval(() => {
    processArenaSnapshots().catch(console.error);
  }, 60 * 60 * 1000);

  // Weekly buyback (legacy mode — setInterval every 7 days)
  const { runWeeklyBuyback } = require("../solana/airdropService");
  setInterval(() => {
    runWeeklyBuyback().catch(console.error);
  }, 7 * 24 * 60 * 60 * 1000);
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

export async function initScheduler(): Promise<void> {
  if (isRedisEnabled()) {
    // Verify Redis is actually reachable before committing to BullMQ
    try {
      const redis = getRedis();
      await redis.ping();
      console.log("[scheduler] BullMQ mode (Redis connected)");
      await startBullMQScheduler();
    } catch (err: any) {
      console.warn(`[scheduler] Redis unreachable (${err.message}) — falling back to legacy mode`);
      startLegacyScheduler();
    }
  } else {
    console.log("[scheduler] Legacy mode (no Redis — using setInterval)");
    startLegacyScheduler();
  }
}
