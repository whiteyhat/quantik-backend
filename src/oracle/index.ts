import { getDb } from "../db/schema";
import { detectCombinatorial } from "./arb-detector";
import { applyLongshotBias } from "./longshot";
import { buildOraclePrompt, OracleContext } from "./prompt";

export interface OracleResult {
  marketSlug: string;
  scoredAt: number;
  raw_prob: number;
  calibrated_prob: number;
  market_implied: number;
  confidence: number;
  data_sufficiency: number;
  bull_case: string;
  bear_case: string;
  reasoning: string;
  cross_market_signals: { source: string; price: number; liquidity: number }[];
  cross_market_divergence: boolean;
  arb_detected: boolean;
  arb_details?: string;
  whale_signal_p_yes?: number;
  days_to_resolution: number;
  ensemble_variance?: number;
  longshot_adjusted: boolean;
  backtester_is_live: boolean;
  data_sources: Record<string, string>;
}

async function askGemini(prompt: string): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    })
  });
  if (!res.ok) throw new Error("Gemini API error: " + await res.text());
  const data: any = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No text from Gemini");
  return JSON.parse(text);
}

export async function runOracle(market: any): Promise<OracleResult> {
  const mockMode = process.env.ORACLE_MOCK === "true";
  const slug = market.slug || "unknown-market";
  const question = market.question || "Unknown question?";
  const market_implied = market.yes_price || 0.5;
  const resolutionDate = market.resolution_date || new Date(Date.now() + 30 * 86400000).toISOString();
  
  const days_to_resolution = Math.max(1, Math.round((new Date(resolutionDate).getTime() - Date.now()) / 86400000));

  if (mockMode) {
    const raw = applyLongshotBias(0.65);
    const mockRes: OracleResult = {
      marketSlug: slug,
      scoredAt: Date.now(),
      raw_prob: raw,
      calibrated_prob: 0.60,
      market_implied,
      confidence: 0.85,
      data_sufficiency: 0.9,
      bull_case: "Strong momentum.",
      bear_case: "Regulatory risk.",
      reasoning: "Mocked reasoning based on deterministic flow.",
      cross_market_signals: [{ source: "Metaculus", price: 0.62, liquidity: 1000 }],
      cross_market_divergence: false,
      arb_detected: false,
      days_to_resolution,
      longshot_adjusted: raw !== 0.65,
      backtester_is_live: false,
      data_sources: { news: "mock", portfolio: "mock", brier: "mock" }
    };
    saveOracleResult(mockRes);
    return mockRes;
  }

  const arb = await detectCombinatorial(slug);
  
  const db = getDb();
  let whale_signal_p_yes: number | undefined = undefined;
  let news_headlines = "";
  let has_real_cross_market = false;

  // Fetch Aura data from DB: news headlines, whale positioning, sentimentDelta
  const aura = db.prepare(
    "SELECT whale_pos_yes_pct, news_headlines, sentiment_delta FROM aura_results WHERE slug = ? ORDER BY scored_at DESC LIMIT 1"
  ).get(slug) as any;

  if (aura) {
    if (aura.whale_pos_yes_pct != null) {
      whale_signal_p_yes = aura.whale_pos_yes_pct;
    }
    // Use real news from Aura DB — do NOT invent headlines
    if (aura.news_headlines) {
      news_headlines = aura.news_headlines;
    }
  }

  // Cross-market signals: use Aura sentimentDelta as proxy if available; omit if not
  let crossSignals: { source: string; price: number; liquidity: number }[] = [];
  if (aura && aura.sentiment_delta != null) {
    const proxy_price = Math.max(0, Math.min(1, market_implied + aura.sentiment_delta));
    crossSignals = [{ source: "Aura SentimentDelta (proxy)", price: proxy_price, liquidity: 0 }];
    has_real_cross_market = true;
  }
  // No Manifold mock — if no real signal, crossSignals stays empty

  const divergence = crossSignals.length > 0 && Math.abs(crossSignals[0].price - market_implied) > 0.15;

  // Dynamically compute data_sufficiency from available real signals
  const has_news = news_headlines.length > 0;
  const has_whale_data = whale_signal_p_yes != null;
  const data_sufficiency = ((has_news ? 1 : 0) + (has_whale_data ? 1 : 0) + (has_real_cross_market ? 1 : 0)) / 3;

  // Track data sources for transparency
  const data_sources: Record<string, string> = {
    news: has_news ? "aura_db" : "none",
    whale: has_whale_data ? "aura_db" : "none",
    cross_market: has_real_cross_market ? "aura_sentiment_proxy" : "none",
    // TODO: wire to resolved oracle_results table once resolution tracking ships
    backtester: "stub"
  };

  const context: OracleContext = {
    question,
    resolution_date: resolutionDate,
    days_to_resolution,
    yes_price: market_implied,
    cross_market_signals: crossSignals.length > 0 ? JSON.stringify(crossSignals) : "None",
    divergence_warning: divergence ? "WARNING: High divergence across markets." : undefined,
    whale_signal: whale_signal_p_yes ? `Whale yes %: ${(whale_signal_p_yes * 100).toFixed(1)}%` : undefined,
    news_headlines,
    // TODO: wire to resolved oracle_results table once resolution tracking ships
    backtester_hit_rate: 68,
    sample_size: 150,
    backtester_is_live: false
  };

  const prompt = buildOraclePrompt(context);
  let geminiOutput = { p_yes: market_implied, confidence: 0.5, bull_case: "N/A", bear_case: "N/A", reasoning: "N/A" };
  try {
    geminiOutput = await askGemini(prompt);
  } catch (err) {
    console.error("Gemini failed, using fallback:", err);
  }

  let raw_prob = geminiOutput.p_yes;
  const confidence = geminiOutput.confidence;

  // Ensemble variance check
  let ensemble_variance: number | undefined = undefined;
  let final_confidence = confidence;
  const edge = Math.abs(raw_prob - market_implied);
  
  if (edge >= 0.05 && edge <= 0.10 && confidence < 0.75) {
    try {
      const [res1, res2] = await Promise.all([askGemini(prompt), askGemini(prompt)]);
      const p1 = raw_prob;
      const p2 = res1.p_yes;
      const p3 = res2.p_yes;
      raw_prob = (p1 + p2 + p3) / 3;
      
      const variance = ((p1 - raw_prob)**2 + (p2 - raw_prob)**2 + (p3 - raw_prob)**2) / 3;
      ensemble_variance = variance;
      if (variance > 0.05) {
        final_confidence = Math.max(0, final_confidence - 0.1);
      }
    } catch (err) {
      console.error("Ensemble failed:", err);
    }
  }

  // Adaptive calibration shrinkage
  let shrinkage = 0.85;
  if ((raw_prob < 0.15 || raw_prob > 0.85) && final_confidence >= 0.8 && data_sufficiency >= 0.7) {
    shrinkage = 0.97;
  } else if (raw_prob < 0.25 || raw_prob > 0.75) {
    shrinkage = 0.92;
  }
  let calibrated_prob = market_implied + (raw_prob - market_implied) * shrinkage;

  // Longshot bias
  const prev_calibrated = calibrated_prob;
  calibrated_prob = applyLongshotBias(calibrated_prob);
  const longshot_adjusted = prev_calibrated !== calibrated_prob;

  const result: OracleResult = {
    marketSlug: slug,
    scoredAt: Date.now(),
    raw_prob,
    calibrated_prob,
    market_implied,
    confidence: final_confidence,
    data_sufficiency,
    bull_case: geminiOutput.bull_case || "N/A",
    bear_case: geminiOutput.bear_case || "N/A",
    reasoning: geminiOutput.reasoning || "N/A",
    cross_market_signals: crossSignals,
    cross_market_divergence: divergence,
    arb_detected: arb.detected,
    arb_details: arb.details,
    whale_signal_p_yes,
    days_to_resolution,
    ensemble_variance,
    longshot_adjusted,
    backtester_is_live: false,
    data_sources
  };

  saveOracleResult(result);
  return result;
}

function saveOracleResult(res: OracleResult) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO oracle_results (
      market_slug, scored_at, raw_prob, calibrated_prob, market_implied,
      confidence, data_sufficiency, bull_case, bear_case, reasoning,
      cross_market_signals, cross_market_divergence, arb_detected, arb_details,
      whale_signal_p_yes, days_to_resolution, ensemble_variance, longshot_adjusted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    res.marketSlug, res.scoredAt, res.raw_prob, res.calibrated_prob, res.market_implied,
    res.confidence, res.data_sufficiency, res.bull_case, res.bear_case, res.reasoning,
    JSON.stringify(res.cross_market_signals), res.cross_market_divergence ? 1 : 0,
    res.arb_detected ? 1 : 0, res.arb_details || null,
    res.whale_signal_p_yes ?? null, res.days_to_resolution,
    res.ensemble_variance ?? null, res.longshot_adjusted ? 1 : 0
  );
}
