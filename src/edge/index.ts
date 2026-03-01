// src/edge/index.ts - Edge Calibration Agent
import { execSync } from "child_process";
import { getDb } from "../db/schema";
import { getFeeConfig } from "./fees";
import { detectArbitrage, ArbOpportunity } from "./arb";
import { computeCorrelationPenalty } from "./correlation";
import { kellyMultiplier } from "./kelly";

export interface EdgeResult {
  marketSlug: string;
  scoredAt: number;
  gross_edge: number;
  net_edge: number;
  ev_grade: "A" | "B" | "C" | "SKIP";
  net_ev: number;
  kelly_recommended: number;
  fractional_kelly: number;
  position_size: number;
  kelly_multiplier: number;
  time_decay_watch: boolean;
  arb_opportunities: ArbOpportunity[];
  correlation_penalty: number;
  corr_blocked: boolean;
  direction: "YES" | "NO";
  confidence: number;
  kelly_confidence_penalty?: number;
  data_sources: Record<string, string>;
}

/** Fetch portfolio USDC balance.
 * Priority: (1) polymarket-cli wallet balance, (2) env var PORTFOLIO_USDC_FALLBACK.
 * Never silently falls back to $1000 — always logs a warning.
 */
function fetchPortfolioUsdc(slug: string): { value: number; source: string } {
  // Priority 0: PORTFOLIO_USDC env var (set via Railway)
  const envValue = parseFloat(process.env.PORTFOLIO_USDC ?? "");
  if (!isNaN(envValue) && envValue > 0) {
    return { value: envValue, source: "env_var" };
  }

  // Try polymarket-cli with 3s timeout
  try {
    const output = execSync("polymarket-cli wallet balance", { timeout: 3000, encoding: "utf8" });
    // Parse lines like "USDC: 1234.56" or "Balance: 1234.56 USDC"
    const match = output.match(/(?:USDC|Balance)[:\s]+([\d.]+)/i);
    if (match) {
      const value = parseFloat(match[1]);
      if (!isNaN(value) && value > 0) {
        return { value, source: "cli" };
      }
    }
  } catch (_) {
    // CLI unavailable or timed out — continue to fallback
  }

  // Fallback: env var
  const envVal = process.env.PORTFOLIO_USDC_FALLBACK;
  if (envVal) {
    const value = parseFloat(envVal);
    if (!isNaN(value) && value > 0) {
      console.warn(`[Edge] portfolio_usdc: using PORTFOLIO_USDC_FALLBACK env var (${value} USDC). Wire real source when possible.`);
      return { value, source: "env_fallback" };
    }
  }

  // Last resort: $1000 — but log loudly
  console.warn("[Edge] portfolio_usdc: no live source available. Using $1000 default. Set PORTFOLIO_USDC_FALLBACK or ensure polymarket-cli is reachable.");
  return { value: 1000, source: "hardcoded_fallback" };
}

