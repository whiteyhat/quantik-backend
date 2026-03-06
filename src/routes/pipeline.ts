import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";
import { insertPipelineRun, updatePipelineRun, getPipelineHistory, PipelineRun } from "../db/queries";
import { v4 as uuid } from "uuid";
import { runAura } from "../aura/index";
import { runOracle } from "../oracle/index";
import { runEdge } from "../edge/index";
import { runFlux } from "../flux/index";
import { runClause } from "../clause/index";
import { runLucifer } from "../lucifer/index";

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

type AgentOutputKey =
  | "aura_output"
  | "flux_output"
  | "oracle_output"
  | "edge_output"
  | "clause_output"
  | "lucifer_output"
  | "sigma_output";

const OUTPUT_KEY_MAP: Record<string, AgentOutputKey> = {
  aura: "aura_output",
  flux: "flux_output",
  oracle: "oracle_output",
  edge: "edge_output",
  clause: "clause_output",
  lucifer: "lucifer_output",
  sigma: "sigma_output",
};

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

interface OracleAgentData {
  calibrated_prob?: number;
  raw_prob?: number;
}

function runSigma(results: Record<string, unknown>): AgentResult {
  const edge = toAgentData<EdgeAgentData>(results["edge"]);
  const lucifer = toAgentData<LuciferAgentData>(results["lucifer"]);
  const aura = toAgentData<AuraAgentData>(results["aura"]);
  const oracle = toAgentData<OracleAgentData>(results["oracle"]);

  const baseConf = oracle?.calibrated_prob ?? oracle?.raw_prob ?? edge?.estimated_true_prob ?? 0.65;
  const sentimentBoost = aura?.sentimentDelta ?? aura?.sentiment_score ?? 0;
  const kellyPct = edge?.fractional_kelly ?? edge?.kelly_fraction ?? 0;
  const adjustment = lucifer?.adjusted_confidence ?? 0;
  const finalConf = Math.max(0, Math.min(1, baseConf + adjustment));

  const decision =
    finalConf > 0.6 ? "BET_YES" : finalConf < 0.4 ? "BET_NO" : "PASS";

  return {
    agent: "sigma",
    status: "complete",
    data: {
      decision,
      confidence: parseFloat((finalConf * 100).toFixed(1)),
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

router.post("/run", async (req: Request, res: Response) => {
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
  if (!slug && tokenId) {
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
  insertPipelineRun(newRun);

  const sendEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("pipeline:start", { runId, slug: effectiveSlug, timestamp: now });

  // ── Pre-fetch full market data once — shared across all agents ──
  let marketRaw: Record<string, unknown> = {};
  try {
    marketRaw = await runCli(["markets", "get", effectiveSlug]) as Record<string, unknown>;
  } catch {
    // CLI unavailable — fall back to Polymarket Gamma REST API (public, no auth)
    try {
      const gammaRes = await fetch(
        `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(effectiveSlug)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (gammaRes.ok) {
        const gammaData = await gammaRes.json() as unknown[];
        const m = (Array.isArray(gammaData) ? gammaData[0] : gammaData) as Record<string, unknown> | undefined;
        if (m) marketRaw = m;
      }
    } catch {
      // Both sources failed — pipeline continues with slug as question and 0.5 default price
      sendEvent("pipeline:warning", { message: "Market data unavailable, running with defaults" });
    }
  }

  const rawPrices = typeof marketRaw.outcomePrices === "string"
    ? JSON.parse(marketRaw.outcomePrices as string)
    : (marketRaw.outcomePrices ?? ["0.5","0.5"]);
  const yes_price = parseFloat(String(rawPrices[0] ?? "0.5")) || 0.5;
  const resolution_date = String(marketRaw.endDateIso ?? marketRaw.endDate ?? new Date(Date.now() + 30*86400000).toISOString());
  const days_to_resolution = Math.max(1, Math.round((new Date(resolution_date).getTime() - Date.now()) / 86400000));

  // clobTokenIds[0] for Flux
  let token_id: string | undefined;
  const rawTokenIds = marketRaw.clobTokenIds ?? marketRaw.tokenIds;
  if (typeof rawTokenIds === "string") {
    try { const p = JSON.parse(rawTokenIds); token_id = Array.isArray(p) ? String(p[0]) : undefined; } catch { /* ignore */ }
  } else if (Array.isArray(rawTokenIds)) {
    token_id = String(rawTokenIds[0]);
  }

  const marketInput = {
    slug: effectiveSlug,
    question: String(marketRaw.question ?? effectiveSlug),
    description: String(marketRaw.description ?? ""),
    yes_price,
    resolution_date,
    days_to_resolution,
    category: String(marketRaw.category ?? "default"),
    token_id,
  };

  const storeAgentResult = (name: string, data: unknown) => {
    const outputKey = OUTPUT_KEY_MAP[name];
    if (outputKey) {
      updatePipelineRun(runId, { [outputKey]: JSON.stringify(data) } as Partial<PipelineRun>);
    }
  };

  // ── Phase 1: Aura, Flux, Clause in parallel ──
  sendEvent("agent:start", { agent: "aura" });
  sendEvent("agent:start", { agent: "flux" });
  sendEvent("agent:start", { agent: "clause" });

  const [auraRes, fluxRes, clauseRes] = await Promise.allSettled([
    withAgentTimeout("aura", runAura({ slug: marketInput.slug, question: marketInput.question, category: marketInput.category }), 30000),
    withAgentTimeout("flux", runFlux({ slug: marketInput.slug, token_id: marketInput.token_id }), 10000),
    withAgentTimeout("clause", runClause({ slug: marketInput.slug, question: marketInput.question, description: marketInput.description, days_to_resolution: marketInput.days_to_resolution }), 15000),
  ]);
  const auraResult = auraRes.status === "fulfilled" ? auraRes.value : null;
  const fluxResult = fluxRes.status === "fulfilled" ? fluxRes.value : null;
  const clauseResult = clauseRes.status === "fulfilled" ? clauseRes.value : null;

  if (auraResult) {
    sendEvent("agent:complete", { agent: "aura", status: "complete", data: auraResult });
    storeAgentResult("aura", auraResult);
  } else {
    sendEvent("agent:error", { agent: "aura", status: "error", data: auraRes.status === "rejected" ? String((auraRes as PromiseRejectedResult).reason) : "unknown" });
  }
  if (fluxResult) {
    sendEvent("agent:complete", { agent: "flux", status: "complete", data: fluxResult });
    storeAgentResult("flux", fluxResult);
  } else {
    sendEvent("agent:error", { agent: "flux", status: "error", data: fluxRes.status === "rejected" ? String((fluxRes as PromiseRejectedResult).reason) : "unknown" });
  }
  if (clauseResult) {
    sendEvent("agent:complete", { agent: "clause", status: "complete", data: clauseResult });
    storeAgentResult("clause", clauseResult);
  } else {
    sendEvent("agent:error", { agent: "clause", status: "error", data: clauseRes.status === "rejected" ? String((clauseRes as PromiseRejectedResult).reason) : "unknown" });
  }

  // ── Phase 2: Oracle (after Aura so it can read aura_results from DB) ──
  sendEvent("agent:start", { agent: "oracle" });
  let oracleResult: any = null;
  try {
    oracleResult = await withAgentTimeout("oracle", runOracle(marketInput), 30000);
  } catch { /* Oracle failed */ }
  if (!oracleResult) {
    sendEvent("pipeline:skip", { slug: effectiveSlug, reason: "oracle_failed", runId });
    sendEvent("agent:error", { agent: "oracle", status: "error", data: "Oracle failed or timed out" });
    res.end();
    return;
  }
  sendEvent("agent:complete", { agent: "oracle", status: "complete", data: oracleResult });
  storeAgentResult("oracle", oracleResult);

  // ── Phase 3: Edge (needs oracle result) ──
  sendEvent("agent:start", { agent: "edge" });
  let edgeResult: any = null;
  try {
    edgeResult = await withAgentTimeout("edge", runEdge(marketInput, oracleResult), 15000);
  } catch { /* Edge failed */ }
  if (!edgeResult) {
    sendEvent("pipeline:skip", { slug: effectiveSlug, reason: "edge_failed", runId });
    sendEvent("agent:error", { agent: "edge", status: "error", data: "Edge failed or timed out" });
    res.end();
    return;
  }
  sendEvent("agent:complete", { agent: "edge", status: "complete", data: edgeResult });
  storeAgentResult("edge", edgeResult);

  // ── Phase 4: Lucifer (reads from collected results) ──
  sendEvent("agent:start", { agent: "lucifer" });
  const combinedResults: Record<string, unknown> = {
    aura: auraResult,
    flux: fluxResult,
    clause: clauseResult,
    oracle: oracleResult,
    edge: edgeResult,
  };
  const luciferResult = await runLucifer(effectiveSlug, combinedResults);
  combinedResults.lucifer = luciferResult?.data;
  sendEvent("agent:complete", { agent: "lucifer", status: "complete", data: luciferResult?.data });
  storeAgentResult("lucifer", luciferResult?.data);

  // ── Phase 5: Sigma (reads combinedResults) ──
  sendEvent("agent:start", { agent: "sigma" });
  const sigma = runSigma(combinedResults);
  combinedResults["sigma"] = sigma.data;
  sendEvent("agent:complete", sigma);

  const sigmaData = sigma.data as Record<string, unknown>;

  updatePipelineRun(runId, {
    sigma_output: JSON.stringify(sigma.data),
    completed_at: Date.now(),
    decision: typeof sigmaData["decision"] === "string" ? sigmaData["decision"] : null,
    confidence:
      typeof sigmaData["confidence"] === "number" ? sigmaData["confidence"] : null,
    market_question: marketInput.question,
  });

  sendEvent("pipeline:complete", {
    runId,
    decision: sigmaData["decision"],
    confidence: sigmaData["confidence"],
  });

  res.end();
});

// ── GET /api/pipeline/results — formatted signals for frontend ─
router.get("/results", (_req: Request, res: Response) => {
  try {
    const runs = getPipelineHistory(20);
    const signals = runs.map((r) => {
      let edge: number | null = null;
      if (r.edge_output) {
        try {
          const edgeData = JSON.parse(r.edge_output) as Record<string, unknown>;
          edge = typeof edgeData["edge"] === "number" ? edgeData["edge"]
               : typeof edgeData["net_edge"] === "number" ? edgeData["net_edge"]
               : typeof edgeData["net_ev"] === "number" ? edgeData["net_ev"]
               : null;
        } catch { /* ignore parse error */ }
      }

      let status: "TRADE" | "WATCH" | "SKIP" = "WATCH";
      if (r.sigma_output) {
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
        edge: edge ?? 0,
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
router.get("/history", (_req: Request, res: Response) => {
  try {
    const runs = getPipelineHistory(20);
    const parsed = runs.map((r) => ({
      ...r,
      aura_output: r.aura_output ? (JSON.parse(r.aura_output) as unknown) : null,
      flux_output: r.flux_output ? (JSON.parse(r.flux_output) as unknown) : null,
      oracle_output: r.oracle_output
        ? (JSON.parse(r.oracle_output) as unknown)
        : null,
      edge_output: r.edge_output ? (JSON.parse(r.edge_output) as unknown) : null,
      sigma_output: r.sigma_output
        ? (JSON.parse(r.sigma_output) as unknown)
        : null,
      clause_output: r.clause_output
        ? (JSON.parse(r.clause_output) as unknown)
        : null,
      lucifer_output: r.lucifer_output
        ? (JSON.parse(r.lucifer_output) as unknown)
        : null,
    }));
    res.json(parsed);
  } catch (err) {
    const msg = err instanceof CliError ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
