// ── BYO Agent Health Score ────────────────────────────────────────────────────
//
// Computes a 0-100 health score for a BYO agent based on:
//   - Uptime coverage (40%): % of last 24h with active heartbeats
//   - Error rate (30%): inverse of error rate from request logs
//   - Avg latency (20%): faster = healthier (target < 200ms)
//   - Connection status (10%): currently connected bonus

import { getDb } from "../db/schema";

export interface HealthScore {
  score: number;            // 0-100
  grade: "A" | "B" | "C" | "D" | "F";
  components: {
    uptime: number;         // 0-100
    error_rate: number;     // 0-100
    latency: number;        // 0-100
    connection: number;     // 0 or 100
  };
  total_requests_24h: number;
  error_count_24h: number;
  avg_latency_ms: number;
  connection_status: string;
}

export function computeHealthScore(agentId: string): HealthScore | null {
  try {
    const db = getDb();
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Get agent info
    const agent = db.prepare(
      "SELECT connection_status, last_heartbeat FROM agents WHERE id = ? AND agent_type = 'byo'"
    ).get(agentId) as { connection_status: string; last_heartbeat: number | null } | undefined;

    if (!agent) return null;

    // Request stats (24h)
    const stats = db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
              AVG(latency_ms) as avg_latency
       FROM byo_request_log WHERE agent_id = ? AND created_at >= ?`
    ).get(agentId, oneDayAgo) as { total: number; errors: number; avg_latency: number | null };

    // Uptime: count distinct 5-min intervals with heartbeats in last 24h
    // A full 24h = 288 intervals of 5 min
    const heartbeatIntervals = db.prepare(
      `SELECT COUNT(DISTINCT (created_at / 300000)) as intervals
       FROM byo_request_log WHERE agent_id = ? AND created_at >= ? AND tool_name = 'heartbeat'`
    ).get(agentId, oneDayAgo) as { intervals: number };

    const maxIntervals = 288; // 24h / 5min
    const uptimePct = Math.min(100, (heartbeatIntervals.intervals / maxIntervals) * 100);

    // Error rate score: 0% errors = 100, 10%+ errors = 0
    const errorRate = stats.total > 0 ? (stats.errors / stats.total) : 0;
    const errorScore = Math.max(0, Math.min(100, (1 - errorRate / 0.1) * 100));

    // Latency score: < 100ms = 100, > 2000ms = 0
    const avgLatency = stats.avg_latency ?? 0;
    const latencyScore = avgLatency === 0 ? 100 : Math.max(0, Math.min(100, ((2000 - avgLatency) / 1900) * 100));

    // Connection score: connected = 100, anything else = 0
    const connectionScore = agent.connection_status === "connected" ? 100 : 0;

    // Weighted total
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
      score >= 25 ? "D" : "F";

    return {
      score,
      grade,
      components: {
        uptime: Math.round(uptimePct),
        error_rate: Math.round(errorScore),
        latency: Math.round(latencyScore),
        connection: connectionScore,
      },
      total_requests_24h: stats.total,
      error_count_24h: stats.errors,
      avg_latency_ms: Math.round(avgLatency),
      connection_status: agent.connection_status,
    };
  } catch (err) {
    console.error("[healthScore] computeHealthScore error:", err);
    return null;
  }
}
