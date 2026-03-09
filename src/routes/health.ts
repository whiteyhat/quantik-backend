import { Router, Request, Response } from "express";

type ServiceStatus = "healthy" | "degraded" | "down";

interface RelayHealthSnapshot {
  status: ServiceStatus;
  detail: string;
  checkedAt: number;
  agent?: string;
  llm?: string;
  models?: string[];
  activeSessions?: number;
}

interface ScannerHealthSnapshot {
  running: boolean;
  lastScan: number;
  scannedToday: number;
  alertsTriggered: number;
}

interface OrchestratorHealthSnapshot {
  lastScanAt: number;
  nextScanAt: number;
  marketsScanned: number;
  candidatesFound: number;
  scanIntervalMs: number;
  status: "idle" | "scanning";
  scanCycle: number;
}

interface PipelineAgentSnapshot {
  name: string;
  status: "live" | "idle" | "degraded" | "down";
  lastActiveAt: number;
  latencyMs: number;
  errorRate: number;
}

interface PipelineHealthSnapshot {
  agents: PipelineAgentSnapshot[];
  overall: "healthy" | "degraded" | "down";
  checkedAt: number;
}

interface HealthServiceSnapshot {
  status: ServiceStatus;
  detail: string;
  checkedAt: number;
  meta?: Record<string, unknown>;
}

interface HealthSnapshotDependencies {
  now?: number;
  relay?: RelayHealthSnapshot;
  scanner?: ScannerHealthSnapshot;
  orchestrator?: OrchestratorHealthSnapshot;
  systemHealth?: PipelineHealthSnapshot;
}

function statusRank(status: ServiceStatus) {
  if (status === "down") return 2;
  if (status === "degraded") return 1;
  return 0;
}

