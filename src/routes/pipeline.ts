import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";
import {
  getPipelineHistory,
  getPipelineRunById,
  getPipelineRunSteps,
  insertPipelineRun,
  insertPipelineRunStep,
  PipelineRun,
  PipelineRunStep,
  updatePipelineRun,
  updatePipelineRunStep,
} from "../db/queries";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { v4 as uuid } from "uuid";
import { runAura } from "../aura/index";
import { runOracle } from "../oracle/index";
import { runEdge } from "../edge/index";
import { runFlux } from "../flux/index";
import { pipelineRateLimit } from "../infra/rateLimit";
import { runClause } from "../clause/index";
import { runLucifer } from "../lucifer/index";
import { trackAgent, trackAgentSync } from "../monitoring/agentHealth";
import { execute } from "../execution/index";
import { approvePosition } from "../risk";
import { isStellarTestnetMode, isKrakenMode } from "../config/chain";
import { mapPipelineSignalToKraken, executeKrakenTrade } from "../kraken/execution";
import { GAMMA_API_BASE, fetchMarketBySlug, fetchWithRetry } from "../utils/market-fetch";
import { AGENT_NAMES, AGENT_OUTPUT_KEYS, type AgentName, type AgentOutputKey } from "../agents/constants";
import {
  submitValidationRequest,
  submitValidationResponse,
  submitFeedback,
  isErc8004Configured,
  getAgentIdentity,
} from "../erc8004";

const router = Router();

// ── Agent data interfaces (for strict typing) ──────────────────

interface AgentResult {
  agent: string;
  status: "complete" | "error";
  data: unknown;
}

interface EdgeAgentData {
  estimated_true_prob?: number;
  market_price?: number;
  edge?: number;
  kelly_fraction?: number;
  fractional_kelly?: number;
  ev_grade?: string;
  net_ev?: number;
}

interface LuciferAgentData {
  adjusted_confidence?: number;
  contrarian_take?: string;
  risk_flags?: string[];
}

interface AuraAgentData {
  sentiment_score?: number;
  sentimentDelta?: number;
  narrative?: string;
}

// AgentOutputKey and AGENT_OUTPUT_KEYS imported from ../agents/constants

interface SerializedPipelineRun extends Omit<
  PipelineRun,
  | "aura_output"
  | "flux_output"
  | "oracle_output"
  | "edge_output"
  | "sigma_output"
  | "clause_output"
  | "lucifer_output"
> {
  aura_output: unknown;
  flux_output: unknown;
  oracle_output: unknown;
  edge_output: unknown;
  sigma_output: unknown;
  clause_output: unknown;
  lucifer_output: unknown;
  source: "pipeline" | "scanner";
  available_agents: string[];
}

interface SerializedPipelineRunStep extends Omit<
  PipelineRunStep,
  "started_at" | "completed_at" | "data"
> {
  startedAt: number | null;
  completedAt: number | null;
  data: unknown;
}

interface ReplayFrame {
  index: number;
  type:
    | "pipeline:start"
    | "pipeline:complete"
    | "agent:start"
    | "agent:complete"
    | "agent:error"
    | "trade:executed"
    | "trade:rejected"
    | "trade:error";
  step: string;
  agent: string | null;
  status: string;
  timestamp: number;
  startedAt: number | null;
  completedAt: number | null;
  data?: unknown;
  error?: string | null;
}

// ── Timeout helper ─────────────────────────────────────────────

