/**
 * Seed script — populates all tables with realistic mock data for local testing.
 *
 * Usage:  npm run seed
 *         npx tsx src/db/seed.ts
 *
 * Safe to re-run: uses INSERT OR REPLACE / INSERT OR IGNORE throughout.
 */

import { getDb } from "./schema";
import { v4 as uuid } from "uuid";

const db = getDb();

// ── Helpers ──────────────────────────────────────────────────────
const now = Date.now();
const hour = 3_600_000;
const day = 86_400_000;
const ago = (ms: number) => now - ms;

// Realistic Polymarket-style slugs
const MARKETS = [
  { slug: "will-bitcoin-hit-100k-by-june-2026", question: "Will Bitcoin hit $100K by June 2026?", tokenId: "tok-btc-100k" },
  { slug: "us-recession-2026", question: "Will the US enter a recession in 2026?", tokenId: "tok-recession-2026" },
  { slug: "fed-rate-cut-march-2026", question: "Will the Fed cut rates in March 2026?", tokenId: "tok-fed-rate-cut" },
  { slug: "trump-wins-popular-vote-2028", question: "Will Trump win the popular vote in 2028?", tokenId: "tok-trump-pop" },
  { slug: "openai-ipo-2026", question: "Will OpenAI IPO in 2026?", tokenId: "tok-openai-ipo" },
  { slug: "eth-flips-btc-market-cap", question: "Will ETH flip BTC by market cap?", tokenId: "tok-eth-flip" },
  { slug: "ukraine-ceasefire-2026", question: "Will there be a Ukraine ceasefire in 2026?", tokenId: "tok-ukraine-cf" },
  { slug: "spacex-starship-orbital-success", question: "Will SpaceX achieve Starship orbital success?", tokenId: "tok-starship" },
];

// ── Pipeline Runs (core entity — other tables reference these) ──

const pipelineRuns = MARKETS.map((m, i) => ({
  id: `pr-${String(i + 1).padStart(3, "0")}`,
  market_slug: m.slug,
  market_question: m.question,
  created_at: ago((MARKETS.length - i) * 2 * hour),
  completed_at: ago((MARKETS.length - i) * 2 * hour - 45_000),
  decision: i % 3 === 0 ? "SKIP" : i % 2 === 0 ? "BET_YES" : "BET_NO",
  confidence: +(0.55 + Math.random() * 0.4).toFixed(3),
  signal_state: i % 3 === 0 ? "weak" : "strong",
  alert_sent: i < 5 ? 1 : 0,
  aura_output: JSON.stringify({ sentiment_delta: +(Math.random() * 0.3 - 0.1).toFixed(3), confidence: +(0.6 + Math.random() * 0.35).toFixed(3) }),
  flux_output: JSON.stringify({ liquidity_grade: ["A", "B+", "B", "C+"][i % 4], spread: +(0.01 + Math.random() * 0.04).toFixed(4) }),
  oracle_output: JSON.stringify({ calibrated_prob: +(0.3 + Math.random() * 0.4).toFixed(3), confidence: +(0.65 + Math.random() * 0.3).toFixed(3) }),
  edge_output: JSON.stringify({ net_edge: +(0.02 + Math.random() * 0.15).toFixed(4), ev_grade: ["S", "A", "B+", "B"][i % 4] }),
  sigma_output: JSON.stringify({ weighted_confidence: +(0.6 + Math.random() * 0.35).toFixed(3), recommendation: i % 3 === 0 ? "SKIP" : "EXECUTE" }),
  clause_output: JSON.stringify({ ambiguityScore: +(Math.random() * 0.3).toFixed(3), veto: 0, riskLevel: ["low", "medium", "low", "high"][i % 4] }),
  lucifer_output: JSON.stringify({ da_score: +(0.1 + Math.random() * 0.5).toFixed(3), contrarian_thesis: "Mock contrarian view" }),
}));

