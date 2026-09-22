import { getDb } from "../db/schema";

export interface LuciferResult {
  devils_advocate_score: number;
  bear_case: string;
  bull_case: string;
  bias_flags: string[];
  veto: boolean;
}

export interface ResearchNote {
  marketSlug: string;
  scoredAt: number;
  composite_prob: number;
  confidence: number;
  confidence_interval: [number, number];
  consistency_score: number;
  recommended_direction: "YES" | "NO";
  recommendation: "TRADE" | "WATCH" | "SKIP";
  skip_reason?: string;
  thesis: string;
  bear_case: string;
  bull_case: string;
  agent_weights: Record<string, number>;
  lucifer_da_score?: number;
  auto_synthesized: boolean;
  data_sources?: Record<string, string>;
}

export interface SigmaInputs {
  aura: any;
  oracle: any;
  edge: any;
  clause: any;
  flux: any;
  lucifer?: LuciferResult;
  market: any;
}

const SIGMA_MODELS = ["gemini-3.1-pro-preview", "gemini-3.6-flash"];

async function askGemini(prompt: string): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  for (const model of SIGMA_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1
          }
        })
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;
      return JSON.parse(text);
    } catch {
      continue;
    }
  }
  throw new Error("All Gemini models failed");
}

export async function runSigma(inputs: SigmaInputs): Promise<ResearchNote> {
  const { aura, oracle, edge, clause, flux, lucifer, market } = inputs;
  const slug = market?.slug || "unknown-market";
  const scoredAt = Date.now();

  if (process.env.SIGMA_MOCK === "true") {
    return {
      marketSlug: slug,
      scoredAt,
      composite_prob: 0.65,
      confidence: 0.8,
      confidence_interval: [0.60, 0.70],
      consistency_score: 0.9,
      recommended_direction: "YES",
      recommendation: "TRADE",
      thesis: "Mock thesis",
      bear_case: "Mock bear",
      bull_case: "Mock bull",
      agent_weights: { edge: 0.3, oracle: 0.25, clause: 0.2, aura: 0.15, flux: 0.1 },
      auto_synthesized: true
    };
  }

  // Check hard vetos
  const hardVeto = clause?.veto === true || (lucifer && lucifer.devils_advocate_score > 0.7);

  // Agent probability estimates (derived)
  const p_market = market?.yes_price || 0.5;
  const p_oracle = oracle?.calibrated_prob ?? p_market;
  const edge_dir_mult = edge?.direction === "YES" ? 1 : -1;
  const p_edge = edge?.net_edge ? Math.max(0, Math.min(1, p_market + edge_dir_mult * edge.net_edge)) : p_oracle;
  const p_aura = aura?.sentimentDelta ? Math.max(0, Math.min(1, p_market + aura.sentimentDelta)) : p_market;
  // FIXED S1: ClauseResult has no adjusted_probability field — use ambiguityScore as adjustment
  // When veto: collapse to 0.2 (strong negative signal). When high ambiguity: discount toward market.
  const clauseAmbiguity = clause?.ambiguityScore ?? 0;
  const p_clause = clause?.veto === true ? 0.2 : p_market * (1 - clauseAmbiguity * 0.3);
  const p_flux = (flux && flux.depth_yes_pct != null) ? flux.depth_yes_pct : p_market;

  const agent_probs = [p_oracle, p_edge, p_aura, p_clause, p_flux];
  const mean_p = agent_probs.reduce((a, b) => a + b, 0) / agent_probs.length;
  const variance = agent_probs.reduce((sum, p) => sum + Math.pow(p - mean_p, 2), 0) / agent_probs.length;

  // Inter-agent consistency check: >20% difference implies disagreement
  // Disagree if Math.abs(p_i - p_j) > 0.2
  let disagreeCount = 0;
  for (let i = 0; i < agent_probs.length; i++) {
    let disagrees = false;
    for (let j = 0; j < agent_probs.length; j++) {
      if (Math.abs(agent_probs[i] - agent_probs[j]) > 0.2) {
        disagrees = true;
        break;
      }
    }
    if (disagrees) disagreeCount++;
  }

  // Warm-start weights
  let w_edge = 0.30;
  let w_oracle = 0.25;
  let w_clause = 0.20;
  let w_aura = 0.15;
  let w_flux = 0.10;

  if (aura?.shiftVelocity > 0.05) {
    w_aura = 0.20;
    const total = w_edge + w_oracle + w_clause + w_aura + w_flux;
    w_edge /= total;
    w_oracle /= total;
    w_clause /= total;
    w_aura /= total;
    w_flux /= total;
  }

  const agent_weights = {
    edge: w_edge,
    oracle: w_oracle,
    clause: w_clause,
    aura: w_aura,
    flux: w_flux
  };

  // Compute composite prob using Bayesian weights
  const composite_prob = 
    w_oracle * p_oracle + 
    w_edge * p_edge + 
    w_aura * p_aura + 
    w_clause * p_clause + 
    w_flux * p_flux;

  // Weighted average confidence — not Math.min (which collapses to weakest signal)
  const confidenceInputs = [
    { val: oracle?.confidence, weight: 3 },    // Oracle is most reliable (Gemini)
    { val: clause?.confidence, weight: 2 },    // Clause is critical for veto
    { val: edge?.confidence, weight: 2 },      // Edge is blocking
    { val: flux?.confidence, weight: 1 },      // Flux is helpful
    { val: aura?.confidence, weight: 1 },      // Aura is weakest signal
  ].filter(c => c.val != null && c.val !== undefined);

  const totalWeight = confidenceInputs.reduce((s, c) => s + c.weight, 0);
  let confidence = totalWeight > 0
    ? confidenceInputs.reduce((s, c) => s + (c.val! * c.weight), 0) / totalWeight
    : 0.4;

  if (disagreeCount >= 3) {
    confidence -= 0.15;
  }
  confidence = Math.max(0, confidence);

  let recommendation: "TRADE" | "WATCH" | "SKIP" = "WATCH";
  let skip_reason: string | undefined;

  if (hardVeto) {
    recommendation = "SKIP";
    skip_reason = "Hard veto triggered by Clause or Lucifer";
  } else if (confidence >= 0.6) {
    recommendation = "TRADE";
  }

  const recommended_direction = composite_prob > 0.5 ? "YES" : "NO";
  const confidence_interval: [number, number] = [
    Math.max(0, composite_prob - 0.05),
    Math.min(1, composite_prob + 0.05)
  ];

  let resultNote: ResearchNote;

  // Build data_sources map showing what's live vs proxy
  const data_sources: Record<string, string> = {
    p_flux: (flux && flux.depth_yes_pct != null) ? "flux_depth_live" : "market_proxy",
    p_clause: clause?.veto === true ? "veto_penalty" : (clause?.adjusted_probability != null ? "clause_adjusted" : "market_proxy"),
    p_oracle: oracle?.calibrated_prob != null ? "oracle_calibrated" : "market_proxy",
    p_aura: aura?.sentimentDelta != null ? "aura_sentiment" : "market_proxy"
  };

  if (variance < 0.1) {
    // Auto-synthesis
    resultNote = {
      marketSlug: slug,
      scoredAt,
      composite_prob,
      confidence,
      confidence_interval,
      consistency_score: 1.0 - (disagreeCount / agent_probs.length),
      recommended_direction,
      recommendation,
      skip_reason,
      thesis: `Agents converged: Oracle ${(p_oracle * 100).toFixed(0)}%, Edge ${(p_edge * 100).toFixed(0)}%, Aura ${(p_aura * 100).toFixed(0)}%. Composite ${(composite_prob * 100).toFixed(0)}% with ${(confidence * 100).toFixed(0)}% confidence — directional bias ${recommended_direction}.`,
      bear_case: `Agents agree, which itself is a risk — consensus can mask shared blind spots. ${flux?.soft_veto ? "Flux flags thin liquidity; execution may not match model price." : "Monitor liquidity and time decay before execution."}`,
      bull_case: `Quantitative alignment across Oracle, Edge, and Aura on ${recommended_direction} direction at ${(composite_prob * 100).toFixed(0)}%. Inter-agent variance ${variance.toFixed(3)} — strong consistency.`,
      agent_weights,
      lucifer_da_score: lucifer?.devils_advocate_score,
      auto_synthesized: true,
      data_sources
    };
  } else {
    // LLM Fallback
    const prompt = `You are Sigma — the lead synthesis agent for Quantik, a prediction market trading system. Your job is to reconcile conflicting agent signals and produce a definitive, well-reasoned trading recommendation.

MARKET: "${market?.question}"

AGENT INPUTS (agents disagree — variance ${variance.toFixed(3)} ≥ 0.10):
- Oracle (Gemini superforecaster): ${(p_oracle * 100).toFixed(0)}%
- Edge (Kelly/EV model): ${(p_edge * 100).toFixed(0)}%
- Aura (sentiment-adjusted): ${(p_aura * 100).toFixed(0)}%
- Flux (depth-implied): ${(p_flux * 100).toFixed(0)}%
- Clause veto: ${clause?.veto ?? false}${clause?.veto ? " ← HARD VETO — recommendation must be SKIP unless overridden with strong reasoning" : ""}
- Lucifer DA score: ${lucifer?.devils_advocate_score ?? "N/A"}${(lucifer?.devils_advocate_score ?? 0) > 0.6 ? " ← HIGH adversarial score" : ""}
- Weighted composite: ${(composite_prob * 100).toFixed(0)}%

SYNTHESIS PROTOCOL:
1. IDENTIFY THE GAP: Which two agents diverge most, and what does that imply about the market?
2. WEIGHT BY RELIABILITY: Oracle and Edge are quantitative — weight them higher than sentiment under uncertainty.
3. APPLY VETO LOGIC: If Clause vetoed, the thesis must explain why or defer to SKIP.
4. PRODUCE A VERDICT: Clear 2-3 sentence position on whether to trade and why.

Respond ONLY with valid JSON — no markdown, no text outside the JSON:
{
  "composite_prob": ${composite_prob},
  "thesis": "2-3 sentences reconciling the disagreement and stating the synthesis verdict with specific numbers",
  "bull_case": "The strongest steelmanned argument FOR the trade, citing agent data",
  "bear_case": "The strongest steelmanned argument AGAINST the trade, citing agent data"
}`;

    try {
      const llmResult = await askGemini(prompt);
      resultNote = {
        marketSlug: slug,
        scoredAt,
        composite_prob: llmResult.composite_prob ?? composite_prob,
        confidence,
        confidence_interval,
        consistency_score: Math.max(0, 1.0 - (disagreeCount / agent_probs.length)),
        recommended_direction,
        recommendation,
        skip_reason,
        thesis: llmResult.thesis || "Fallback thesis",
        bear_case: llmResult.bear_case || "Fallback bear",
        bull_case: llmResult.bull_case || "Fallback bull",
        agent_weights,
        lucifer_da_score: lucifer?.devils_advocate_score,
        auto_synthesized: false,
        data_sources
      };
    } catch (err: any) {
      console.error("Gemini fallback failed:", err);
      // Fallback to auto-synthesis if LLM fails
      resultNote = {
        marketSlug: slug,
        scoredAt,
        composite_prob,
        confidence,
        confidence_interval,
        consistency_score: 1.0 - (disagreeCount / agent_probs.length),
        recommended_direction,
        recommendation,
        skip_reason,
        thesis: "Auto-synthesized (LLM fallback failed).",
        bear_case: "N/A",
        bull_case: "N/A",
        agent_weights,
        lucifer_da_score: lucifer?.devils_advocate_score,
        auto_synthesized: true,
        data_sources
      };
    }
  }

  // Save to DB
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO research_notes (
        marketSlug, scoredAt, composite_prob, confidence, confidence_interval,
        consistency_score, recommended_direction, recommendation, skip_reason,
        thesis, bear_case, bull_case, agent_weights, lucifer_da_score, auto_synthesized
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resultNote.marketSlug,
      resultNote.scoredAt,
      resultNote.composite_prob,
      resultNote.confidence,
      JSON.stringify(resultNote.confidence_interval),
      resultNote.consistency_score,
      resultNote.recommended_direction,
      resultNote.recommendation,
      resultNote.skip_reason || null,
      resultNote.thesis,
      resultNote.bear_case,
      resultNote.bull_case,
      JSON.stringify(resultNote.agent_weights),
      resultNote.lucifer_da_score || null,
      resultNote.auto_synthesized ? 1 : 0
    );
  } catch (err) {
    console.error("Error saving research note to DB:", err);
  }

  return resultNote;
}