async function withAgentTimeout<T>(name: string, promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Agent ${name} timed out after ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ── Helpers ────────────────────────────────────────────────────

function toAgentData<T>(raw: unknown): T | undefined {
  if (raw !== null && typeof raw === "object") return raw as T;
  return undefined;
}

function parseStoredValue(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function serializePipelineRun(
  run: PipelineRun,
  scannerPayload?: ScannerPipelinePayload | null
): Promise<SerializedPipelineRun> {
  const resolvedPayload = scannerPayload ?? await getScannerPayloadForRun(run);
  const scannerFallbacks = buildScannerOutputFallbacks(
    run,
    resolvedPayload
  );
  const serialized = {
    ...run,
    aura_output: parseStoredValue(run.aura_output) ?? scannerFallbacks.aura_output ?? null,
    flux_output: parseStoredValue(run.flux_output) ?? scannerFallbacks.flux_output ?? null,
    oracle_output: parseStoredValue(run.oracle_output) ?? scannerFallbacks.oracle_output ?? null,
    edge_output: parseStoredValue(run.edge_output) ?? scannerFallbacks.edge_output ?? null,
    sigma_output: parseStoredValue(run.sigma_output) ?? scannerFallbacks.sigma_output ?? null,
    clause_output: parseStoredValue(run.clause_output) ?? scannerFallbacks.clause_output ?? null,
    lucifer_output: parseStoredValue(run.lucifer_output) ?? scannerFallbacks.lucifer_output ?? null,
    source: inferRunSource(run),
  };

  return {
    ...serialized,
    available_agents: AGENT_NAMES.filter((agent) => serialized[AGENT_OUTPUT_KEYS[agent]] != null),
  };
}

function serializePipelineRunStep(step: PipelineRunStep): SerializedPipelineRunStep {
  return {
    ...step,
    startedAt: step.started_at,
    completedAt: step.completed_at,
    data: parseStoredValue(step.data),
  };
}

function buildReplayFrames(steps: PipelineRunStep[]): ReplayFrame[] {
  const frames: ReplayFrame[] = [];

  for (const step of steps) {
    const data = parseStoredValue(step.data);
    const base = {
      step: step.step,
      agent: step.agent,
      status: step.status,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    };

    if (step.started_at != null && step.step !== "trade") {
      frames.push({
        index: frames.length,
        type: step.step === "pipeline" ? "pipeline:start" : "agent:start",
        timestamp: step.started_at,
        ...base,
        data,
        error: step.error,
      });
    }

    if (step.completed_at != null) {
      const terminalType: ReplayFrame["type"] =
        step.step === "pipeline"
          ? "pipeline:complete"
          : step.step === "trade"
            ? step.status === "error"
              ? "trade:error"
              : step.status === "rejected"
                ? "trade:rejected"
                : "trade:executed"
            : step.status === "error"
              ? "agent:error"
              : "agent:complete";
      frames.push({
        index: frames.length,
        type: terminalType,
        timestamp: step.completed_at,
        ...base,
        data,
        error: step.error,
      });
    }
  }

  return frames
    .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index)
    .map((frame, index) => ({ ...frame, index }));
}

function buildSyntheticReplayFrames(run: SerializedPipelineRun): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  const pipelineStart = run.created_at;
  const pipelineEnd = run.completed_at ?? run.created_at;

  frames.push({
    index: 0,
    type: "pipeline:start",
    step: "pipeline",
    agent: null,
    status: "complete",
    timestamp: pipelineStart,
    startedAt: pipelineStart,
    completedAt: pipelineEnd,
  });

  AGENT_NAMES.filter((agent) => run[AGENT_OUTPUT_KEYS[agent]] != null).forEach((agent, index) => {
    const startedAt = pipelineStart + index * 250;
    const completedAt = startedAt + 180;
    const data = run[AGENT_OUTPUT_KEYS[agent]];
    frames.push({
      index: frames.length,
      type: "agent:start",
      step: agent,
      agent,
      status: "running",
      timestamp: startedAt,
      startedAt,
      completedAt,
      data,
    });
    frames.push({
      index: frames.length,
      type: "agent:complete",
      step: agent,
      agent,
      status: "complete",
      timestamp: completedAt,
      startedAt,
      completedAt,
      data,
    });
  });

  frames.push({
    index: frames.length,
    type: "pipeline:complete",
    step: "pipeline",
    agent: null,
    status: "complete",
    timestamp: pipelineEnd,
    startedAt: pipelineStart,
    completedAt: pipelineEnd,
    data: {
      decision: run.decision,
      confidence: run.confidence,
    },
  });

  return frames.map((frame, index) => ({ ...frame, index }));
}

interface OracleAgentData {
  calibrated_prob?: number;
  raw_prob?: number;
}

type ScannerPipelinePayload = Record<string, unknown>;

// AGENT_NAMES imported from ../agents/constants (replaces AGENT_NAMES)