function formatAge(timestamp: number, now: number) {
  if (!timestamp) return "never";
  const diffMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(diffMs / 1_000);

  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

function buildScannerService(scanner: ScannerHealthSnapshot, now: number): HealthServiceSnapshot {
  if (!scanner.lastScan) {
    return {
      status: "degraded",
      detail: "Scanner has not completed a cycle yet",
      checkedAt: now,
      meta: { ...scanner },
    };
  }

  const ageMs = now - scanner.lastScan;
  const status: ServiceStatus =
    scanner.running || ageMs <= 15 * 60 * 1_000
      ? "healthy"
      : ageMs <= 45 * 60 * 1_000
        ? "degraded"
        : "down";

  return {
    status,
    detail: scanner.running
      ? `Scanner is running now`
      : `Last scan ${formatAge(scanner.lastScan, now)}`,
    checkedAt: now,
    meta: {
      ...scanner,
      lastScanAgeMs: ageMs,
    },
  };
}

function buildOrchestratorService(orchestrator: OrchestratorHealthSnapshot, now: number): HealthServiceSnapshot {
  if (!orchestrator.lastScanAt) {
    return {
      status: "degraded",
      detail: "Orchestrator has not scanned yet",
      checkedAt: now,
      meta: { ...orchestrator },
    };
  }

  const ageMs = now - orchestrator.lastScanAt;
  const status: ServiceStatus =
    orchestrator.status === "scanning" || ageMs <= orchestrator.scanIntervalMs * 2
      ? "healthy"
      : ageMs <= orchestrator.scanIntervalMs * 6
        ? "degraded"
        : "down";

  return {
    status,
    detail: orchestrator.status === "scanning"
      ? `Scanning ${orchestrator.marketsScanned.toLocaleString()} markets`
      : `${orchestrator.candidatesFound} candidates, last scan ${formatAge(orchestrator.lastScanAt, now)}`,
    checkedAt: now,
    meta: {
      ...orchestrator,
      lastScanAgeMs: ageMs,
    },
  };
}

function buildPipelineAgentsService(systemHealth: PipelineHealthSnapshot): HealthServiceSnapshot {
  const liveCount = systemHealth.agents.filter((agent) => agent.status === "live").length;
  const idleCount = systemHealth.agents.filter((agent) => agent.status === "idle").length;
  const degradedCount = systemHealth.agents.filter((agent) => agent.status === "degraded").length;
  const downCount = systemHealth.agents.filter((agent) => agent.status === "down").length;
  const hasTraffic = systemHealth.agents.some((agent) => agent.lastActiveAt > 0);

  const status: ServiceStatus =
    downCount > 0
      ? "down"
      : degradedCount > 0 || liveCount === 0
        ? "degraded"
        : "healthy";

  return {
    status,
    detail: hasTraffic
      ? `${liveCount} live · ${idleCount} idle · ${degradedCount} degraded · ${downCount} down`
      : "No pipeline activity has been recorded yet",
    checkedAt: systemHealth.checkedAt,
    meta: {
      overall: systemHealth.overall,
      agents: systemHealth.agents,
      liveCount,
      idleCount,
      degradedCount,
      downCount,
      checkedAt: systemHealth.checkedAt,
    },
  };
}

function buildRelayService(relay: RelayHealthSnapshot): HealthServiceSnapshot {
  return {
    status: relay.status,
    detail: relay.detail,
    checkedAt: relay.checkedAt,
    meta: {
      agent: relay.agent,
      llm: relay.llm,
      models: relay.models,
      activeSessions: relay.activeSessions,
    },
  };
}

function buildBackendService(now: number): HealthServiceSnapshot {
  return {
    status: "healthy",
    detail: "API online and serving dashboard telemetry",
    checkedAt: now,
    meta: {
      uptimeMs: Math.round(process.uptime() * 1_000),
      nodeVersion: process.version,
    },
  };
}

function loadRelaySnapshot(): RelayHealthSnapshot {
  const { getRelayHealthSnapshot } = require("./relay") as typeof import("./relay");
  const snapshot = getRelayHealthSnapshot();
  return {
    ...snapshot,
    status:
      snapshot.status === "healthy"
        ? "healthy"
        : snapshot.status === "down"
          ? "down"
          : "degraded",
  };
}

function loadScannerSnapshot(): ScannerHealthSnapshot {
  const { getScannerStatus } = require("../scanner/marketScanner") as typeof import("../scanner/marketScanner");
  return getScannerStatus();
}

function loadOrchestratorSnapshot(): OrchestratorHealthSnapshot {
  const { getState } = require("../orchestrator/index") as typeof import("../orchestrator/index");
  return getState();
}

function loadPipelineHealthSnapshot(): PipelineHealthSnapshot {
  const { getSystemHealth } = require("../monitoring/agentHealth") as typeof import("../monitoring/agentHealth");
  return getSystemHealth();
}

export function buildHealthSnapshot(dependencies?: HealthSnapshotDependencies) {
  const now = dependencies?.now ?? Date.now();
  const relay = dependencies?.relay ?? loadRelaySnapshot();
  const scanner = dependencies?.scanner ?? loadScannerSnapshot();
  const orchestrator = dependencies?.orchestrator ?? loadOrchestratorSnapshot();
  const systemHealth = dependencies?.systemHealth ?? loadPipelineHealthSnapshot();

  const services = {
    backend: buildBackendService(now),
    relay: buildRelayService(relay),
    scanner: buildScannerService(scanner, now),
    orchestrator: buildOrchestratorService(orchestrator, now),
    pipeline_agents: buildPipelineAgentsService(systemHealth),
  };

  const statuses = Object.values(services).map((service) => service.status);
  const worstStatus = statuses.reduce<ServiceStatus>((worst, current) =>
    statusRank(current) > statusRank(worst) ? current : worst, "healthy");

  const message =
    worstStatus === "healthy"
      ? "All mission systems nominal"
      : worstStatus === "degraded"
        ? "Mission control is degraded but still operational"
        : "Mission control has critical service degradation";

  return {
    status: worstStatus,
    checkedAt: now,
    message,
    services,
  };
}

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json(buildHealthSnapshot());
});

export default router;
