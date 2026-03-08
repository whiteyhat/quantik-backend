// ── BYO Agent Health Score ────────────────────────────────────────────────────
//
// Computes a health snapshot for a BYO agent based on telemetry in the last 24h.
// Missing telemetry is treated explicitly as insufficient data instead of healthy.

import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";

export interface HealthScore {
  status: "healthy" | "degraded" | "critical" | "insufficient_data";
  score: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | null;
  components: {
    uptime: number | null;
    error_rate: number | null;
    latency: number | null;
    connection: number | null;
  };
  total_requests_24h: number;
  error_count_24h: number;
  avg_latency_ms: number | null;
  connection_status: string;
  request_samples_24h: number;
  heartbeat_samples_24h: number;
  message: string;
}

interface HealthScoreInputs {
  connection_status: string | null;
  total_requests_24h: number;
  error_count_24h: number;
  avg_latency_ms: number | null;
  heartbeat_samples_24h: number;
}

function finalizeHealthScore(input: HealthScoreInputs): HealthScore {
  const connectionStatus = input.connection_status ?? "pending";
  const connectionScore =
    connectionStatus === "connected" ? 100 :
    connectionStatus === "pending" ? 40 :
    0;

  const insufficientTelemetry = input.total_requests_24h < 5 || input.heartbeat_samples_24h < 2;
  if (insufficientTelemetry) {
    return {
      status: "insufficient_data",
      score: null,
      grade: null,
      components: {
        uptime: input.heartbeat_samples_24h > 0 ? Math.round(Math.min(100, (input.heartbeat_samples_24h / 288) * 100)) : null,
        error_rate: input.total_requests_24h > 0
          ? Math.round(Math.max(0, Math.min(100, (1 - (input.error_count_24h / input.total_requests_24h) / 0.1) * 100)))
          : null,
        latency: input.avg_latency_ms == null ? null : Math.round(Math.max(0, Math.min(100, ((2000 - input.avg_latency_ms) / 1900) * 100))),
        connection: connectionScore,
      },
      total_requests_24h: input.total_requests_24h,
      error_count_24h: input.error_count_24h,
      avg_latency_ms: input.avg_latency_ms == null ? null : Math.round(input.avg_latency_ms),
      connection_status: connectionStatus,
      request_samples_24h: input.total_requests_24h,
      heartbeat_samples_24h: input.heartbeat_samples_24h,
      message: "Not enough BYO telemetry yet. Keep OpenClaw connected and sending requests before relying on this health score.",
    };
  }

  const uptimePct = Math.min(100, (input.heartbeat_samples_24h / 288) * 100);
  const errorRate = input.total_requests_24h > 0 ? (input.error_count_24h / input.total_requests_24h) : 1;
  const errorScore = Math.max(0, Math.min(100, (1 - errorRate / 0.1) * 100));
  const latencyScore = input.avg_latency_ms == null
    ? 0
    : Math.max(0, Math.min(100, ((2000 - input.avg_latency_ms) / 1900) * 100));
  const score = Math.round(
    uptimePct * 0.4 +
    errorScore * 0.3 +
    latencyScore * 0.2 +
    connectionScore * 0.1
  );

  const grade: HealthScore["grade"] =
    score >= 90 ? "A" :
    score >= 75 ? "B" :
    score >= 50 ? "C" :
    score >= 25 ? "D" :
    "F";

  return {
    status: score >= 85 ? "healthy" : score >= 60 ? "degraded" : "critical",
    score,
    grade,
    components: {
      uptime: Math.round(uptimePct),
      error_rate: Math.round(errorScore),
      latency: Math.round(latencyScore),
      connection: connectionScore,
    },
    total_requests_24h: input.total_requests_24h,
    error_count_24h: input.error_count_24h,
    avg_latency_ms: input.avg_latency_ms == null ? null : Math.round(input.avg_latency_ms),
    connection_status: connectionStatus,
    request_samples_24h: input.total_requests_24h,
    heartbeat_samples_24h: input.heartbeat_samples_24h,
    message: score >= 85
      ? "Telemetry looks healthy across uptime, latency, and request success."
      : score >= 60
        ? "Runtime is operational but degraded. Review latency, errors, or heartbeat gaps."
        : "Runtime health is critical. Investigate connectivity and recent tool failures before trusting automation.",
  };
}

export async function computeHealthScore(agentId: string): Promise<HealthScore | null> {
  try {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    if (isPgEnabled()) {
      const agent = await pgQueryOne<{ connection_status: string | null }>(
        "SELECT connection_status FROM agents WHERE id = $1 AND agent_type = 'byo'",
        [agentId]
      );
      if (!agent) return null;

      const stats = await pgQueryOne<{
        total: number;
        errors: number;
        avg_latency: number | null;
      }>(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0)::int AS errors,
                AVG(latency_ms) AS avg_latency
         FROM byo_request_log
         WHERE agent_id = $1 AND created_at >= $2`,
        [agentId, oneDayAgo]
      );
      const heartbeat = await pgQueryOne<{ intervals: number }>(
        `SELECT COUNT(DISTINCT FLOOR(created_at / 300000.0))::int AS intervals
         FROM byo_request_log
         WHERE agent_id = $1 AND created_at >= $2 AND tool_name = 'heartbeat'`,
        [agentId, oneDayAgo]
      );

      return finalizeHealthScore({
        connection_status: agent.connection_status,
        total_requests_24h: stats?.total ?? 0,
        error_count_24h: stats?.errors ?? 0,
        avg_latency_ms: stats?.avg_latency ?? null,
        heartbeat_samples_24h: heartbeat?.intervals ?? 0,
      });
    }

    const db = getDb();
    const agent = db.prepare(
      "SELECT connection_status FROM agents WHERE id = ? AND agent_type = 'byo'"
    ).get(agentId) as { connection_status: string | null } | undefined;

    if (!agent) return null;

    const stats = db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
              AVG(latency_ms) as avg_latency
       FROM byo_request_log WHERE agent_id = ? AND created_at >= ?`
    ).get(agentId, oneDayAgo) as { total: number; errors: number | null; avg_latency: number | null };

    const heartbeat = db.prepare(
      `SELECT COUNT(DISTINCT (created_at / 300000)) as intervals
       FROM byo_request_log WHERE agent_id = ? AND created_at >= ? AND tool_name = 'heartbeat'`
    ).get(agentId, oneDayAgo) as { intervals: number };

    return finalizeHealthScore({
      connection_status: agent.connection_status,
      total_requests_24h: stats.total,
      error_count_24h: stats.errors ?? 0,
      avg_latency_ms: stats.avg_latency ?? null,
      heartbeat_samples_24h: heartbeat.intervals,
    });
  } catch (err) {
    console.error("[healthScore] computeHealthScore error:", err);
    return null;
  }
}