function toRecord(raw: unknown): Record<string, unknown> | null {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

function inferRunSource(run: PipelineRun): "pipeline" | "scanner" {
  return run.id.startsWith("scanner-") ? "scanner" : "pipeline";
}

async function getScannerPayloadForRun(run: PipelineRun): Promise<ScannerPipelinePayload | null> {
  if (inferRunSource(run) !== "scanner") return null;

  if (isPgEnabled()) {
    const row = await pgQueryOne<{ pipeline_result?: string | null }>(
      "SELECT pipeline_result FROM scanner_results WHERE slug = $1 AND scanned_at = $2 ORDER BY scanned_at DESC LIMIT 1",
      [run.market_slug, run.created_at]
    );
    if (!row?.pipeline_result) return null;
    try { return JSON.parse(row.pipeline_result) as ScannerPipelinePayload; } catch { return null; }
  }

  const db = getDb();
  const row = db
    .prepare(
      "SELECT pipeline_result FROM scanner_results WHERE slug = ? AND scanned_at = ? ORDER BY scanned_at DESC LIMIT 1"
    )
    .get(run.market_slug, run.created_at) as { pipeline_result?: string | null } | undefined;

  if (!row?.pipeline_result) return null;

  try {
    return JSON.parse(row.pipeline_result) as ScannerPipelinePayload;
  } catch {
    return null;
  }
}

function buildSyntheticLuciferPayload(
  slug: string,
  scannerPayload: ScannerPipelinePayload
): Record<string, unknown> | null {
  const clause = toRecord(scannerPayload["clause"]);
  const aura = toRecord(scannerPayload["aura"]);
  const edge = toRecord(scannerPayload["edge"]) ?? toRecord(scannerPayload["edge_agent"]);

  if (!clause && !aura && !edge) return null;

  const ambiguityScore = Number(clause?.["ambiguityScore"] ?? 0.4);
  const veto = Boolean(clause?.["veto"] ?? false);
  const riskLevel = String(clause?.["riskLevel"] ?? clause?.["risk_level"] ?? "UNKNOWN");
  const sentimentDelta = Number(aura?.["sentimentDelta"] ?? aura?.["sentiment_score"] ?? 0);
  const kellyFraction = Number(
    edge?.["fractional_kelly"] ?? edge?.["kelly_fraction"] ?? edge?.["kelly_recommended"] ?? 0
  );
  const biasFlags: string[] = [];

  if (ambiguityScore > 0.5) {
    biasFlags.push(`High resolution ambiguity (score=${ambiguityScore.toFixed(2)}) may create settlement risk`);
  }
  if (kellyFraction > 0.3) {
    biasFlags.push("Sizing looks aggressive relative to the observed edge");
  }
  if (Math.abs(sentimentDelta) > 0.1) {
    biasFlags.push("Sentiment moved meaningfully, which can amplify crowd overreaction");
  }
  if (riskLevel === "HIGH") {
    biasFlags.push("Clause marked the contract as high-risk for dispute");
  }
  if (biasFlags.length === 0) {
    biasFlags.push("No major adversarial flags, but the edge still needs confirmation");
  }

  const adversarialScore = Math.min(
    0.9,
    0.25 + ambiguityScore * 0.4 + (veto ? 0.3 : 0) + (Math.abs(sentimentDelta) > 0.2 ? 0.05 : 0)
  );

  return {
    devils_advocate_score: Number(adversarialScore.toFixed(2)),
    bias_flags: biasFlags,
    counter_thesis: veto
      ? "Clause found enough contract ambiguity to invalidate the trade setup."
      : ambiguityScore > 0.5
        ? "Even a correct directional call can still lose if settlement turns subjective."
        : "The edge may be real, but it still depends on the market not overreacting to recent sentiment.",
    worst_case: veto
      ? "Full loss with dispute risk"
      : "Full loss if the edge is noise or the market reprices before resolution",
    adjusted_confidence: Number((veto ? -0.2 : ambiguityScore > 0.6 ? -0.1 : -0.03).toFixed(3)),
    pass: !veto && ambiguityScore < 0.7,
    slug,
    riskLevel,
    ambiguityScore,
  };
}

function buildScannerOutputFallbacks(
  run: PipelineRun,
  scannerPayload: ScannerPipelinePayload | null
): Partial<Record<AgentOutputKey, unknown>> {
  if (!scannerPayload) return {};

  return {
    aura_output: toRecord(scannerPayload["aura"]),
    flux_output: toRecord(scannerPayload["flux"]),
    oracle_output: toRecord(scannerPayload["oracle"]),
    edge_output: toRecord(scannerPayload["edge"]) ?? toRecord(scannerPayload["edge_agent"]),
    clause_output: toRecord(scannerPayload["clause"]),
    lucifer_output:
      toRecord(scannerPayload["lucifer"]) ??
      buildSyntheticLuciferPayload(run.market_slug, scannerPayload),
    sigma_output: toRecord(scannerPayload["sigma"]),
  };
}

function runSigma(results: Record<string, unknown>): AgentResult {
  const edge = toAgentData<EdgeAgentData>(results["edge"]);
  const lucifer = toAgentData<LuciferAgentData>(results["lucifer"]);
  const aura = toAgentData<AuraAgentData>(results["aura"]);
  const oracle = toAgentData<OracleAgentData>(results["oracle"]);
  const market = toRecord(results["market"]);

  const baseConf = oracle?.calibrated_prob ?? oracle?.raw_prob ?? edge?.estimated_true_prob ?? 0.65;
  const sentimentBoost = aura?.sentimentDelta ?? aura?.sentiment_score ?? 0;
  const kellyPct = edge?.fractional_kelly ?? edge?.kelly_fraction ?? 0;
  const adjustment = lucifer?.adjusted_confidence ?? 0;
  const finalConf = Math.max(0, Math.min(1, baseConf + adjustment));

  if (market?.["chainMode"] === "stellar_testnet") {
    const clause = toRecord(results["clause"]);
    const executionPlan = toRecord(market["executionPlan"]);
    const currentApy = Number(market["currentApy"] ?? 0);
    const protocol = typeof market["protocol"] === "string" ? market["protocol"] : "soroswap";
    const assetPair = typeof market["assetPair"] === "string" ? market["assetPair"] : "XLM/USDC";
    const riskScore = Number(market["riskScore"] ?? 0);
    const veto = Boolean(clause?.["veto"] ?? false);

    let decision: "TRADE" | "WATCH" | "SKIP" = "WATCH";
    if (veto || finalConf < 0.42) {
      decision = "SKIP";
    } else if (finalConf >= 0.58 && currentApy > 0) {
      decision = "TRADE";
    }

    return {
      agent: "sigma",
      status: "complete",
      data: {
        decision,
        recommendation: decision,
        confidence: parseFloat((finalConf * 100).toFixed(1)),
        thesis: `${protocol} ${assetPair} opportunity scored ${(finalConf * 100).toFixed(1)}% with APY ${currentApy.toFixed(2)}% and risk ${riskScore.toFixed(2)}.`,
        size_pct: kellyPct ? parseFloat((kellyPct * 100).toFixed(1)) : 2,
        size_usd: executionPlan && typeof executionPlan["amountUsdc"] === "number"
          ? Number(executionPlan["amountUsdc"])
          : 25,
        entry_price: edge?.market_price ?? Number(market["yesPrice"] ?? market["yes_price"] ?? 0.5),
        net_ev: edge?.net_ev ?? 0,
        ev_grade: edge?.ev_grade ?? "B",
        executionPlan,
      },
    };
  }

  const decision =
    finalConf > 0.6 ? "BET_YES" : finalConf < 0.4 ? "BET_NO" : "PASS";

  return {
    agent: "sigma",
    status: "complete",
    data: {
      decision,
      confidence: parseFloat((finalConf * 100).toFixed(1)),
      recommendation: decision,
      thesis: `Edge=${edge?.edge ?? "?"}, Sentiment=${sentimentBoost ?? "?"}. Lucifer adjusted ${((adjustment ?? 0) * 100).toFixed(0)}pp. Final: ${decision} @ ${(finalConf * 100).toFixed(1)}%`,
      size_pct: kellyPct ? parseFloat((kellyPct * 100).toFixed(1)) : 2,
      size_usd: kellyPct ? parseFloat((kellyPct * 100 * 10).toFixed(0)) : 20,
      entry_price: edge?.market_price ?? 0.5,
      net_ev: edge?.net_ev ?? 0,
      ev_grade: edge?.ev_grade ?? "B",
    },
  };
}

// ── Input resolution ───────────────────────────────────────────

function resolveSlug(body: Record<string, unknown>): string | null {
  if (typeof body["slug"] === "string" && body["slug"]) return body["slug"];
  if (typeof body["marketSlug"] === "string" && body["marketSlug"])
    return body["marketSlug"];
  if (typeof body["marketId"] === "string" && body["marketId"])
    return body["marketId"];
  return null;
}

// ── POST /api/pipeline/run — SSE stream ────────────────────────

router.post("/run", pipelineRateLimit, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const slug = resolveSlug(body);
  const tokenId =
    typeof body["tokenId"] === "string" && body["tokenId"]
      ? body["tokenId"]
      : null;

  if (!slug && !tokenId) {
    res.status(400).json({
      error:
        "Missing required field. Provide one of: slug, marketId, or tokenId.",
      required: ["slug", "marketId", "tokenId"],
      provided: Object.keys(body),
    });
    return;
  }

  const resolvedSlug = slug ?? tokenId ?? "";

  let effectiveSlug = resolvedSlug;
  if (!isStellarTestnetMode() && !slug && tokenId) {
    try {
      const clobMarket = await runCli(["clob", "market", tokenId]);
      if (clobMarket !== null && typeof clobMarket === "object") {
        const m = clobMarket as Record<string, unknown>;
        const marketSlug = m["market_slug"] ?? m["slug"];
        if (typeof marketSlug === "string" && marketSlug) {
          effectiveSlug = marketSlug;
        }
      }
    } catch {
      // Can't resolve slug from tokenId — use tokenId directly as identifier
    }
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const runId = uuid();
  const now = Date.now();

  // ── Derive agentId for ERC-8004 hooks (first active agent for user) ────
  let pipelineAgentId: string | null = null;
  try {
    const agentRow = isPgEnabled()
      ? await pgQueryOne<{ id: string }>(
          "SELECT id FROM agents WHERE status != 'terminated' LIMIT 1",
          []
        )
      : (getDb()
          .prepare("SELECT id FROM agents WHERE status != 'terminated' LIMIT 1")
          .get() as { id: string } | undefined);
    pipelineAgentId = agentRow?.id ?? null;
  } catch {
    // Non-blocking — pipeline continues without ERC-8004
  }

  const newRun: PipelineRun = {
    id: runId,
    market_slug: effectiveSlug,
    market_question: "",
    created_at: now,
    completed_at: null,
    decision: null,
    confidence: null,
    aura_output: null,
    flux_output: null,
    oracle_output: null,
    edge_output: null,
    sigma_output: null,
    clause_output: null,
    lucifer_output: null,
  };
  await insertPipelineRun(newRun);
  const sendEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let stepOrder = 0;
  const nextStepOrder = () => {
    stepOrder += 1;
    return stepOrder;
  };
  const beginStep = async (step: string, agent: string | null, startedAt: number = Date.now()) => {
    const stepId = uuid();
    await insertPipelineRunStep({
      id: stepId,
      run_id: runId,
      step_order: nextStepOrder(),
      step,
      agent,
      status: "running",
      started_at: startedAt,
      completed_at: null,
      data: null,
      error: null,
      created_at: startedAt,
    });
    return stepId;
  };
  const finishStep = async (
    stepId: string,
    status: string,
    data?: unknown,
    error?: string | null,
    completedAt: number = Date.now()
  ) => {
    await updatePipelineRunStep(stepId, {
      status,
      completed_at: completedAt,
      data: data !== undefined ? JSON.stringify(data) : null,
      error: error ?? null,
    });
  };

  const pipelineStepId = await beginStep("pipeline", null, now);
  sendEvent("pipeline:start", { runId, slug: effectiveSlug, timestamp: now });

  // ── Pre-fetch full market data once — shared across all agents ──
  let marketRaw: Record<string, unknown> = {};
  try {
    if (isStellarTestnetMode()) {
      marketRaw = await fetchMarketBySlug(effectiveSlug) as unknown as Record<string, unknown>;
    } else {
      marketRaw = await runCli(["markets", "get", effectiveSlug]) as Record<string, unknown>;
    }
  } catch {
    if (!isStellarTestnetMode()) {
      // CLI unavailable — fall back to Polymarket Gamma REST API (public, no auth)
      try {
        const gammaRes = await fetchWithRetry(
          `${GAMMA_API_BASE}/markets?slug=${encodeURIComponent(effectiveSlug)}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (gammaRes.ok) {
          const gammaData = await gammaRes.json() as unknown[];
          const m = (Array.isArray(gammaData) ? gammaData[0] : gammaData) as Record<string, unknown> | undefined;
          if (m) marketRaw = m;
        }
      } catch {
        sendEvent("pipeline:warning", { message: "Market data unavailable, running with defaults" });
      }
    } else {
      sendEvent("pipeline:warning", { message: "Stellar opportunity lookup failed, running with defaults" });
    }
  }

  const rawPrices = isStellarTestnetMode()
    ? [marketRaw.yes_price ?? 0.5, marketRaw.no_price ?? 0.5]
    : typeof marketRaw.outcomePrices === "string"
      ? JSON.parse(marketRaw.outcomePrices as string)
      : (marketRaw.outcomePrices ?? ["0.5", "0.5"]);
  const yes_price = parseFloat(String(rawPrices[0] ?? marketRaw.yes_price ?? "0.5")) || 0.5;
  const no_price = parseFloat(String(rawPrices[1] ?? marketRaw.no_price ?? (1 - yes_price))) || Math.max(0.05, 1 - yes_price);
  const resolution_date = String(
    marketRaw.resolution_date ??
      marketRaw.endDateIso ??
      marketRaw.endDate ??
      new Date(Date.now() + 30 * 86400000).toISOString()
  );
  const days_to_resolution = Math.max(
    1,
    Math.round((new Date(resolution_date).getTime() - Date.now()) / 86400000)
  );

  let token_id: string | undefined;
  let token_id_no: string | undefined;
  const rawTokenIds = marketRaw.clobTokenIds ?? marketRaw.tokenIds;
  if (typeof rawTokenIds === "string") {
    try {
      const parsed = JSON.parse(rawTokenIds);
      if (Array.isArray(parsed)) {
        token_id = String(parsed[0]);
        token_id_no = parsed[1] != null ? String(parsed[1]) : undefined;
      }
    } catch {
      // Ignore malformed token ID payloads
    }
  } else if (Array.isArray(rawTokenIds)) {
    token_id = String(rawTokenIds[0]);
    token_id_no = rawTokenIds[1] != null ? String(rawTokenIds[1]) : undefined;
  }

  const marketInput = {
    slug: effectiveSlug,
    question: String(marketRaw.question ?? effectiveSlug),
    description: String(marketRaw.description ?? ""),
    yes_price,
    yesPrice: yes_price,
    no_price,
    resolution_date,
    days_to_resolution,
    category: String(marketRaw.category ?? "default"),
    token_id,
    chainMode: isStellarTestnetMode() ? "stellar_testnet" : "polymarket",
    protocol: typeof marketRaw.protocol === "string" ? marketRaw.protocol : undefined,
    opportunityType: typeof marketRaw.opportunityType === "string" ? marketRaw.opportunityType : undefined,
    assetPair: typeof marketRaw.assetPair === "string" ? marketRaw.assetPair : undefined,
    currentApy: typeof marketRaw.currentApy === "number" ? marketRaw.currentApy : undefined,
    riskScore: typeof marketRaw.riskScore === "number" ? marketRaw.riskScore : undefined,
    liquidity: typeof marketRaw.liquidity === "number" ? marketRaw.liquidity : undefined,
    volume: typeof marketRaw.volume === "number" ? marketRaw.volume : undefined,
    liquidityGrade: typeof marketRaw.liquidityGrade === "string" ? marketRaw.liquidityGrade : undefined,
    executionPlan: marketRaw.executionPlan,
    poolReserves: marketRaw.poolReserves,
  };

  const completeRun = async (
    status: "complete" | "error" | "skipped",
    payload: Record<string, unknown>
  ) => {
    const finishedAt = Date.now();
    await updatePipelineRun(runId, {
      completed_at: finishedAt,
      market_question: marketInput.question,
      decision: typeof payload["decision"] === "string" ? payload["decision"] as string : null,
      confidence: typeof payload["confidence"] === "number" ? payload["confidence"] as number : null,
    });
    await finishStep(
      pipelineStepId,
      status,
      payload,
      typeof payload["error"] === "string" ? (payload["error"] as string) : null,
      finishedAt
    );
    sendEvent("pipeline:complete", { runId, ...payload });
    res.end();
  };

  const pendingOutputs: Record<string, string> = {};
  const storeAgentResult = (name: string, data: unknown) => {
    const outputKey = AGENT_OUTPUT_KEYS[name as AgentName];
    if (outputKey && data != null) {
      pendingOutputs[outputKey] = JSON.stringify(data);
    }
  };
  const flushAgentOutputs = async () => {
    if (Object.keys(pendingOutputs).length > 0) {
      await updatePipelineRun(runId, pendingOutputs as unknown as Partial<PipelineRun>);
    }
  };

  const agentStepIds = new Map<string, string>();
  const startAgent = async (agent: string) => {
    const stepId = await beginStep(agent, agent);
    agentStepIds.set(agent, stepId);
    sendEvent("agent:start", { agent });
  };
  const completeAgent = async (agent: string, data: unknown) => {
    const stepId = agentStepIds.get(agent);
    if (stepId) await finishStep(stepId, "complete", data, null);
    sendEvent("agent:complete", { agent, status: "complete", data });
    storeAgentResult(agent, data);
  };
  const errorAgent = async (agent: string, error: string) => {
    const stepId = agentStepIds.get(agent);
    if (stepId) await finishStep(stepId, "error", { message: error }, error);
    sendEvent("agent:error", { agent, status: "error", data: error, error });
  };

  // ── Phase 1: Aura, Flux, Clause in parallel ──
  await Promise.all(["aura", "flux", "clause"].map(startAgent));

  const [auraRes, fluxRes, clauseRes] = await Promise.allSettled([
    trackAgent("aura", () =>
      withAgentTimeout(
        "aura",
        runAura({
          slug: marketInput.slug,
          question: marketInput.question,
          category: marketInput.category,
        }),
        30000
      )
    ),
    trackAgent("flux", () =>
      withAgentTimeout(
        "flux",
        runFlux({ slug: marketInput.slug, token_id: marketInput.token_id, token_id_alt: token_id_no }),
        10000
      )
    ),
    trackAgent("clause", () =>
      withAgentTimeout(
        "clause",
        runClause({
          slug: marketInput.slug,
          question: marketInput.question,
          description: marketInput.description,
          days_to_resolution: marketInput.days_to_resolution,
        }),
        15000
      )
    ),
  ]);
  const auraResult = auraRes.status === "fulfilled" ? auraRes.value : null;
  const fluxResult = fluxRes.status === "fulfilled" ? fluxRes.value : null;
  const clauseResult = clauseRes.status === "fulfilled" ? clauseRes.value : null;

  if (auraResult) await completeAgent("aura", auraResult);
  else await errorAgent("aura", auraRes.status === "rejected" ? String(auraRes.reason) : "unknown");

  if (fluxResult) await completeAgent("flux", fluxResult);
  else await errorAgent("flux", fluxRes.status === "rejected" ? String(fluxRes.reason) : "unknown");

  if (clauseResult) await completeAgent("clause", clauseResult);
  else await errorAgent("clause", clauseRes.status === "rejected" ? String(clauseRes.reason) : "unknown");

  // ── Phase 2: Oracle (after Aura so it can read aura_results from DB) ──
  await startAgent("oracle");
  let oracleResult: Record<string, unknown> | null = null;
  try {
    oracleResult = await trackAgent("oracle", () =>
      withAgentTimeout("oracle", runOracle(marketInput), 30000)
    ) as unknown as Record<string, unknown>;
  } catch {
    // Oracle failed
  }
  if (!oracleResult) {
    const error = "Oracle failed or timed out";
    sendEvent("pipeline:skip", { slug: effectiveSlug, reason: "oracle_failed", runId });
    await errorAgent("oracle", error);
    await flushAgentOutputs();
    await completeRun("error", { decision: "SKIP", confidence: null, error });
    return;
  }
  await completeAgent("oracle", oracleResult);

  // ── Phase 3: Edge (needs oracle result) ──
  await startAgent("edge");
  let edgeResult: Record<string, unknown> | null = null;
  try {
    edgeResult = await trackAgent("edge", () =>
      withAgentTimeout("edge", runEdge(marketInput, oracleResult), 15000)
    ) as unknown as Record<string, unknown>;
  } catch {
    // Edge failed
  }
  if (!edgeResult) {
    const error = "Edge failed or timed out";
    sendEvent("pipeline:skip", { slug: effectiveSlug, reason: "edge_failed", runId });
    await errorAgent("edge", error);
    await flushAgentOutputs();
    await completeRun("error", { decision: "SKIP", confidence: null, error });
    return;
  }
  await completeAgent("edge", edgeResult);

  // ── Phase 4: Lucifer (reads from collected results) ──
  await startAgent("lucifer");
  const combinedResults: Record<string, unknown> = {
    market: marketInput,
    aura: auraResult,
    flux: fluxResult,
    clause: clauseResult,
    oracle: oracleResult,
    edge: edgeResult,
  };
  const luciferResult = await trackAgent("lucifer", () => runLucifer(effectiveSlug, combinedResults));
  combinedResults.lucifer = luciferResult?.data;
  await completeAgent("lucifer", luciferResult?.data ?? null);

  // ── Phase 5: Sigma (reads combinedResults) ──
  await startAgent("sigma");
  const sigma = trackAgentSync("sigma", () => runSigma(combinedResults));
  combinedResults["sigma"] = sigma.data;
  await completeAgent("sigma", sigma.data);

  const sigmaData = sigma.data as Record<string, unknown>;

  // ── Auto-execute if SIGMA says BET_YES or BET_NO ───────────────
  const decision = sigmaData["decision"];
  let executionResult: Record<string, unknown> | null = null;

  try {
    if (isStellarTestnetMode()) {
      const tradeStepId = await beginStep("trade", "sigma");
      executionResult = decision === "TRADE"
        ? {
            status: "manual_required",
            paper: false,
            reason: "Stellar execution is available only through the manual /api/stellar/execute flow in v1.",
            executionPlan: sigmaData["executionPlan"] ?? marketInput.executionPlan ?? null,
          }
        : {
            status: "skipped",
            reason: "Sigma did not recommend a live Stellar swap.",
            executionPlan: sigmaData["executionPlan"] ?? marketInput.executionPlan ?? null,
          };
      await finishStep(tradeStepId, "skipped", executionResult, null);
    } else if (isKrakenMode()) {
      // ── Kraken paper trading via CLI ─────────────────────────
      const tradeStepId = await beginStep("trade", "sigma");
      if (decision === "BET_YES" || decision === "BET_NO") {
        const direction = decision === "BET_YES" ? "YES" : "NO";
        const sizeUsd = typeof sigmaData["size_usd"] === "number" ? sigmaData["size_usd"] : 10;
        const pipelineSignal: import("../execution").TradeSignal = {
          slug: effectiveSlug,
          direction: direction as "YES" | "NO",
          sizeUsdc: sizeUsd,
        };
        const krakenSignal = mapPipelineSignalToKraken(pipelineSignal, "BTCUSD");
        try {
          const krakenResult = await executeKrakenTrade(krakenSignal);
          executionResult = {
            status: krakenResult.success ? "executed" : "failed",
            paper: true,
            engine: "kraken",
            pair: krakenResult.pair,
            direction: krakenResult.direction,
            amount: krakenResult.amount,
            orderId: krakenResult.orderId ?? null,
            timestamp: krakenResult.timestamp,
          };
          await finishStep(tradeStepId, krakenResult.success ? "complete" : "error", executionResult, krakenResult.success ? null : "Kraken paper trade failed");
          sendEvent(krakenResult.success ? "trade:executed" : "trade:error", { slug: effectiveSlug, engine: "kraken", ...executionResult });
        } catch (krakenErr) {
          const error = krakenErr instanceof Error ? krakenErr.message : String(krakenErr);
          executionResult = { status: "error", paper: true, engine: "kraken", error };
          await finishStep(tradeStepId, "error", executionResult, error);
          sendEvent("trade:error", { slug: effectiveSlug, engine: "kraken", error });
          console.error("[Pipeline] Kraken paper execution failed:", krakenErr);
        }
      } else {
        executionResult = { status: "skipped", engine: "kraken", reason: "Sigma returned PASS/skip." };
        await finishStep(tradeStepId, "skipped", executionResult, null);
      }
    } else if (decision === "BET_YES" || decision === "BET_NO") {
      const tradeStepId = await beginStep("trade", "sigma");
      const direction = decision === "BET_YES" ? "YES" : "NO";
      const sizeUsd =
        typeof sigmaData["size_usd"] === "number" ? sigmaData["size_usd"] : 10;
      const entryPrice =
        typeof sigmaData["entry_price"] === "number"
          ? sigmaData["entry_price"]
          : 0.5;
      const resolvedTokenId = direction === "YES" ? token_id : token_id_no;

      try {
        const riskApproval = await approvePosition(
          effectiveSlug,
          sizeUsd,
          marketInput.category
        );
        if (!riskApproval.approved) {
          executionResult = {
            status: "rejected",
            reason: riskApproval.reason,
            approved: false,
          };
          await finishStep(tradeStepId, "rejected", executionResult, String(riskApproval.reason));
          sendEvent("trade:rejected", { reason: riskApproval.reason, slug: effectiveSlug });
        } else {
          // ── ERC-8004: Submit validation request before trade ────────
          let erc8004RequestHash: string | null = null;
          if (pipelineAgentId && isErc8004Configured()) {
            try {
              const agentIdentity = await getAgentIdentity(pipelineAgentId);
              if (agentIdentity?.tokenId) {
                const validationResult = await submitValidationRequest(
                  agentIdentity.tokenId,
                  pipelineAgentId,
                  runId,
                  {
                    slug: effectiveSlug,
                    direction,
                    sizeUsdc: riskApproval.adjustedSize,
                    price: entryPrice,
                    riskApproved: true,
                    timestamp: Date.now(),
                  }
                );
                erc8004RequestHash = validationResult.requestHash;
                console.log(`[Pipeline][ERC-8004] Validation request submitted: ${validationResult.txHash}`);
              }
            } catch (erc8004Err) {
              // Non-blocking — trade proceeds even if ERC-8004 fails
              console.warn("[Pipeline][ERC-8004] Validation request failed:", erc8004Err instanceof Error ? erc8004Err.message : String(erc8004Err));
            }
          }

          const result = await execute(
            {
              slug: effectiveSlug,
              direction,
              sizeUsdc: riskApproval.adjustedSize,
              tokenId: resolvedTokenId,
              price: entryPrice,
            },
            riskApproval
          );
          executionResult = result as unknown as Record<string, unknown>;
          await finishStep(tradeStepId, "executed", executionResult, null);
          sendEvent("trade:executed", {
            slug: effectiveSlug,
            direction,
            orderId: result.orderId,
            status: result.status,
            execution_mode: result.execution_mode,
            filledPrice: result.filledPrice,
            filledSize: result.filledSize,
          });
          console.log(
            `[Pipeline] Auto-executed ${direction} on ${effectiveSlug} — orderId=${result.orderId} mode=${result.execution_mode}`
          );

          // ── ERC-8004: Submit validation response after trade ────────
          if (pipelineAgentId && isErc8004Configured() && erc8004RequestHash) {
            try {
              const agentIdentity = await getAgentIdentity(pipelineAgentId);
              if (agentIdentity?.tokenId) {
                const responseResult = await submitValidationResponse(
                  erc8004RequestHash,
                  pipelineAgentId,
                  runId,
                  result.status === "submitted" || result.status === "filled",
                  {
                    orderId: result.orderId,
                    status: result.status,
                    filledPrice: result.filledPrice,
                    filledSize: result.filledSize,
                    execution_mode: result.execution_mode,
                    timestamp: Date.now(),
                  }
                );
                console.log(`[Pipeline][ERC-8004] Validation response submitted: ${responseResult.txHash}`);

                // ── ERC-8004: Submit reputation feedback (ERC-02) ────────
                // Derive PnL basis points from filled price vs entry price
                const pnlBps =
                  result.filledPrice && entryPrice
                    ? Math.round(
                        ((result.filledPrice - entryPrice) / entryPrice) * 10000
                      )
                    : 0;
                const feedbackResult = await submitFeedback(
                  agentIdentity.tokenId,
                  pnlBps
                );
                console.log(
                  `[Pipeline][ERC-8004] Reputation feedback submitted: ${feedbackResult.txHash} (${pnlBps} bps)`
                );
              }
            } catch (erc8004Err) {
              // Non-blocking — don't fail the pipeline for ERC-8004 issues
              console.warn("[Pipeline][ERC-8004] Validation/reputation failed:", erc8004Err instanceof Error ? erc8004Err.message : String(erc8004Err));
            }
          }
        }
      } catch (execErr) {
        const error = String(execErr);
        executionResult = { status: "error", error };
        await finishStep(tradeStepId, "error", executionResult, error);
        sendEvent("trade:error", { slug: effectiveSlug, error });
        console.error("[Pipeline] Auto-execution failed:", execErr);
      }
    } else {
      const tradeStepId = await beginStep("trade", "sigma");
      executionResult = { status: "skipped", reason: "Sigma returned PASS/skip." };
      await finishStep(tradeStepId, "skipped", executionResult, null);
    }
  } finally {
    await flushAgentOutputs();
  }

  await completeRun("complete", {
    decision: sigmaData["decision"],
    confidence: sigmaData["confidence"],
    execution: executionResult,
    executionPlan: sigmaData["executionPlan"] ?? marketInput.executionPlan ?? null,
  });
});

// ── GET /api/pipeline/results — formatted signals for frontend ─
// Mirrors /api/signals logic: uses persisted signal_state, consistent edge extraction
router.get("/results", async (_req: Request, res: Response) => {
  try {
    const runs = await getPipelineHistory(20);
    const signals = runs.map((r) => {
      let edge = 0;
      if (r.edge_output) {
        try {
          const edgeData = JSON.parse(r.edge_output) as Record<string, unknown>;
          edge =
            typeof edgeData["net_edge"] === "number" ? edgeData["net_edge"]
              : typeof edgeData["edge"] === "number" ? edgeData["edge"]
              : typeof edgeData["net_ev"] === "number" ? edgeData["net_ev"]
              : 0;
        } catch { /* ignore parse error */ }
      }

      // Use persisted signal_state if available (set by /api/signals/validate)
      const row = r as PipelineRun & { signal_state?: string };
      let status: "TRADE" | "WATCH" | "SKIP" = "WATCH";
      if (row.signal_state === "TRADE" || row.signal_state === "WATCH" || row.signal_state === "SKIP") {
        status = row.signal_state;
      } else if (r.sigma_output) {
        try {
          const sigma = JSON.parse(r.sigma_output) as Record<string, unknown>;
          const rec = sigma["recommendation"] ?? sigma["decision"];
          if (rec === "TRADE" || rec === "BUY_YES" || rec === "BUY_NO") status = "TRADE";
          else if (rec === "SKIP" || rec === "HOLD") status = "SKIP";
        } catch { /* ignore */ }
      }

      return {
        id: r.id,
        slug: r.market_slug,
        question: r.market_question || r.market_slug,
        decision: r.decision ?? "HOLD",
        confidence: r.confidence ?? 0,
        edge,
        timestamp: r.created_at,
        status,
      };
    });
    res.json(signals);
  } catch (err) {
    const msg = err instanceof CliError ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/pipeline/history ──────────────────────────────────
router.get("/history", async (_req: Request, res: Response) => {
  try {
    const runs = await getPipelineHistory(20);
    const parsed = await Promise.all(
      runs.map(async (run) =>
        serializePipelineRun(run, await getScannerPayloadForRun(run))
      )
    );
    res.json(parsed);
  } catch (err) {
    const msg = err instanceof CliError ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/history/:id/replay", async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params["id"]) ? req.params["id"][0] : req.params["id"];
    const run = await getPipelineRunById(id);
    if (!run) {
      res.status(404).json({ error: `Pipeline run '${id}' not found` });
      return;
    }

    const scannerPayload = await getScannerPayloadForRun(run);
    const serializedRun = await serializePipelineRun(run, scannerPayload);
    const steps = await getPipelineRunSteps(id);
    res.json({
      run: serializedRun,
      frames: steps.length > 0 ? buildReplayFrames(steps) : buildSyntheticReplayFrames(serializedRun),
    });
  } catch (err) {
    const msg = err instanceof CliError ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/history/:id", async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params["id"]) ? req.params["id"][0] : req.params["id"];
    const run = await getPipelineRunById(id);
    if (!run) {
      res.status(404).json({ error: `Pipeline run '${id}' not found` });
      return;
    }

    const steps = (await getPipelineRunSteps(id)).map(serializePipelineRunStep);
    res.json({
      run: await serializePipelineRun(run, await getScannerPayloadForRun(run)),
      steps,
    });
  } catch (err) {
    const msg = err instanceof CliError ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
