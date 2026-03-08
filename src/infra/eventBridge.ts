// ── Event Bridge — forward Socket.IO events to BYO agent webhooks ────────────
//
// When a BYO agent has an `endpoint_url` configured, this module bridges
// real-time events (trade:executed, agent:alert, pipeline:complete, etc.)
// to their webhook as HTTP POST requests.
//
// Features:
//   - HMAC-SHA256 signing on all webhook payloads (X-Quantik-Signature)
//   - 3 retry attempts with exponential backoff + jitter
//   - Per-agent circuit breaker (5 failures → open for 5 minutes)
//   - Webhook delivery logging for audit trail
//   - Per-agent event filtering via webhook_events column
//   - Fire-and-forget from the caller's perspective

import crypto from "crypto";
import { getDb } from "../db/schema";
import { isPgEnabled, pgExec } from "../db/postgres";
import { getIO } from "./socket";

// ── Circuit Breaker State ────────────────────────────────────────────────────

interface CircuitState {
  failures: number;
  openUntil: number; // timestamp — 0 means circuit is closed
}

const circuitBreakers = new Map<string, CircuitState>();
const CB_THRESHOLD = 5;        // failures before opening
const CB_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function getCircuit(agentId: string): CircuitState {
  let state = circuitBreakers.get(agentId);
  if (!state) {
    state = { failures: 0, openUntil: 0 };
    circuitBreakers.set(agentId, state);
  }
  return state;
}

function isCircuitOpen(agentId: string): boolean {
  const state = getCircuit(agentId);
  if (state.openUntil === 0) return false;
  if (Date.now() > state.openUntil) {
    // Half-open — allow one attempt, reset failures
    state.openUntil = 0;
    state.failures = CB_THRESHOLD - 1; // one more failure will re-open
    return false;
  }
  return true;
}

function recordSuccess(agentId: string): void {
  const state = getCircuit(agentId);
  state.failures = 0;
  state.openUntil = 0;
}

function recordFailure(agentId: string): void {
  const state = getCircuit(agentId);
  state.failures++;
  if (state.failures >= CB_THRESHOLD) {
    state.openUntil = Date.now() + CB_COOLDOWN_MS;
    console.warn(`[eventBridge] Circuit OPEN for agent ${agentId} — ${CB_THRESHOLD} consecutive failures`);
  }
}

/** Remove circuit breaker state for a specific agent (call on termination) */
export function clearCircuit(agentId: string): void {
  circuitBreakers.delete(agentId);
}

/** Remove circuit breaker entries for agents that no longer exist */
export function cleanupCircuits(): void {
  if (circuitBreakers.size === 0) return;
  try {
    const db = getDb();
    const agentIds = Array.from(circuitBreakers.keys());
    for (const id of agentIds) {
      const exists = db.prepare("SELECT 1 FROM agents WHERE id = ? AND status != 'terminated'").get(id);
      if (!exists) circuitBreakers.delete(id);
    }
  } catch {
    // Non-critical — skip cleanup
  }
}

// ── HMAC Signing ─────────────────────────────────────────────────────────────

