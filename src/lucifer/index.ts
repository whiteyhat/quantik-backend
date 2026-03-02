import { getDb } from "../db/schema";
async function callGemini(prompt: string): Promise<string | null> {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch { return null; }
}

export interface LuciferAgentResult {
  agent: string;
  status: "complete" | "error";
  data: {
    devils_advocate_score: number;
    bias_flags: string[];
    counter_thesis: string;
    worst_case: string;
    adjusted_confidence: number;
    pass: boolean;
    slug: string;
    riskLevel: string;
    ambiguityScore: number;
  };
}

export async function runLucifer(slug: string, agentResults?: Record<string, unknown>): Promise<LuciferAgentResult> {
  try {
    const clause = agentResults?.clause as any;
    const edge = agentResults?.edge as any;
    const aura = agentResults?.aura as any;

    const ambiguityScore: number = clause?.ambiguityScore ?? 0.4;
    const kellyFrac: number = edge?.fractional_kelly ?? edge?.kelly_fraction ?? edge?.kelly_recommended ?? 0;
    const veto: boolean = clause?.veto ?? false;
    const shiftDetected: boolean = aura?.shiftDetected ?? false;
    const riskLevel: string = clause?.riskLevel ?? "UNKNOWN";

    const biasFlags: string[] = [];

    if (ambiguityScore > 0.5) biasFlags.push(`High resolution ambiguity (score=${ambiguityScore.toFixed(2)}) — resolution criteria may be disputed`);
    if (kellyFrac > 0.3) biasFlags.push("Overconfidence risk — Kelly fraction is unusually high, check if model is overfitting recent data");
    if (shiftDetected) biasFlags.push("Sentiment shift detected — crowd may be chasing momentum, not fundamentals");
    if (riskLevel === "HIGH") biasFlags.push("Clause flagged HIGH resolution risk — historical analogues show dispute probability > 20%");
    if (!biasFlags.length) biasFlags.push("Recency bias — check if recent news is driving edge or just noise");
    biasFlags.push("Liquidity illusion — thin orderbook may not absorb position without slippage");

    const baseAdversarialScore = Math.min(0.9, 0.25 + ambiguityScore * 0.4 + (veto ? 0.3 : 0));
    const adjustedConf = veto ? -0.20 : ambiguityScore > 0.6 ? -0.10 : -0.03;

    // Build real Gemini counter-thesis — market-specific devil's advocate
    let counterThesis = veto
      ? `Clause vetoed — resolution criteria are ambiguous. Market may resolve differently than expected.`
      : ambiguityScore > 0.5
      ? `Resolution ambiguity ${ambiguityScore.toFixed(2)} — criteria could be disputed.`
      : `Edge requires validation — confirm Kelly is not overfit.`;

    let worstCase = veto
      ? "Full loss with dispute risk — Clause recommends no position"
      : `Partial loss if resolution is disputed or event timing slips`;

    // Try Gemini for real per-market counter-thesis (devil's advocate)
    if (!veto) {
      try {
        const auraHeadlines = (aura as any)?.newsHeadlines?.slice(0, 2).join("; ") ?? "";
        const prompt = `You are a devil's advocate for prediction market trading. Be specific and skeptical.
Market: ${slug}
Kelly fraction: ${kellyFrac.toFixed(3)} | Ambiguity score: ${ambiguityScore.toFixed(2)} | Risk: ${riskLevel}
Recent news context: ${auraHeadlines}
Task: In 1-2 sentences, give the strongest argument AGAINST this trade. Be specific to this market, not generic.
Format: Just the argument, no preamble.`;
        const geminiText = await Promise.race([
          callGemini(prompt),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))
        ]) as string | null;
        if (geminiText && geminiText.length > 20) {
          counterThesis = geminiText.slice(0, 300); // cap at 300 chars
        }
      } catch { /* fallback to template thesis above */ }
    }

    return {
      agent: "lucifer",
      status: "complete",
      data: {
        devils_advocate_score: parseFloat(baseAdversarialScore.toFixed(2)),
        bias_flags: biasFlags,
        counter_thesis: counterThesis,
        worst_case: worstCase,
        adjusted_confidence: parseFloat(adjustedConf.toFixed(3)),
        pass: !veto && ambiguityScore < 0.7,
        slug,
        riskLevel,
        ambiguityScore,
      },
    };
  } catch {
    return {
      agent: "lucifer",
      status: "complete",
      data: {
        devils_advocate_score: 0.35,
        bias_flags: ["Data unavailable — applying conservative adversarial penalty"],
        counter_thesis: "Unable to run full devil's advocate analysis. Treat signal with additional caution.",
        worst_case: "Full loss if underlying assumptions are wrong",
        adjusted_confidence: -0.08,
        pass: true,
        slug,
        riskLevel: "UNKNOWN",
        ambiguityScore: 0.4,
      },
    };
  }
}

export async function runLuciferStandalone(slug: string): Promise<any> {
  const db = getDb();
  const clauseRow = db.prepare("SELECT * FROM clause_results WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1").get(slug) as any;
  const edgeRow = db.prepare("SELECT * FROM edge_results WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 1").get(slug) as any;
  const auraRow = db.prepare("SELECT * FROM aura_results WHERE slug = ? AND is_mock = 0 ORDER BY scored_at DESC LIMIT 1").get(slug) as any;

  const agentResults = {
    clause: clauseRow ? { ambiguityScore: clauseRow.ambiguityScore, veto: Boolean(clauseRow.veto), riskLevel: clauseRow.riskLevel } : null,
    edge: edgeRow ? { fractional_kelly: edgeRow.fractional_kelly, kelly_recommended: edgeRow.kelly_recommended } : null,
    aura: auraRow ? { shiftDetected: Boolean(auraRow.shift_detected), shiftDirection: auraRow.shift_direction } : null,
  };

  const data_freshness = {
    clause: clauseRow ? "live" : "default",
    edge: edgeRow ? "live" : "default",
    aura: auraRow ? "live" : "default",
  };

  const result = await runLucifer(slug, agentResults);
  return { ...result, data_freshness };
}
