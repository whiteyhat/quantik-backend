import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";
import { insertPipelineRun, updatePipelineRun, getPipelineHistory } from "../db/queries";
import { v4 as uuid } from "uuid";

const router = Router();

// ── Agent definitions ──────────────────────────────────────────

interface AgentResult {
  agent: string;
  status: "complete" | "error";
  data: unknown;
}

async function runAura(slug: string): Promise<AgentResult> {
  // Aura: Sentiment & narrative scanner (mock for now)
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
  // Flux: Market data fetcher (real CLI call)
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
  // Oracle: On-chain / price data (real CLI when possible)
  try {
    const market = await runCli(["markets", "get", slug]);
    const tokens = market?.tokens || market?.clobTokenIds || [];
    if (tokens.length > 0) {
      const tokenId = typeof tokens[0] === "object" ? tokens[0].token_id : tokens[0];
      const spread = await runCli(["clob", "spread", tokenId]);
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
  // Edge: EV calculator (mock)
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
  // Clause: Resolution rules auditor (mock)
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
  // Lucifer: Devil's advocate (mock)
  return {
    agent: "lucifer",
    status: "complete",
    data: {
      contrarian_take: "Market may be underpricing tail risk of regulatory intervention.",
      risk_flags: ["Liquidity thin below 0.55", "Similar market resolved ambiguously in Q3"],
      worst_case: "Full loss if resolution disputed",
      adjusted_confidence: -0.05,
    },
  };
}

function runSigma(results: Record<string, unknown>): AgentResult {
  // Sigma: Final decision aggregator (mock logic)
  const edge = results.edge as any;
  const lucifer = results.lucifer as any;
  const aura = results.aura as any;

  const baseConf = edge?.estimated_true_prob ?? 0.65;
  const adjustment = lucifer?.adjusted_confidence ?? 0;
  const finalConf = Math.max(0, Math.min(1, baseConf + adjustment));

  const decision = finalConf > 0.6 ? "BUY_YES" : finalConf < 0.4 ? "BUY_NO" : "HOLD";

  return {
    agent: "sigma",
    status: "complete",
    data: {
      decision,
      confidence: parseFloat(finalConf.toFixed(3)),
      reasoning: `Edge=${edge?.edge ?? "?"}, Sentiment=${aura?.sentiment_score ?? "?"}, Adjusted by Lucifer. Final: ${decision} @ ${(finalConf * 100).toFixed(1)}%`,
      recommended_size: edge?.kelly_fraction ? `${(edge.kelly_fraction * 100).toFixed(0)}% of bankroll` : "2%",
    },
  };
}

// ── POST /api/pipeline/run — SSE stream ────────────────────────

router.post("/run", async (req: Request, res: Response) => {
  const { marketSlug } = req.body;
  if (!marketSlug) {
    res.status(400).json({ error: "Missing required field: marketSlug" });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const runId = uuid();
  const now = Date.now();

  insertPipelineRun({
    id: runId,
    market_slug: marketSlug,
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
  });

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("pipeline:start", { runId, marketSlug, timestamp: now });

  const agents: Array<{ name: string; fn: (slug: string) => Promise<AgentResult> }> = [
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
      const result = await agent.fn(marketSlug);
      results[agent.name] = result.data;
      sendEvent("agent:complete", result);

      // Persist to DB
      updatePipelineRun(runId, {
        [`${agent.name}_output` as keyof typeof results]: JSON.stringify(result.data),
      } as any);
    } catch (err) {
      const errorResult = { agent: agent.name, status: "error", data: String(err) };
      results[agent.name] = errorResult;
      sendEvent("agent:error", errorResult);
    }
  }

  // Sigma aggregation
  sendEvent("agent:start", { agent: "sigma" });
  const sigma = runSigma(results);
  results.sigma = sigma.data;
  sendEvent("agent:complete", sigma);

  const sigmaData = sigma.data as any;
  updatePipelineRun(runId, {
    sigma_output: JSON.stringify(sigma.data),
    completed_at: Date.now(),
    decision: sigmaData.decision,
    confidence: sigmaData.confidence,
    market_question: (results.flux as any)?.question || marketSlug,
  });

  sendEvent("pipeline:complete", {
    runId,
    decision: sigmaData.decision,
    confidence: sigmaData.confidence,
  });

  res.end();
});

// GET /api/pipeline/history
router.get("/history", (_req: Request, res: Response) => {
  try {
    const runs = getPipelineHistory(20);
    // Parse JSON fields back to objects
    const parsed = runs.map((r) => ({
      ...r,
      aura_output: r.aura_output ? JSON.parse(r.aura_output) : null,
      flux_output: r.flux_output ? JSON.parse(r.flux_output) : null,
      oracle_output: r.oracle_output ? JSON.parse(r.oracle_output) : null,
      edge_output: r.edge_output ? JSON.parse(r.edge_output) : null,
      sigma_output: r.sigma_output ? JSON.parse(r.sigma_output) : null,
      clause_output: r.clause_output ? JSON.parse(r.clause_output) : null,
      lucifer_output: r.lucifer_output ? JSON.parse(r.lucifer_output) : null,
    }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
