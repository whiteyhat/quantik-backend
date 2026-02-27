// ── 5-Gate Signal Validator ──────────────────────────────────────

import { computeEdge, type AlphaSignal } from "./index";

export type SignalState = "TRADE" | "WATCH" | "SKIP";

export interface GateResult {
  gate: string;
  passed: boolean;
  hard: boolean; // hard skip = true, soft watch = false
  reason: string;
}

export interface SignalValidation {
  state: SignalState;
  reason: string;
  direction: "YES" | "NO";
  size_usdc: number;
  net_edge: number;
  confidence: number;
  gates: GateResult[];
}

export interface ValidatorInput {
  clause: { ambiguity_risk: string };
  lucifer: { adjusted_confidence: number };
  edge: { modelProb: number; marketPrice: number };
  sigma: { confidence: number };
  flux: { liquidity_grade: string };
  bankroll_usdc?: number;
}

export function validateSignal(input: ValidatorInput): SignalValidation {
  const gates: GateResult[] = [];
  let hardSkips = 0;
  let softWatches = 0;

  // 1. Clause gate: ambiguity_risk === "high" → HARD SKIP
  const clauseHigh =
    input.clause.ambiguity_risk.toLowerCase() === "high";
  gates.push({
    gate: "clause",
    passed: !clauseHigh,
    hard: true,
    reason: clauseHigh
      ? "Ambiguity risk HIGH — hard skip"
      : `Ambiguity risk: ${input.clause.ambiguity_risk}`,
  });
  if (clauseHigh) hardSkips++;

  // 2. Lucifer gate: adjusted_confidence < -0.1 → HARD SKIP
  const luciferVeto = input.lucifer.adjusted_confidence < -0.1;
  gates.push({
    gate: "lucifer",
    passed: !luciferVeto,
    hard: true,
    reason: luciferVeto
      ? `DA adjustment ${input.lucifer.adjusted_confidence.toFixed(2)} — hard skip`
      : `DA adjustment: ${input.lucifer.adjusted_confidence.toFixed(2)}`,
  });
  if (luciferVeto) hardSkips++;

  // Compute edge for gates 3+
  const alpha: AlphaSignal = computeEdge(
    input.edge.modelProb,
    input.edge.marketPrice
  );

  // 3. Edge gate: netEdge < 0.05 → WATCH (soft)
  const edgeLow = alpha.netEdge < 0.05;
  gates.push({
    gate: "edge",
    passed: !edgeLow,
    hard: false,
    reason: edgeLow
      ? `Net edge ${(alpha.netEdge * 100).toFixed(1)}% < 5% — watch`
      : `Net edge: ${(alpha.netEdge * 100).toFixed(1)}%`,
  });
  if (edgeLow) softWatches++;

  // 4. Confidence gate: sigma.confidence < 0.60 → WATCH
  const confLow = input.sigma.confidence < 0.6;
  gates.push({
    gate: "confidence",
    passed: !confLow,
    hard: false,
    reason: confLow
      ? `Confidence ${(input.sigma.confidence * 100).toFixed(0)}% < 60% — watch`
      : `Confidence: ${(input.sigma.confidence * 100).toFixed(0)}%`,
  });
  if (confLow) softWatches++;

  // 5. Liquidity gate: flux.liquidity_grade === "D" → WATCH
  const liqD = input.flux.liquidity_grade === "D";
  gates.push({
    gate: "liquidity",
    passed: !liqD,
    hard: false,
    reason: liqD
      ? "Liquidity grade D — watch"
      : `Liquidity grade: ${input.flux.liquidity_grade}`,
  });
  if (liqD) softWatches++;

  // Determine state
  let state: SignalState;
  let reason: string;
  if (hardSkips > 0) {
    state = "SKIP";
    reason = gates
      .filter((g) => g.hard && !g.passed)
      .map((g) => g.reason)
      .join("; ");
  } else if (softWatches >= 3) {
    state = "SKIP";
    reason = `${softWatches} soft watches triggered — auto-skip`;
  } else if (softWatches > 0) {
    state = "WATCH";
    reason = gates
      .filter((g) => !g.hard && !g.passed)
      .map((g) => g.reason)
      .join("; ");
  } else {
    state = "TRADE";
    reason = `All gates passed. Net edge ${(alpha.netEdge * 100).toFixed(1)}%`;
  }

  // Position sizing: kellyFraction * bankroll
  const bankroll = input.bankroll_usdc ?? 1000;
  const sizeUsdc =
    state === "TRADE"
      ? Math.min(bankroll * alpha.kellyFraction, bankroll * 0.1) // cap at 10% bankroll
      : 0;

  return {
    state,
    reason,
    direction: alpha.direction,
    size_usdc: Math.round(sizeUsdc * 100) / 100,
    net_edge: alpha.netEdge,
    confidence: input.sigma.confidence,
    gates,
  };
}
