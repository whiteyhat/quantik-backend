import { Router, Request, Response } from "express";

const router = Router();

// ── Types ──────────────────────────────────────────────────────

type AgentStatus = "active" | "idle" | "error";

interface AgentStatusEntry {
  id: string;
  name: string;
  latencyMs: number;
  confidence: number;
  lastAction: string;
  lastActionAt: string;
  status: AgentStatus;
}

// ── Agent config (seeded values for realistic semi-random output) ──

interface AgentConfig {
  id: string;
  name: string;
  latencySeed: number;   // base latency ms (120-450 range)
  confidenceSeed: number; // base confidence (0.70-0.95 range)
  lastAction: string;
  statusBias: AgentStatus; // typical operating state
}

const AGENT_CONFIGS: AgentConfig[] = [
  {
    id: "relay",
    name: "Relay",
    latencySeed: 145,
    confidenceSeed: 0.91,
    lastAction: "Routed market query to Oracle",
    statusBias: "active",
  },
  {
    id: "aura",
    name: "Aura",
    latencySeed: 320,
    confidenceSeed: 0.82,
    lastAction: "Sentiment analysis on BTC-100k-eoy",
    statusBias: "active",
  },
  {
    id: "flux",
    name: "Flux",
    latencySeed: 280,
    confidenceSeed: 0.78,
    lastAction: "Processed news feed batch",
    statusBias: "idle",
  },
  {
    id: "oracle",
    name: "Oracle",
    latencySeed: 410,
    confidenceSeed: 0.87,
    lastAction: "Probability estimate: senate-majority-2026",
    statusBias: "active",
  },
  {
    id: "edge",
    name: "Edge",
    latencySeed: 195,
    confidenceSeed: 0.84,
    lastAction: "Kelly sizing recalculated (f=0.25)",
    statusBias: "active",
  },
  {
    id: "sigma",
    name: "Sigma",
    latencySeed: 230,
    confidenceSeed: 0.76,
    lastAction: "Volatility model updated",
    statusBias: "idle",
  },
  {
    id: "lucifer",
    name: "Lucifer",
    latencySeed: 175,
    confidenceSeed: 0.93,
    lastAction: "Veto threshold check passed",
    statusBias: "active",
  },
];

// ── Deterministic jitter seeded from agent id ──────────────────
// Uses agent id chars to produce consistent but non-uniform offsets,
// then adds a small time-based wobble so values shift slightly each poll.

function seededJitter(id: string, range: number): number {
  const base = id
    .split("")
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  // Slow time wobble: changes every ~30 s
  const tick = Math.floor(Date.now() / 30_000);
  const wobble = ((base * 1_000_003 + tick * 7) % 1_000) / 1_000; // 0..1
  return wobble * range;
}

function buildEntry(cfg: AgentConfig): AgentStatusEntry {
  const latencyJitter = seededJitter(cfg.id, 60) - 30; // ±30 ms
  const latencyMs = Math.round(
    Math.max(120, Math.min(450, cfg.latencySeed + latencyJitter))
  );

  const confJitter = (seededJitter(cfg.id + "c", 0.1) - 0.05); // ±0.05
  const confidence =
    Math.round(
      Math.max(0.7, Math.min(0.95, cfg.confidenceSeed + confJitter)) * 100
    ) / 100;

  // lastActionAt: stagger agents across the last ~10 minutes
  const offsetMs = seededJitter(cfg.id + "t", 600_000);
  const lastActionAt = new Date(Date.now() - offsetMs).toISOString();

  return {
    id: cfg.id,
    name: cfg.name,
    latencyMs,
    confidence,
    lastAction: cfg.lastAction,
    lastActionAt,
    status: cfg.statusBias,
  };
}

// ── GET /api/v1/agents/status ──────────────────────────────────

router.get("/agents/status", (_req: Request, res: Response) => {
  const agents: AgentStatusEntry[] = AGENT_CONFIGS.map(buildEntry);
  res.json(agents);
});

export default router;
