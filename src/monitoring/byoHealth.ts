// ── BYO Agent Health Monitor ─────────────────────────────────────────────────
//
// Runs every 60s via the scheduler. Checks BYO agent heartbeat staleness:
//   - 5 min stale → connection_status = 'disconnected'
//   - 30 min stale with open positions → Telegram alert to owner
//   - Sends "back online" notification when agent reconnects after long offline
//
// Also handles:
//   - Cleaning up old request logs (30-day retention)
//   - Cleaning up orphaned circuit breaker state

import { getDb } from "../db/schema";
import { sendStatusUpdate } from "../alerts/telegramAlert";
import { cleanupCircuits } from "../infra/eventBridge";

const STALE_THRESHOLD_MS = 5 * 60 * 1000;      // 5 minutes → disconnected
const ALERT_THRESHOLD_MS = 30 * 60 * 1000;      // 30 minutes → alert if open positions
const ALERT_COOLDOWN_MS  = 60 * 60 * 1000;      // 1 hour between repeat alerts
const LOG_RETENTION_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days

// Track last alert time per agent to avoid spam
const lastAlertSent = new Map<string, number>();
// Track which agents were recently disconnected (for "back online" alerts)
const wasDisconnected = new Set<string>();

// Counter to run retention cleanup every ~30 min instead of every 60s
let cleanupCounter = 0;

export async function checkByoHealth(): Promise<void> {
  try {
    const db = getDb();
    const now = Date.now();

    // Get all BYO agents that aren't terminated
    const agents = db.prepare(`
      SELECT id, name, user_id, last_heartbeat, connection_status
      FROM agents
      WHERE agent_type = 'byo' AND status != 'terminated'
    `).all() as {
      id: string;
      name: string;
      user_id: string;
      last_heartbeat: number | null;
      connection_status: string | null;
    }[];

    for (const agent of agents) {
      if (!agent.last_heartbeat) {
        // Never connected — mark as pending if not already
        if (agent.connection_status !== "pending") {
          db.prepare("UPDATE agents SET connection_status = 'pending' WHERE id = ?").run(agent.id);
        }
        continue;
      }

      const age = now - agent.last_heartbeat;

      if (age < STALE_THRESHOLD_MS) {
        // Recent heartbeat — ensure status is connected
        if (agent.connection_status !== "connected") {
          db.prepare("UPDATE agents SET connection_status = 'connected' WHERE id = ?").run(agent.id);

          // Send "back online" alert if agent was previously disconnected for 30+ min
          if (wasDisconnected.has(agent.id)) {
            wasDisconnected.delete(agent.id);
            const offlineMinutes = lastAlertSent.has(agent.id) ? Math.round((now - (lastAlertSent.get(agent.id)! - ALERT_COOLDOWN_MS)) / 60000) : 0;
            const alertText = [
              `✅ <b>BYO Agent Back Online</b>`,
              ``,
              `Agent <b>${escHtml(agent.name)}</b> has reconnected${offlineMinutes > 0 ? ` after ~${offlineMinutes} minutes offline` : ""}.`,
            ].join("\n");
            sendStatusUpdate(alertText).catch(() => {});
            lastAlertSent.delete(agent.id);
          }
        }
        continue;
      }

      // Stale heartbeat — mark disconnected
      if (agent.connection_status !== "disconnected") {
        db.prepare("UPDATE agents SET connection_status = 'disconnected' WHERE id = ?").run(agent.id);
        console.log(`[byoHealth] Agent ${agent.name} (${agent.id}) marked disconnected — last heartbeat ${Math.round(age / 1000)}s ago`);
      }

      // Check if 30+ minutes stale with open positions
      if (age >= ALERT_THRESHOLD_MS) {
        wasDisconnected.add(agent.id);

        const lastAlert = lastAlertSent.get(agent.id) ?? 0;
        if (now - lastAlert < ALERT_COOLDOWN_MS) continue; // Already alerted recently

        // Check for open positions belonging to THIS agent
        const openPositions = db.prepare(
          `SELECT COUNT(*) as count FROM executions
           WHERE agent_id = ? AND status IN ('placed', 'paper') AND pnl IS NULL`
        ).get(agent.id) as { count: number };

        if (openPositions.count > 0) {
          const minutesAgo = Math.round(age / 60000);
          const alertText = [
            `🔴 <b>BYO Agent Offline Alert</b>`,
            ``,
            `Agent <b>${escHtml(agent.name)}</b> has not sent a heartbeat in <b>${minutesAgo} minutes</b>.`,
            `There are <b>${openPositions.count}</b> open positions that may need attention.`,
            ``,
            `Last heartbeat: ${new Date(agent.last_heartbeat).toISOString()}`,
          ].join("\n");

          const sent = await sendStatusUpdate(alertText);
          if (sent) {
            lastAlertSent.set(agent.id, now);
            console.log(`[byoHealth] Telegram alert sent for agent ${agent.name} — ${minutesAgo}min offline, ${openPositions.count} open positions`);
          }
        }
      }
    }

    // Periodic cleanup tasks (every ~30 min = 30 calls at 60s interval)
    cleanupCounter++;
    if (cleanupCounter >= 30) {
      cleanupCounter = 0;

      // Clean up old request logs (30-day retention)
      try {
        const cutoff = now - LOG_RETENTION_MS;
        const result = db.prepare("DELETE FROM byo_request_log WHERE created_at < ?").run(cutoff);
        if (result.changes > 0) {
          console.log(`[byoHealth] Cleaned up ${result.changes} request log entries older than 30 days`);
        }

        // Also clean up old webhook delivery logs
        const whResult = db.prepare("DELETE FROM webhook_delivery_log WHERE created_at < ?").run(cutoff);
        if (whResult.changes > 0) {
          console.log(`[byoHealth] Cleaned up ${whResult.changes} webhook delivery log entries older than 30 days`);
        }
      } catch {
        // Non-critical — skip cleanup
      }

      // Clean up orphaned circuit breaker state
      cleanupCircuits();
    }
  } catch (err) {
    console.error("[byoHealth] checkByoHealth error:", err);
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
