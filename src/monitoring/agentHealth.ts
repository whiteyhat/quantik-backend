// Agent health tracking via in-memory ring buffer.
// Records { agent, timestamp, success, latencyMs } for each invocation.
// Used by GET /api/agents/health to return real-time status.

export type AgentName = "aura" | "flux" | "oracle" | "edge" | "sigma" | "clause" | "lucifer";
export type AgentRuntimeStatus = "live" | "idle" | "degraded" | "down";

export const AGENT_NAMES: AgentName[] = ["aura", "flux", "oracle", "edge", "sigma", "clause", "lucifer"];

interface InvocationRecord {
  agent: AgentName;
  timestamp: number;
  success: boolean;
  latencyMs: number;
}

const BUFFER_SIZE = 200; // per agent
const STALENESS_MS = 10 * 60 * 1000; // 10 minutes
const ONE_HOUR_MS = 60 * 60 * 1000;

const buffers = new Map<AgentName, InvocationRecord[]>();

for (const name of AGENT_NAMES) {
  buffers.set(name, []);
}

export function resetAgentHealth(): void {
  for (const name of AGENT_NAMES) {
    buffers.set(name, []);
  }
}

export function recordInvocation(agent: AgentName, success: boolean, latencyMs: number): void {
  const buf = buffers.get(agent);
  if (!buf) return;
  buf.push({ agent, timestamp: Date.now(), success, latencyMs });
  if (buf.length > BUFFER_SIZE) buf.shift();
}

export async function trackAgent<T>(agent: AgentName, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordInvocation(agent, true, Date.now() - start);
    return result;
  } catch (err) {
    recordInvocation(agent, false, Date.now() - start);
    throw err;
  }
}

export function trackAgentSync<T>(agent: AgentName, fn: () => T): T {
  const start = Date.now();
  try {
    const result = fn();
    recordInvocation(agent, true, Date.now() - start);
    return result;
  } catch (err) {
    recordInvocation(agent, false, Date.now() - start);
    throw err;
  }
}

interface AgentHealth {
  name: AgentName;
  status: AgentRuntimeStatus;
  lastActiveAt: number;
  latencyMs: number;
  errorRate: number;
}

function getAgentHealth(agent: AgentName): AgentHealth {
  const buf = buffers.get(agent) ?? [];
  const now = Date.now();

  if (buf.length === 0) {
    return { name: agent, status: "idle", lastActiveAt: 0, latencyMs: 0, errorRate: 0 };
  }

  const lastRecord = buf[buf.length - 1];
  const lastActiveAt = lastRecord.timestamp;
  const isStale = now - lastActiveAt > STALENESS_MS;

  // Error rate: invocations in the last hour. If there is no recent traffic,
  // treat the agent as idle rather than manufacturing a failure rate.
  const recentHour = buf.filter(r => r.timestamp >= now - ONE_HOUR_MS);
  const errorRate = recentHour.length > 0
    ? recentHour.filter(r => !r.success).length / recentHour.length
    : 0;

  // Average latency: last 10 recent successful invocations.
  const recentSuccessful = recentHour.filter(r => r.success).slice(-10);
  const latencyMs = recentSuccessful.length > 0
    ? Math.round(recentSuccessful.reduce((sum, r) => sum + r.latencyMs, 0) / recentSuccessful.length)
    : 0;

  let status: AgentRuntimeStatus;

  if (isStale) {
    status = "idle";
  } else if (errorRate > 0.25) {
    status = "down";
  } else if (errorRate > 0.05 || latencyMs > 30000) {
    status = "degraded";
  } else {
    status = "live";
  }

  return { name: agent, status, lastActiveAt, latencyMs, errorRate: parseFloat(errorRate.toFixed(3)) };
}

export function getSystemHealth(): {
  agents: AgentHealth[];
  overall: "healthy" | "degraded" | "down";
  checkedAt: number;
} {
  const agents = AGENT_NAMES.map(getAgentHealth);
  const liveCount = agents.filter((agent) => agent.status === "live").length;
  const degradedCount = agents.filter((agent) => agent.status === "degraded").length;
  const downCount = agents.filter((agent) => agent.status === "down").length;

  let overall: "healthy" | "degraded" | "down";
  if (downCount > 0) {
    overall = "down";
  } else if (degradedCount > 0 || liveCount === 0) {
    overall = "degraded";
  } else {
    overall = "healthy";
  }

  return { agents, overall, checkedAt: Date.now() };
}
