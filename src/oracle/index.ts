import { getDb } from "../db/schema";
import { detectCombinatorial } from "./arb-detector";
import { applyLongshotBias } from "./longshot";
import { buildOraclePrompt, OracleContext } from "./prompt";
import { findAnalogues } from "../signal/backtester";

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
  const auraRow = db.prepare(
    "SELECT whale_pos_yes_pct, news_headlines, sentiment_delta, scored_at, is_mock FROM aura_results WHERE slug = ? AND is_mock = 0 ORDER BY scored_at DESC LIMIT 1"
  ).get(slug) as any;
  const AURA_MAX_AGE_MS = 4 * 60 * 60 * 1000;
  const auraIsStale = !auraRow || !auraRow.scored_at || (Date.now() - auraRow.scored_at) > AURA_MAX_AGE_MS;
  const aura = auraIsStale ? null : auraRow;

  if (aura) {
    if (aura.whale_pos_yes_pct != null) {
      whale_signal_p_yes = aura.whale_pos_yes_pct;
    }
    // Use real news from Aura DB — do NOT invent headlines
    if (aura.news_headlines) {
      news_headlines = aura.news_headlines;
    }
  }

  // Cross-market signals: Metaculus first (real prediction market), then Aura proxy fallback
  let crossSignals: { source: string; price: number; liquidity: number }[] = [];

  // Try Metaculus API for real correlated market probabilities
  try {
    const metaculusKey = process.env.METACULUS_API_KEY;
    if (metaculusKey && market.question) {
      const qEnc = encodeURIComponent(market.question.slice(0, 80));
      const mRes = await fetch(
        `https://www.metaculus.com/api2/questions/?search=${qEnc}&status=open&limit=3`,
        {
          headers: { Authorization: `Token ${metaculusKey}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (mRes.ok) {
        const mData = await mRes.json() as any;
        const results = mData?.results ?? [];
        for (const q of results.slice(0, 2)) {
          const prob = q?.community_prediction?.full?.q2 ?? q?.metaculus_prediction?.full?.q2 ?? null;
          if (typeof prob === "number" && prob > 0 && prob < 1) {
            crossSignals.push({ source: `Metaculus:${q.id}`, price: prob, liquidity: q.number_of_predictions ?? 0 });
            has_real_cross_market = true;
          }
        }
      }
    }
  } catch { /* Metaculus unavailable — fallback to proxy */ }

  // Fallback: Aura sentimentDelta as directional proxy (not a real price)
  if (crossSignals.length === 0 && aura && aura.sentiment_delta != null) {
    const proxy_price = Math.max(0, Math.min(1, market_implied + aura.sentiment_delta));
    crossSignals = [{ source: "Aura SentimentDelta (proxy)", price: proxy_price, liquidity: 0 }];
    // Note: this is directional only — NOT a real correlated market price
  }

  const divergence = crossSignals.length > 0 && Math.abs(crossSignals[0].price - market_implied) > 0.15;

  // Dynamically compute data_sufficiency from available real signals
  const has_news = news_headlines.length > 0;
  const has_whale_data = whale_signal_p_yes != null;
  const data_sufficiency = ((has_news ? 1 : 0) + (has_whale_data ? 1 : 0) + (has_real_cross_market ? 1 : 0)) / 3;

  // Backtester: find analogues for real hit rate
  let backtesterData = { hit_rate: null as number | null, sample_size: 0, is_live: false };
  try {
    const analogues = findAnalogues(question, market_implied);
    if (analogues && analogues.sample_size > 0) {
      backtesterData = {
        hit_rate: Math.round(analogues.hit_rate * 100),
        sample_size: analogues.sample_size,
        is_live: true,
      };
    }
  } catch {
    // backtester unavailable — keep defaults
  }

  // Track data sources for transparency
  const data_sources: Record<string, string> = {
    news: has_news ? "aura_db" : "none",
    whale: has_whale_data ? "aura_db" : "none",
    cross_market: has_real_cross_market ? "aura_sentiment_proxy" : "none",
    backtester: backtesterData.is_live ? "live" : "stub"
  };

  const context: OracleContext = {
    question,
    resolution_date: resolutionDate,
    days_to_resolution,
    yes_price: market_implied,
    cross_market_signals: crossSignals.length > 0 ? JSON.stringify(crossSignals) : "None",
    divergence_warning: divergence ? "WARNING: High divergence across markets." : undefined,
    whale_signal: whale_signal_p_yes != null ? `Whale yes %: ${whale_signal_p_yes.toFixed(1)}%` : undefined,
    news_headlines,
    backtester_hit_rate: backtesterData.hit_rate ?? 68,
    sample_size: backtesterData.sample_size,
    backtester_is_live: backtesterData.is_live
  };

  function validateOracleOutput(output: any, slug: string): void {
    const { p_yes, confidence } = output;
    if (typeof p_yes !== "number" || isNaN(p_yes) || p_yes < 0.01 || p_yes > 0.99) {
      throw new Error(`[Oracle:${slug}] p_yes out of bounds: ${p_yes}`);
    }
    if (typeof confidence !== "number" || isNaN(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`[Oracle:${slug}] confidence out of bounds: ${confidence}`);
    }
  }

  const prompt = buildOraclePrompt(context);
  let geminiOutput = { p_yes: market_implied, confidence: 0.5, bull_case: "N/A", bear_case: "N/A", reasoning: "N/A" };
  try {
    geminiOutput = await askGemini(prompt);
    validateOracleOutput(geminiOutput, slug);
  } catch (err) {
    console.error("Gemini failed, using fallback:", err);
  }

  let raw_prob = geminiOutput.p_yes;
  raw_prob = Math.min(0.99, Math.max(0.01, raw_prob));
  const confidence = geminiOutput.confidence;

  // Ensemble variance check
  let ensemble_variance: number | undefined = undefined;
  let final_confidence = confidence;

  // Cap confidence based on data sufficiency — prevents overconfident signals with no supporting data
  const data_confidence_cap = 0.40 + (data_sufficiency * 0.45);
  final_confidence = Math.min(final_confidence, data_confidence_cap);

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
  calibrated_prob = Math.min(0.99, Math.max(0.01, calibrated_prob));
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
    backtester_is_live: backtesterData.is_live,
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
