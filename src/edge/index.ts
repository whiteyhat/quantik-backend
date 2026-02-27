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
    };
  }

  // Calculate true prob and market implied
  const p_true = oracleResult?.calibrated_prob || oracleResult?.raw_prob || 0.5;
  const p_market = oracleResult?.market_implied || 0.5;
  const direction = p_true > p_market ? "YES" : "NO";
  
  // Calculate raw EV and edge
  const p_target = direction === "YES" ? p_true : (1 - p_true);
  const m_target = direction === "YES" ? p_market : (1 - p_market);
  
  // Kelly formula (exact)
  // f* = (P_true - P_market) / (1 - P_market)
  const kelly_recommended = m_target < 1 ? Math.max(0, (p_target - m_target) / (1 - m_target)) : 0;
  
  // Fee model
  const config = getFeeConfig();
  const fee_rate = config.winnings_fee || 0.02;
  
  // Net EV formula (exact): net_ev = p_true × (1 × 0.98) - (1 - p_true) × entry_price
  // Assume entry_price is the market implied prob
  // "net_ev = p_true × (1 × 0.98) - (1 - p_true) × entry_price"
  // Note: if NO direction, formula needs p_target and entry_price (m_target). Let's use p_target.
  const net_ev = p_target * (1 * (1 - fee_rate)) - (1 - p_target) * m_target;
  
  const gross_edge = p_target - m_target;
  const net_edge = net_ev; // Simplify net edge as net ev, or difference between net return and entry?
  
  // EV grades: A >10%, B 7-10%, C 5-7%, else SKIP
  let ev_grade: "A" | "B" | "C" | "SKIP" = "SKIP";
  if (net_ev > 0.10) ev_grade = "A";
  else if (net_ev > 0.07) ev_grade = "B";
  else if (net_ev > 0.05) ev_grade = "C";
  
  // Time-decay: grade C + days_to_resolution < 2 → time_decay_watch: true
  const days_to_resolution = oracleResult?.days_to_resolution || 7;
  const time_decay_watch = ev_grade === "C" && days_to_resolution < 2;

  // Position sizing
  const brierScore = 0.25; // mock or fetch from db
  const resolvedTrades = 0; // mock or fetch from db
  const k_multiplier = kellyMultiplier(brierScore, resolvedTrades);
  let fractional_kelly = kelly_recommended * k_multiplier;
  
  // absolute_max milestones: <$500 portfolio → $10, <$1000 → $25, <$5000 → $50, else → $100
  // Fetch portfolio value or mock
  const portfolio_usdc = 1000; // Mocking $1000 portfolio size
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

  const final_position_size = adjusted_position;
  
  const result: EdgeResult = {
    marketSlug: slug,
    scoredAt,
    gross_edge,
    net_edge,
    ev_grade,
    net_ev,
    kelly_recommended,
    fractional_kelly,
    position_size: final_position_size,
    kelly_multiplier: k_multiplier,
    time_decay_watch,
    arb_opportunities,
    correlation_penalty,
    corr_blocked,
    direction,
    confidence: oracleResult?.confidence || 0.5,
  };
  
  // Save to DB
  const db = getDb();
  db.prepare(`
    INSERT INTO edge_results (
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
