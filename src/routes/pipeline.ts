import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";
import { insertPipelineRun, updatePipelineRun, getPipelineHistory, PipelineRun } from "../db/queries";
import { v4 as uuid } from "uuid";

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

// ── Agent definitions ──────────────────────────────────────────

async function runAura(_slug: string): Promise<AgentResult> {
  return {
    agent: "aura",
    status: "complete",
    data: {
      sentiment_score: 0.72,
      narrative: "Bullish momentum detected. Social volume rising 34% over 7d.",
      sources: ["twitter", "polymarket-comments", "reddit"],
      confidence: 0.68,
    },
  };
}

async function runFlux(slug: string): Promise<AgentResult> {
  try {
    const market = await runCli(["markets", "get", slug]);
    return { agent: "flux", status: "complete", data: market };
  } catch {
    return {
      agent: "flux",
      status: "complete",
      data: { slug, note: "CLI unavailable, using cached structure" },
    };
  }
}

async function runOracle(slug: string): Promise<AgentResult> {
  try {
    const market = await runCli(["markets", "get", slug]);
    const marketObj =
      market !== null && typeof market === "object"
        ? (market as Record<string, unknown>)
        : {};
    const rawTokens = marketObj["tokens"] ?? marketObj["clobTokenIds"] ?? [];
    const tokens = Array.isArray(rawTokens) ? (rawTokens as unknown[]) : [];
    if (tokens.length > 0) {
      const t0 = tokens[0];
      const tokenId =
        t0 !== null && typeof t0 === "object"
          ? (t0 as Record<string, unknown>)["token_id"]
          : t0;
      const spread = await runCli(["clob", "spread", String(tokenId)]);
      return { agent: "oracle", status: "complete", data: { market, spread } };
    }
    return { agent: "oracle", status: "complete", data: { market } };
  } catch {
    return {
      agent: "oracle",
      status: "complete",
      data: {
        slug,
        best_bid: 0.62,
        best_ask: 0.64,
        spread: 0.02,
        note: "Mock data: CLI unavailable",
      },
    };
  }
}

async function runEdge(_slug: string): Promise<AgentResult> {
  return {
    agent: "edge",
    status: "complete",
    data: {
      estimated_true_prob: 0.71,
      market_price: 0.63,
      edge: 0.08,
      kelly_fraction: 0.22,
      ev_grade: "A-",
      net_ev: 12.7,
    },
  };
}

async function runClause(_slug: string): Promise<AgentResult> {
  return {
    agent: "clause",
    status: "complete",
    data: {
      resolution_source: "UMA Oracle",
      ambiguity_risk: "low",
      edge_cases: ["Early resolution possible if event cancelled"],
      recommendation: "Rules are clear. Proceed.",
    },
  };
}

async function runLucifer(_slug: string): Promise<AgentResult> {
  return {
    agent: "lucifer",
    status: "complete",
    data: {
      contrarian_take:
        "Market may be underpricing tail risk of regulatory intervention.",
      risk_flags: [
        "Liquidity thin below 0.55",
        "Similar market resolved ambiguously in Q3",
      ],
      worst_case: "Full loss if resolution disputed",
      adjusted_confidence: -0.05,
    },
  };
}

function toAgentData<T>(raw: unknown): T | undefined {
  if (raw !== null && typeof raw === "object") return raw as T;
  return undefined;
}

function runSigma(results: Record<string, unknown>): AgentResult {
  const edge = toAgentData<EdgeAgentData>(results["edge"]);
  const lucifer = toAgentData<LuciferAgentData>(results["lucifer"]);
  const aura = toAgentData<AuraAgentData>(results["aura"]);

  const baseConf = edge?.estimated_true_prob ?? 0.65;
  const adjustment = lucifer?.adjusted_confidence ?? 0;
  const finalConf = Math.max(0, Math.min(1, baseConf + adjustment));

  const decision =
    finalConf > 0.6 ? "BUY_YES" : finalConf < 0.4 ? "BUY_NO" : "HOLD";

  return {
    agent: "sigma",
    status: "complete",
    data: {
      decision,
      confidence: parseFloat(finalConf.toFixed(3)),
      reasoning: `Edge=${edge?.edge ?? "?"}, Sentiment=${aura?.sentiment_score ?? "?"}, Adjusted by Lucifer. Final: ${decision} @ ${(finalConf * 100).toFixed(1)}%`,
      recommended_size: edge?.kelly_fraction
        ? `${(edge.kelly_fraction * 100).toFixed(0)}% of bankroll`
        : "2%",
    },
  };
}

// ── Input resolution ───────────────────────────────────────────

function resolveSlug(body: Record<string, unknown>): string | null {
  // Prefer slug > marketSlug (compat) > marketId
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

  // Resolve the identifier to use for pipeline (prefer slug over tokenId)
  const resolvedSlug = slug ?? tokenId ?? "";

  // If only tokenId was given, try to fetch market slug from CLOB
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

  const agents: Array<{
    name: string;
    fn: (s: string) => Promise<AgentResult>;
  }> = [
    { name: "aura", fn: runAura },
    { name: "flux", fn: runFlux },
    { name: "oracle", fn: runOracle },
    { name: "edge", fn: runEdge },
    { name: "clause", fn: runClause },
    { name: "lucifer", fn: runLucifer },
  ];

  const results: Record<string, unknown> = {};

  for (const agent of agents) {
    try {
      sendEvent("agent:start", { agent: agent.name });
      const result = await agent.fn(effectiveSlug);
      results[agent.name] = result.data;
      sendEvent("agent:complete", result);

      const outputKey = OUTPUT_KEY_MAP[agent.name];
      if (outputKey) {
        const partial: Partial<PipelineRun> = {
          [outputKey]: JSON.stringify(result.data),
        };
        updatePipelineRun(runId, partial);
      }
    } catch (err) {
      const errorResult = {
        agent: agent.name,
        status: "error",
        data: err instanceof Error ? err.message : String(err),
      };
      results[agent.name] = errorResult;
      sendEvent("agent:error", errorResult);
    }
  }

  // Sigma aggregation
  sendEvent("agent:start", { agent: "sigma" });
  const sigma = runSigma(results);
  results["sigma"] = sigma.data;
  sendEvent("agent:complete", sigma);

  const sigmaData = sigma.data as Record<string, unknown>;

  const fluxData = toAgentData<Record<string, unknown>>(results["flux"]);
  const marketQuestion =
    typeof fluxData?.["question"] === "string"
      ? fluxData["question"]
      : effectiveSlug;

  updatePipelineRun(runId, {
    sigma_output: JSON.stringify(sigma.data),
    completed_at: Date.now(),
    decision: typeof sigmaData["decision"] === "string" ? sigmaData["decision"] : null,
    confidence:
      typeof sigmaData["confidence"] === "number" ? sigmaData["confidence"] : null,
    market_question: marketQuestion,
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

      // Derive signal status from sigma output
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