export async function runEdge(market: any, oracleResult: any): Promise<EdgeResult> {
  const isMock = process.env.EDGE_MOCK === "true";
  const scoredAt = Date.now();
  const slug = market.slug || market.market_slug;

  if (isMock) {
    return {
      marketSlug: slug,
      scoredAt,
      gross_edge: 0.15,
      net_edge: 0.13,
      ev_grade: "A",
      net_ev: 0.12,
      kelly_recommended: 0.05,
      fractional_kelly: 0.02,
      position_size: 50,
      kelly_multiplier: 0.5,
      time_decay_watch: false,
      arb_opportunities: [],
      correlation_penalty: 0,
      corr_blocked: false,
      direction: "YES",
      confidence: 0.8,
      data_sources: { brier: "mock", resolved_trades: "mock", portfolio: "mock" }
    };
  }

  const db = getDb();

  // ── Real brier score from resolutions table ──────────────────────────────
  const brierRow = db.prepare(
    "SELECT AVG(brier_score) as avg_brier FROM resolutions WHERE market_slug = ?"
  ).get(slug) as any;
  const brierScore: number | null = (brierRow && brierRow.avg_brier != null) ? brierRow.avg_brier : null;

  // ── Resolved trades count ────────────────────────────────────────────────
  const resolvedRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM resolutions WHERE market_slug = ?"
  ).get(slug) as any;
  const resolvedTrades: number = (resolvedRow && resolvedRow.cnt != null) ? resolvedRow.cnt : 0;

  // If no resolved trades: set explicit confidence penalty (not hidden)
  let kelly_confidence_penalty: number | undefined = undefined;
  if (resolvedTrades === 0) {
    kelly_confidence_penalty = 0.3;
  }

  // ── Portfolio USDC ───────────────────────────────────────────────────────
  const { value: portfolio_usdc, source: portfolio_source } = fetchPortfolioUsdc(slug);

  // Track data sources
  const data_sources: Record<string, string> = {
    brier: brierScore !== null ? "resolutions_db" : "stub_null",
    resolved_trades: resolvedTrades > 0 ? "resolutions_db" : "stub_zero",
    portfolio: portfolio_source
  };

  // Calculate true prob and market implied
  const p_true = oracleResult?.calibrated_prob || oracleResult?.raw_prob || 0.5;
  const p_market = oracleResult?.market_implied || 0.5;
  const direction = p_true > p_market ? "YES" : "NO";
  
  // Calculate raw EV and edge
  const p_target = direction === "YES" ? p_true : (1 - p_true);
  const m_target = direction === "YES" ? p_market : (1 - p_market);
  
  // Kelly formula: f* = (P_true - P_market) / (1 - P_market)
  const kelly_recommended = Math.min(1, Math.max(0, m_target < 1 ? (p_target - m_target) / (1 - m_target) : 0));
  
  // Fee model
  const config = getFeeConfig();
  const fee_rate = config.winnings_fee || 0.02;
  
  // Net EV formula
  const net_ev = p_target * (1 * (1 - fee_rate)) - (1 - p_target) * m_target;
  
  const gross_edge = p_target - m_target;
  const net_edge = net_ev;
  
  // EV grades
  let ev_grade: "A" | "B" | "C" | "SKIP" = "SKIP";
  if (net_ev > 0.10) ev_grade = "A";
  else if (net_ev > 0.07) ev_grade = "B";
  else if (net_ev > 0.05) ev_grade = "C";
  
  // Time-decay
  const days_to_resolution = oracleResult?.days_to_resolution || 7;
  const time_decay_watch = ev_grade === "C" && days_to_resolution < 2;

  // Position sizing — use real brier score if available, else skip calibration
  const k_multiplier = brierScore !== null
    ? kellyMultiplier(brierScore, resolvedTrades)
    : kellyMultiplier(0.5, 0); // neutral when no brier data — do NOT use 0.25 which skews sizing
  
  let fractional_kelly = kelly_recommended * k_multiplier;

  // Apply confidence penalty if no resolved trades
  if (kelly_confidence_penalty !== undefined) {
    fractional_kelly = fractional_kelly * (1 - kelly_confidence_penalty);
  }
  
  // Absolute max milestones
  let absolute_max = 100;
  if (portfolio_usdc < 500) absolute_max = 10;
  else if (portfolio_usdc < 1000) absolute_max = 25;
  else if (portfolio_usdc < 5000) absolute_max = 50;
  
  const position_size_initial = Math.min(
    fractional_kelly * portfolio_usdc,
    portfolio_usdc * 0.05,
    absolute_max
  );
  
  // Arb opportunities
  const arb_opportunities = detectArbitrage(slug, oracleResult);
  
  // Correlation penalty
  const { correlation_penalty, corr_blocked, adjusted_position } = await computeCorrelationPenalty(
    slug,
    position_size_initial,
    fractional_kelly
  );

  const result: EdgeResult = {
    marketSlug: slug,
    scoredAt,
    gross_edge,
    net_edge,
    ev_grade,
    net_ev,
    kelly_recommended,
    fractional_kelly,
    position_size: adjusted_position,
    kelly_multiplier: k_multiplier,
    time_decay_watch,
    arb_opportunities,
    correlation_penalty,
    corr_blocked,
    direction,
    confidence: oracleResult?.confidence || 0.5,
    kelly_confidence_penalty,
    data_sources
  };
  
  // Save to DB
  db.prepare(`
    INSERT OR REPLACE INTO edge_results (
      marketSlug, scoredAt, gross_edge, net_edge, ev_grade, net_ev,
      kelly_recommended, fractional_kelly, position_size, kelly_multiplier,
      time_decay_watch, arb_opportunities, correlation_penalty, corr_blocked, direction, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.marketSlug, result.scoredAt, result.gross_edge, result.net_edge, result.ev_grade, result.net_ev,
    result.kelly_recommended, result.fractional_kelly, result.position_size, result.kelly_multiplier,
    result.time_decay_watch ? 1 : 0, JSON.stringify(result.arb_opportunities), result.correlation_penalty, result.corr_blocked ? 1 : 0, result.direction, result.confidence
  );

  return result;
}