const insertPipelineRun = db.prepare(`
  INSERT OR REPLACE INTO pipeline_runs
    (id, market_slug, market_question, created_at, completed_at, decision, confidence,
     signal_state, alert_sent,
     aura_output, flux_output, oracle_output, edge_output, sigma_output, clause_output, lucifer_output)
  VALUES
    (@id, @market_slug, @market_question, @created_at, @completed_at, @decision, @confidence,
     @signal_state, @alert_sent,
     @aura_output, @flux_output, @oracle_output, @edge_output, @sigma_output, @clause_output, @lucifer_output)
`);

for (const run of pipelineRuns) insertPipelineRun.run(run);

// ── Trades (linked to pipeline runs) ─────────────────────────────

const insertTrade = db.prepare(`
  INSERT OR REPLACE INTO trades
    (id, order_id, market_slug, direction, size, price, net_ev, ev_grade, status, created_at, pipeline_run_id)
  VALUES (@id, @order_id, @market_slug, @direction, @size, @price, @net_ev, @ev_grade, @status, @created_at, @pipeline_run_id)
`);

pipelineRuns
  .filter((r) => r.decision !== "SKIP")
  .forEach((r, i) => {
    insertTrade.run({
      id: `trade-${String(i + 1).padStart(3, "0")}`,
      order_id: `0x${Math.random().toString(16).slice(2, 18)}`,
      market_slug: r.market_slug,
      direction: r.decision === "BET_YES" ? "YES" : "NO",
      size: +(5 + Math.random() * 45).toFixed(2),
      price: +(0.3 + Math.random() * 0.4).toFixed(2),
      net_ev: +(0.01 + Math.random() * 0.12).toFixed(4),
      ev_grade: ["S", "A", "B+", "B"][i % 4],
      status: i === 0 ? "pending" : "filled",
      created_at: r.completed_at!,
      pipeline_run_id: r.id,
    });
  });

// ── Oracle Results ───────────────────────────────────────────────