function signPayload(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// ── Webhook Delivery Logging ─────────────────────────────────────────────────

function logDelivery(
  agentId: string,
  event: string,
  url: string,
  statusCode: number | null,
  latencyMs: number,
  attempt: number,
  error?: string,
): void {
  try {
    const createdAt = Date.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO webhook_delivery_log (agent_id, event, url, status_code, latency_ms, attempt, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(agentId, event, url, statusCode, latencyMs, attempt, error ?? null, createdAt);
    if (isPgEnabled()) {
      void pgExec(
        `INSERT INTO webhook_delivery_log (agent_id, event, url, status_code, latency_ms, attempt, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [agentId, event, url, statusCode, latencyMs, attempt, error ?? null, createdAt]
      ).catch(() => {});
    }
  } catch {
    // Fire-and-forget — never block the delivery
  }
}

// ── Webhook Delivery ─────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function deliverWebhook(
  url: string,
  agentId: string,
  event: string,
  data: unknown,
  webhookSecret: string | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const bodyStr = JSON.stringify({ event, data, timestamp: Date.now() });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Quantik-Event": event,
        "X-Quantik-Agent": agentId,
        "X-Quantik-Timestamp": String(Date.now()),
      };

      // HMAC signing if agent has a webhook_secret
      if (webhookSecret) {
        headers["X-Quantik-Signature"] = signPayload(webhookSecret, bodyStr);
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      const latency = Date.now() - start;

      if (res.ok || (res.status >= 200 && res.status < 300)) {
        recordSuccess(agentId);
        logDelivery(agentId, event, url, res.status, latency, attempt + 1);
        return true;
      }

      // 4xx client errors — don't retry (except 429)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.warn(`[eventBridge] ${event} → ${url} returned ${res.status}, not retrying`);
        recordFailure(agentId);
        logDelivery(agentId, event, url, res.status, latency, attempt + 1, `HTTP ${res.status}`);
        return false;
      }

      logDelivery(agentId, event, url, res.status, latency, attempt + 1, `HTTP ${res.status} (retrying)`);
    } catch (err) {
      const latency = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logDelivery(agentId, event, url, null, latency, attempt + 1, errMsg);
      if (attempt === MAX_RETRIES - 1) {
        console.error(`[eventBridge] ${event} → ${url} failed after ${MAX_RETRIES} attempts:`, errMsg);
      }
    }

    // Exponential backoff with jitter: ~1s, ~4s, ~16s
    if (attempt < MAX_RETRIES - 1) {
      const baseDelay = BASE_DELAY_MS * Math.pow(4, attempt);
      const jitter = baseDelay * (0.8 + Math.random() * 0.4);
      await new Promise(r => setTimeout(r, jitter));
    }
  }

  recordFailure(agentId);
  return false;
}

// ── Bridge Function ──────────────────────────────────────────────────────────

/** Forward an event to all BYO agents with webhook URLs configured */
export async function bridgeEventToWebhooks(
  event: string,
  data: unknown,
  targetUserId?: string,
): Promise<void> {
  try {
    const db = getDb();

    // Find BYO agents with endpoint_url set (include webhook_secret + webhook_events for filtering)
    let agents: { id: string; endpoint_url: string; user_id: string; webhook_secret: string | null; webhook_events: string | null }[];
    const query = `SELECT id, endpoint_url, user_id, webhook_secret, webhook_events FROM agents
       WHERE agent_type = 'byo' AND endpoint_url IS NOT NULL AND endpoint_url != ''
       AND status NOT IN ('terminated', 'paused')`;

    if (targetUserId) {
      agents = db.prepare(query + " AND user_id = ?").all(targetUserId) as typeof agents;
    } else {
      agents = db.prepare(query).all() as typeof agents;
    }

    if (agents.length === 0) return;

    // Deliver webhooks concurrently (fire-and-forget per agent)
    const deliveries = agents
      .filter(a => {
        if (isCircuitOpen(a.id)) return false;
        // Check per-agent event filtering
        if (a.webhook_events) {
          try {
            const subscribed = JSON.parse(a.webhook_events) as string[];
            if (!subscribed.includes("*") && !subscribed.includes(event)) return false;
          } catch {
            // Malformed JSON — allow all events
          }
        }
        return true;
      })
      .map(a => deliverWebhook(a.endpoint_url, a.id, event, data, a.webhook_secret).catch(() => {}));

    await Promise.allSettled(deliveries);
  } catch (err) {
    console.error("[eventBridge] bridgeEventToWebhooks error:", err);
  }
}

// ── Socket.IO Event Listener Setup ───────────────────────────────────────────

const BRIDGED_EVENTS = [
  "trade:executed",
  "agent:alert",
  "autopilot:status",
  "position:update",
  "pipeline:complete",
  "market:signal",
  "risk:alert",
];

/** Attach listeners to the Socket.IO server to bridge events to webhooks */
export function initEventBridge(): void {
  const io = getIO();
  if (!io) {
    console.warn("[eventBridge] Socket.IO not initialized, skipping event bridge setup");
    return;
  }

  // Hook into outgoing events by wrapping the emitToUser function
  // Instead of hooking Socket.IO internals, we export a helper that callers use
  console.log("[eventBridge] Event bridge initialized — will forward events to BYO webhooks");
}

/** Call this alongside emitToUser to also bridge to webhooks */
export function bridgeEmit(event: string, data: unknown, userId?: string): void {
  if (!BRIDGED_EVENTS.includes(event)) return;
  // Fire-and-forget — don't block the caller
  bridgeEventToWebhooks(event, data, userId).catch(() => {});
}
