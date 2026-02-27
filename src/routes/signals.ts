import { Router, Request, Response } from "express";
import { getPipelineHistory, updatePipelineRun, PipelineRun } from "../db/queries";
import { getDb } from "../db/schema";
import { validateSignal, type SignalValidation } from "../signal/validator";
import { findAnalogues } from "../signal/backtester";

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deriveSignalState(run: PipelineRun): "TRADE" | "WATCH" | "SKIP" {
  // If signal_state was explicitly set, use it
  const row = run as PipelineRun & { signal_state?: string };
  if (row.signal_state === "TRADE" || row.signal_state === "WATCH" || row.signal_state === "SKIP") {
    return row.signal_state;
  }

  // Derive from sigma output
  const sigma = parseJson(run.sigma_output);
  if (!sigma) return "WATCH";

  const rec = sigma["recommendation"] ?? sigma["decision"];
  if (rec === "TRADE" || rec === "BUY_YES" || rec === "BUY_NO") return "TRADE";
  if (rec === "SKIP" || rec === "HOLD") return "SKIP";
  return "WATCH";
}

interface SignalRow {
  id: string;
  slug: string;
  question: string;
  decision: string;
  confidence: number;
  edge: number;
  timestamp: number;
  status: "TRADE" | "WATCH" | "SKIP";
}

function toSignalRow(run: PipelineRun): SignalRow {
  let edge = 0;
  const edgeData = parseJson(run.edge_output);
  if (edgeData) {
    edge =
      typeof edgeData["net_edge"] === "number" ? edgeData["net_edge"]
        : typeof edgeData["edge"] === "number" ? edgeData["edge"]
        : typeof edgeData["net_ev"] === "number" ? edgeData["net_ev"]
        : 0;
  }

  return {
    id: run.id,
    slug: run.market_slug,
    question: run.market_question || run.market_slug,
    decision: run.decision ?? "HOLD",
    confidence: run.confidence ?? 0,
    edge,
    timestamp: run.created_at,
    status: deriveSignalState(run),
  };
}

// ── GET /api/signals — last 20 TRADE/WATCH signals ──────────────

router.get("/", (_req: Request, res: Response) => {
  try {
    const runs = getPipelineHistory(50); // fetch extra, filter down
    const signals = runs.map(toSignalRow).filter(
      (s) => s.status === "TRADE" || s.status === "WATCH"
    );
    res.json(signals.slice(0, 20));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/signals/queue — WATCH queue (unresolved) ───────────

router.get("/queue", (_req: Request, res: Response) => {
  try {
    const runs = getPipelineHistory(100);
    const watchQueue = runs
      .map(toSignalRow)
      .filter((s) => s.status === "WATCH");
    res.json(watchQueue);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/signals/validate — 5-gate validator ───────────────

router.post("/validate", (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const pipelineRunId = body["pipelineRunId"];

    if (typeof pipelineRunId !== "string" || !pipelineRunId) {
      res.status(400).json({ error: "pipelineRunId is required" });
      return;
    }

    // Fetch the pipeline run
    const db = getDb();
    const run = db
      .prepare("SELECT * FROM pipeline_runs WHERE id = ?")
      .get(pipelineRunId) as PipelineRun | undefined;

    if (!run) {
      res.status(404).json({ error: "Pipeline run not found" });
      return;
    }

    // Parse agent outputs
    const clauseData = parseJson(run.clause_output);
    const luciferData = parseJson(run.lucifer_output);
    const edgeData = parseJson(run.edge_output);
    const sigmaData = parseJson(run.sigma_output);
    const fluxData = parseJson(run.flux_output);

    // Build validator input with safe defaults
    const validation: SignalValidation = validateSignal({
      clause: {
        ambiguity_risk:
          typeof clauseData?.["ambiguity_risk"] === "string"
            ? clauseData["ambiguity_risk"]
            : typeof clauseData?.["riskLevel"] === "string"
            ? clauseData["riskLevel"]
            : "low",
      },
      lucifer: {
        adjusted_confidence:
          typeof luciferData?.["adjusted_confidence"] === "number"
            ? luciferData["adjusted_confidence"]
            : 0,
      },
      edge: {
        modelProb:
          typeof edgeData?.["estimated_true_prob"] === "number"
            ? edgeData["estimated_true_prob"]
            : run.confidence ?? 0.5,
        marketPrice:
          typeof edgeData?.["market_price"] === "number"
            ? edgeData["market_price"]
            : 0.5,
      },
      sigma: {
        confidence: run.confidence ?? 0.5,
      },
      flux: {
        liquidity_grade:
          typeof fluxData?.["liquidity_grade"] === "string"
            ? fluxData["liquidity_grade"]
            : "C",
      },
    });

    // Store signal_state in pipeline_runs
    updatePipelineRun(pipelineRunId, {
      ...(({ signal_state: validation.state } as unknown) as Partial<PipelineRun>),
    });
    // Direct SQL update for the new column
    db.prepare("UPDATE pipeline_runs SET signal_state = ? WHERE id = ?").run(
      validation.state,
      pipelineRunId
    );

    // Also run backtester for context
    const analogues = findAnalogues(
      run.market_question || run.market_slug,
      typeof edgeData?.["market_price"] === "number"
        ? edgeData["market_price"]
        : undefined
    );

    res.json({ validation, analogues });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