const insertOracle = db.prepare(`
  INSERT OR REPLACE INTO oracle_results
    (market_slug, scored_at, raw_prob, calibrated_prob, market_implied, confidence,
     data_sufficiency, bull_case, bear_case, reasoning,
     cross_market_signals, cross_market_divergence, arb_detected, arb_details,
     whale_signal_p_yes, days_to_resolution, ensemble_variance, longshot_adjusted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const m of MARKETS) {
  const rawProb = +(0.25 + Math.random() * 0.5).toFixed(3);
  insertOracle.run(
    m.slug, ago(2 * hour), rawProb, +(rawProb + 0.02).toFixed(3),
    +(rawProb - 0.05).toFixed(3), +(0.7 + Math.random() * 0.25).toFixed(3),
    +(0.6 + Math.random() * 0.35).toFixed(3),
    "Strong momentum and positive catalysts suggest upside.",
    "Macro headwinds and market uncertainty could suppress outcome.",
    "Composite analysis from multiple data sources indicates moderate confidence.",
    JSON.stringify([{ market: "related-market", correlation: 0.72 }]),
    Math.random() > 0.7 ? 1 : 0, Math.random() > 0.8 ? 1 : 0, null,
    +(0.4 + Math.random() * 0.2).toFixed(3),
    Math.floor(30 + Math.random() * 120),
    +(0.01 + Math.random() * 0.05).toFixed(4), 0
  );
}

// ── Edge Results ─────────────────────────────────────────────────

const insertEdge = db.prepare(`
  INSERT OR REPLACE INTO edge_results
    (marketSlug, scoredAt, gross_edge, net_edge, ev_grade, net_ev,
     kelly_recommended, fractional_kelly, position_size, kelly_multiplier,
     time_decay_watch, arb_opportunities, correlation_penalty, corr_blocked,
     direction, confidence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const m of MARKETS) {
  const grossEdge = +(0.04 + Math.random() * 0.15).toFixed(4);
  insertEdge.run(
    m.slug, ago(2 * hour), grossEdge, +(grossEdge - 0.015).toFixed(4),
    ["S", "A", "B+", "B"][Math.floor(Math.random() * 4)],
    +(0.02 + Math.random() * 0.1).toFixed(4),
    +(0.05 + Math.random() * 0.15).toFixed(4),
    +(0.01 + Math.random() * 0.04).toFixed(4),
    +(5 + Math.random() * 20).toFixed(2),
    0.25, Math.random() > 0.7 ? 1 : 0,
    JSON.stringify([]), +(Math.random() * 0.05).toFixed(4), 0,
    Math.random() > 0.5 ? "YES" : "NO",
    +(0.65 + Math.random() * 0.3).toFixed(3)
  );
}

// ── Clause Results ───────────────────────────────────────────────

const insertClause = db.prepare(`
  INSERT OR REPLACE INTO clause_results
    (marketSlug, scoredAt, ambiguityScore, riskLevel, veto, ambiguityFlags,
     technicality_risks, resolutionCriteria, disputeHistory, urgent, confidence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const m of MARKETS) {
  insertClause.run(
    m.slug, ago(2 * hour),
    +(Math.random() * 0.35).toFixed(3),
    ["low", "medium", "low", "high"][Math.floor(Math.random() * 4)],
    0,
    JSON.stringify(["subjective_language"]),
    JSON.stringify(["edge_case_timing"]),
    "Market resolves based on official announcement or data source.",
    0, 0,
    +(0.7 + Math.random() * 0.25).toFixed(3)
  );
}

// ── Flux Results ─────────────────────────────────────────────────

const insertFlux = db.prepare(`
  INSERT OR REPLACE INTO flux_results
    (marketSlug, scoredAt, liquidity_grade, spread, slippage_10, slippage_50,
     whale_detected, whale_signals, depth_imbalance, depth_yes_pct,
     grade_degrading, soft_veto, total_liquidity, confidence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const m of MARKETS) {
  insertFlux.run(
    m.slug, ago(2 * hour),
    ["A", "B+", "B", "C+"][Math.floor(Math.random() * 4)],
    +(0.01 + Math.random() * 0.04).toFixed(4),
    +(0.005 + Math.random() * 0.02).toFixed(4),
    +(0.01 + Math.random() * 0.05).toFixed(4),
    Math.random() > 0.7 ? 1 : 0,
    Math.floor(Math.random() * 3),
    +(Math.random() * 0.3 - 0.15).toFixed(4),
    +(0.4 + Math.random() * 0.2).toFixed(3),
    0, 0,
    +(50000 + Math.random() * 450000).toFixed(2),
    +(0.7 + Math.random() * 0.25).toFixed(3)
  );
}

// ── Aura Results ─────────────────────────────────────────────────

const insertAura = db.prepare(`
  INSERT OR REPLACE INTO aura_results
    (slug, scored_at, sentiment_delta, shift_detected, shift_direction, shift_velocity,
     shift_trend, shift_persistence, twitter_sentiment, twitter_volume_delta,
     telegram_bias, breaking_news, news_headlines, search_trend_spike, search_trend_value,
     whale_pos_yes_pct, whale_positioning, echo_chamber_risk, data_sufficiency, confidence,
     sources_used, source_status, raw_data, is_mock)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

for (const m of MARKETS) {
  insertAura.run(
    m.slug, ago(2 * hour),
    +(Math.random() * 0.4 - 0.15).toFixed(3),
    Math.random() > 0.5 ? 1 : 0,
    Math.random() > 0.5 ? "bullish" : "bearish",
    +(Math.random() * 0.5).toFixed(3),
    ["accelerating", "stable", "decelerating"][Math.floor(Math.random() * 3)],
    Math.floor(Math.random() * 5),
    +(Math.random() * 0.6 - 0.1).toFixed(3),
    +(Math.random() * 0.5).toFixed(3),
    Math.random() > 0.5 ? "bullish" : "neutral",
    Math.random() > 0.8 ? 1 : 0,
    JSON.stringify(["Market shows momentum shift", "Key catalyst approaching deadline"]),
    Math.random() > 0.7 ? 1 : 0,
    +(Math.random() * 100).toFixed(1),
    +(0.35 + Math.random() * 0.3).toFixed(3),
    Math.random() > 0.5 ? "long" : "neutral",
    +(Math.random() * 0.4).toFixed(3),
    +(0.5 + Math.random() * 0.45).toFixed(3),
    +(0.6 + Math.random() * 0.35).toFixed(3),
    JSON.stringify(["gnews", "polymarket_orderbook", "google_trends"]),
    JSON.stringify({ gnews: "ok", google_trends: "ok", polymarket: "ok" }),
    null
  );
}

// ── Research Notes (Sigma synthesis) ─────────────────────────────

const insertResearchNote = db.prepare(`
  INSERT OR REPLACE INTO research_notes
    (marketSlug, scoredAt, composite_prob, confidence, confidence_interval,
     consistency_score, recommended_direction, recommendation, skip_reason,
     thesis, bear_case, bull_case, agent_weights, lucifer_da_score, auto_synthesized)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const [i, m] of MARKETS.entries()) {
  const compositeProb = +(0.35 + Math.random() * 0.3).toFixed(3);
  insertResearchNote.run(
    m.slug, ago(2 * hour),
    compositeProb,
    +(0.6 + Math.random() * 0.35).toFixed(3),
    JSON.stringify([+(compositeProb - 0.1).toFixed(3), +(compositeProb + 0.1).toFixed(3)]),
    +(0.6 + Math.random() * 0.35).toFixed(3),
    i % 2 === 0 ? "YES" : "NO",
    i % 3 === 0 ? "SKIP" : "EXECUTE",
    i % 3 === 0 ? "Insufficient edge" : null,
    "Multi-agent synthesis suggests moderate conviction based on converging signals from Oracle probability estimation and Aura sentiment analysis.",
    "Downside risk from macro conditions and potential resolution ambiguity.",
    "Positive momentum, favorable liquidity, and converging agent signals support the position.",
    JSON.stringify({ oracle: 3, edge: 2, clause: 2, flux: 1, aura: 1 }),
    +(0.15 + Math.random() * 0.4).toFixed(3),
    1
  );
}

// ── Orchestrator Candidates ──────────────────────────────────────

const insertCandidate = db.prepare(`
  INSERT OR REPLACE INTO orchestrator_candidates
    (slug, token_id, question, opportunity_score, volume_score, price_move_score,
     liquidity_score, recency_score, triggers, scored_at, pipeline_triggered, pipeline_triggered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const [i, m] of MARKETS.entries()) {
  insertCandidate.run(
    m.slug, m.tokenId, m.question,
    +(0.5 + Math.random() * 0.5).toFixed(3),
    +(Math.random() * 0.8).toFixed(3),
    +(Math.random() * 0.6).toFixed(3),
    +(0.3 + Math.random() * 0.6).toFixed(3),
    +(Math.random() * 0.5).toFixed(3),
    JSON.stringify(["volume_spike", "price_move"].slice(0, 1 + (i % 2))),
    ago(i * hour),
    i < 5 ? 1 : 0,
    i < 5 ? ago(i * hour - 30_000) : null
  );
}

// ── Orchestrator Scan State ──────────────────────────────────────

db.prepare(`
  UPDATE orchestrator_scan_state
  SET last_scan_at = ?, markets_scanned = 142, candidates_found = 8, scan_cycle = 47
  WHERE id = 1
`).run(ago(10 * 60_000));

// ── Market Volume & Price Snapshots ──────────────────────────────

const insertVolume = db.prepare(`INSERT OR REPLACE INTO market_volume_snapshots (slug, volume, snapshot_at) VALUES (?, ?, ?)`);
const insertPrice = db.prepare(`INSERT OR REPLACE INTO market_price_snapshots (slug, yes_price, snapshot_at) VALUES (?, ?, ?)`);

for (const m of MARKETS) {
  insertVolume.run(m.slug, +(100000 + Math.random() * 900000).toFixed(2), ago(hour));
  // Insert 3 price snapshots per market for delta computation
  for (let h = 0; h < 3; h++) {
    insertPrice.run(m.slug, +(0.3 + Math.random() * 0.4).toFixed(4), ago(h * hour));
  }
}

// ── Paper Orders ─────────────────────────────────────────────────

const insertPaperOrder = db.prepare(`
  INSERT OR REPLACE INTO paper_orders (id, slug, direction, size, entry_price, status, created_at, filled_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const [i, m] of MARKETS.slice(0, 4).entries()) {
  const createdAt = ago((4 - i) * 3 * hour);
  insertPaperOrder.run(
    `po-${String(i + 1).padStart(3, "0")}`,
    m.slug,
    i % 2 === 0 ? "YES" : "NO",
    +(10 + Math.random() * 30).toFixed(2),
    +(0.3 + Math.random() * 0.35).toFixed(2),
    i < 3 ? "filled" : "open",
    createdAt,
    i < 3 ? createdAt + 15_000 : null
  );
}

// ── Paper Trades ─────────────────────────────────────────────────

const insertPaperTrade = db.prepare(`
  INSERT OR REPLACE INTO paper_trades (id, market_id, side, size, price, status, created_at, settled_at, pnl)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const [i, m] of MARKETS.slice(0, 5).entries()) {
  const createdAt = ago((5 - i) * 4 * hour);
  insertPaperTrade.run(
    `pt-${String(i + 1).padStart(3, "0")}`,
    m.slug,
    i % 2 === 0 ? "YES" : "NO",
    +(10 + Math.random() * 40).toFixed(2),
    +(0.35 + Math.random() * 0.3).toFixed(2),
    i < 3 ? "settled" : "open",
    createdAt,
    i < 3 ? createdAt + day : null,
    i < 3 ? +((Math.random() - 0.4) * 20).toFixed(2) : null
  );
}

// ── Executions (autopilot) ───────────────────────────────────────

const insertExecution = db.prepare(`
  INSERT OR REPLACE INTO executions (id, slug, side, amount, executed_at, status, order_id, fill_price, pnl)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const [i, m] of MARKETS.slice(0, 6).entries()) {
  insertExecution.run(
    i + 1,
    m.slug,
    i % 2 === 0 ? "YES" : "NO",
    +(5 + Math.random() * 35).toFixed(2),
    ago((6 - i) * day),
    i < 4 ? "filled" : "pending",
    `0x${Math.random().toString(16).slice(2, 18)}`,
    +(0.3 + Math.random() * 0.4).toFixed(2),
    i < 4 ? +((Math.random() - 0.35) * 25).toFixed(2) : null
  );
}

// ── Scanner Results ──────────────────────────────────────────────

const insertScanner = db.prepare(`
  INSERT OR IGNORE INTO scanner_results
    (slug, scanned_at, sigma_confidence, kelly_fraction, recommendation, probability,
     alert_sent, pipeline_result, execution_status, execution_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const [i, m] of MARKETS.entries()) {
  insertScanner.run(
    m.slug, ago(i * 30 * 60_000),
    +(0.5 + Math.random() * 0.45).toFixed(3),
    +(0.01 + Math.random() * 0.08).toFixed(4),
    i % 3 === 0 ? "SKIP" : "EXECUTE",
    +(0.3 + Math.random() * 0.4).toFixed(3),
    i < 4 ? 1 : 0,
    i % 3 !== 0 ? JSON.stringify({ decision: "BET_YES", confidence: 0.78 }) : null,
    i < 4 ? "filled" : null,
    i < 4 ? i + 1 : null
  );
}

// ── Resolutions (linked to pipeline runs) ────────────────────────

const insertResolution = db.prepare(`
  INSERT OR REPLACE INTO resolutions
    (id, pipeline_run_id, market_slug, predicted, outcome, brier_score, signal_type, resolved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const resolvedRuns = pipelineRuns.slice(0, 3);
for (const [i, run] of resolvedRuns.entries()) {
  const predicted = +(0.55 + Math.random() * 0.3).toFixed(3);
  const outcome = Math.random() > 0.4 ? 1 : 0;
  const brierScore = +((predicted - outcome) ** 2).toFixed(4);
  insertResolution.run(
    `res-${String(i + 1).padStart(3, "0")}`,
    run.id,
    run.market_slug,
    predicted, outcome, brierScore,
    "scanner",
    ago(i * day)
  );
}

// ── Panic Mode Events & Liquidation ──────────────────────────────

const panicId = uuid();
db.prepare(`
  INSERT OR REPLACE INTO panic_mode_events
    (id, request_code, status, pending_orders_count, active_positions_count,
     estimated_total_value, initiated_at, completed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(panicId, "PANIC-001", "completed", 3, 5, 1250.75, ago(3 * day), ago(3 * day - 120_000));

const liqReportId = uuid();
db.prepare(`
  INSERT OR REPLACE INTO liquidation_reports
    (id, report_code, panic_mode_event_id, status, completion_timestamp,
     total_realized_value, slippage_pct, gas_execution_cost, recovery_status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(liqReportId, "LIQ-001", panicId, "completed", ago(3 * day - 120_000), 1185.50, 0.023, 4.12, "full");

const insertLiqItem = db.prepare(`
  INSERT OR REPLACE INTO liquidation_line_items
    (id, liquidation_report_id, asset_symbol, asset_label, execution_price,
     trigger_price, size, size_unit, pnl_impact)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertLiqItem.run(uuid(), liqReportId, "BTC-100K", "Bitcoin $100K", 0.62, 0.65, 25, "shares", -7.50);
insertLiqItem.run(uuid(), liqReportId, "FED-CUT", "Fed Rate Cut Mar", 0.48, 0.50, 30, "shares", -6.00);
insertLiqItem.run(uuid(), liqReportId, "OPENAI-IPO", "OpenAI IPO 2026", 0.71, 0.73, 15, "shares", -3.00);

// ── Settings KV ──────────────────────────────────────────────────

const insertKV = db.prepare(`INSERT OR REPLACE INTO settings_kv (key, value) VALUES (?, ?)`);
insertKV.run("autopilot_enabled", "true");
insertKV.run("autopilot_max_daily_trades", "5");
insertKV.run("autopilot_min_kelly", "0.02");
insertKV.run("telegram_alerts", "true");
insertKV.run("default_order_size", "10");

// ── Markets Cache ────────────────────────────────────────────────

db.prepare(`INSERT OR REPLACE INTO markets_cache (key, data, cached_at) VALUES (?, ?, ?)`).run(
  "active_markets",
  JSON.stringify(MARKETS.map((m) => ({
    slug: m.slug,
    question: m.question,
    clobTokenIds: [m.tokenId],
    active: true,
    volume: +(100000 + Math.random() * 500000).toFixed(2),
    liquidity: +(50000 + Math.random() * 200000).toFixed(2),
    bestAsk: +(0.3 + Math.random() * 0.4).toFixed(2),
    bestBid: +(0.25 + Math.random() * 0.35).toFixed(2),
  }))),
  ago(5 * 60_000)
);

// ── Resolution Backfill Log ──────────────────────────────────────

const insertBackfill = db.prepare(`INSERT OR REPLACE INTO resolution_backfill_log (slug, source, backfilled_at, positions_found) VALUES (?, ?, ?, ?)`);
for (const m of MARKETS.slice(0, 3)) {
  insertBackfill.run(m.slug, "polymarket_api", ago(day), 1);
}

// ── Summary ──────────────────────────────────────────────────────

const counts: Record<string, number> = {};
const tables = [
  "pipeline_runs", "trades", "oracle_results", "edge_results", "clause_results",
  "flux_results", "aura_results", "research_notes", "orchestrator_candidates",
  "market_volume_snapshots", "market_price_snapshots", "paper_orders", "paper_trades",
  "executions", "scanner_results", "resolutions", "panic_mode_events",
  "liquidation_reports", "liquidation_line_items", "settings_kv", "markets_cache",
  "resolution_backfill_log", "risk_configurations", "agent_thresholds",
  "global_circuit_breakers", "settings", "versions",
];

for (const t of tables) {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
  counts[t] = row.c;
}

console.log("\n--- Seed complete ---");
console.log("Table row counts:");
for (const [table, count] of Object.entries(counts)) {
  console.log(`  ${table.padEnd(30)} ${count}`);
}
console.log("");
