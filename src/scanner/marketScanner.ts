import { CircuitBreaker } from "../risk/circuitBreaker";
import { execFile } from "child_process";
import { runOracle } from "../oracle/index";
import { runEdge } from "../edge/index";
import { runClause } from "../clause/index";
import { runAura } from "../aura/index";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { getSettings } from "../db/queries";

// ── Types ──────────────────────────────────────────────────────

export interface Market {
  slug: string;
  question: string;
  volume: number;
  liquidity: number;
  endDate: string;
  yesPrice: number;
  tokenId: string;
  noTokenId?: string;
}

export interface ScanResult {
  slug: string;
  tokenId?: string;
  noTokenId?: string;
  yesPrice?: number;
  scannedAt: number;
  sigmaConfidence: number;
  kellyFraction: number;
  recommendation: "BET_YES" | "BET_NO" | "SKIP" | "VETO";
  probability: number;
  alertSent: boolean;
  shouldAlert: boolean;
  pipelineResult: object;
  // Populated after execution
  orderId?: string;
  executionStatus?: "placed" | "failed" | "paper";
  pnlToday?: number;
  tradesToday?: number;
  // Fields from alert caller
  question?: string;
  oracle_prob?: number;
  market_price?: number;
  edge?: number;
  kelly_amount?: number;
  sigma_thesis?: string;
  clause_risk_level?: string;
  clause_summary?: string;
}

// ── Real Agent Pipeline ───────────────────────────────────────

interface AgentBundle {
  oracle: { confidence: number; estimated_true_prob?: number };
  edge_agent: { fractional_kelly: number; position_size: number; direction: string; kelly_recommended?: number };
  sigma: { confidence: number; decision: string; thesis: string };
  clause: { riskLevel: string; resolutionCriteria: string; veto: boolean; urgent: boolean; ambiguityScore?: number };
}
const agentCache = new Map<string, { ts: number; data: AgentBundle }>();
const AGENT_CACHE_TTL = 8 * 60 * 1000;
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

async function fetchWithTimeout(url: string, ms = 8000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function runRealPipeline(slug: string, yesPrice: number, question: string = slug): Promise<{
  sigma: { confidence: number; decision: string; thesis: string };
  edge: { kelly_fraction: number; estimated_true_prob: number; kelly_amount: number };
  clause: { veto: boolean; risk_level: string; summary: string };
  pipelineResult: object;
}> {
  const cached = agentCache.get(slug);
  if (cached && Date.now() - cached.ts < AGENT_CACHE_TTL) {
    const d = cached.data;
    const kellyFrac = d.edge_agent.fractional_kelly ?? 0;
    const trueProbEstimate = d.oracle.estimated_true_prob ?? d.oracle.confidence ?? yesPrice;
    return {
      sigma: d.sigma,
      edge: { kelly_fraction: kellyFrac, estimated_true_prob: trueProbEstimate, kelly_amount: d.edge_agent.position_size ?? 0 },
      clause: { veto: d.clause.veto, risk_level: d.clause.riskLevel ?? "UNKNOWN", summary: d.clause.resolutionCriteria?.slice(0, 120) ?? "No summary" },
      pipelineResult: d,
    };
  }

  // Run Oracle + Clause + Aura in parallel (Oracle writes to DB, Edge reads it)
  // BUG FIX: call runAura() directly instead of HTTP self-request.
  // The HTTP path went through /api/aura/:slug which re-fetched from Gamma (redundant + fragile),
  // and on any failure returned sentimentDelta=0, silently killing the Aura signal.
  const [oracleRes, clauseRes, auraRes] = await Promise.allSettled([
    runOracle({ slug, question, yesPrice, tokenId: '' }),
    runClause({ slug, question, description: question, days_to_resolution: 7 }),
    runAura({ slug, question }),
  ]);

  // Extract Oracle result
  const rawOracle = (oracleRes.status === "fulfilled" && oracleRes.value) ? oracleRes.value as any : null;
  const trueProbEstimate = rawOracle?.calibrated_prob ?? rawOracle?.p_yes ?? yesPrice;
  const oracleConf = rawOracle?.confidence ?? (Math.abs(yesPrice - 0.5) > 0.05 ? 0.55 : 0.40);
  const oracle = { confidence: oracleConf, estimated_true_prob: trueProbEstimate };
  // Extract Aura sentiment delta (positive = bullish, negative = bearish)
  const rawAura = (auraRes.status === "fulfilled" && auraRes.value) ? auraRes.value as any : null;
  const sentimentDelta = rawAura?.sentimentDelta ?? rawAura?.sentiment_score ?? 0;
  const auraConfidence = rawAura?.confidence ?? 0;
  const auraDataSufficiency = rawAura?.dataSufficiency ?? 0;

  console.log(`[Scanner] Oracle for ${slug}: calibrated_prob=${trueProbEstimate.toFixed(3)} conf=${oracleConf.toFixed(2)} aura_sentiment=${sentimentDelta.toFixed(3)} aura_conf=${auraConfidence.toFixed(2)} aura_data=${auraDataSufficiency.toFixed(2)} source=${rawOracle ? "live" : "fallback"}`);

  // Now run Edge inline — pass oracleResult directly (no HTTP)
  const edgeRes = await Promise.allSettled([
    runEdge({ slug, question, yesPrice }, rawOracle),
  ]);
  const [edgeSettled] = edgeRes;

  // Normalize Edge — returns fractional_kelly, position_size, direction
  const rawEdge = (edgeSettled.status === "fulfilled" && edgeSettled.value) ? edgeSettled.value as any : null;
  const edgeData = {
    fractional_kelly: rawEdge?.fractional_kelly ?? 0,
    position_size: rawEdge?.position_size ?? 0,
    direction: rawEdge?.direction ?? (yesPrice >= 0.5 ? "YES" : "NO"),
    kelly_recommended: rawEdge?.kelly_recommended ?? 0,
  };

  // Normalize Clause — returns riskLevel (camelCase), resolutionCriteria, veto, urgent
  const rawClause = (clauseRes.status === "fulfilled" && clauseRes.value) ? clauseRes.value as any : null;
  const clauseData = {
    riskLevel: rawClause?.riskLevel ?? "UNKNOWN",
    resolutionCriteria: rawClause?.resolutionCriteria ?? "",
    veto: rawClause?.veto ?? false,
    urgent: rawClause?.urgent ?? false,
    ambiguityScore: rawClause?.ambiguityScore ?? 0,
  };

  // Synthesize Sigma: Kelly edge + Aura sentiment amplifier + Clause veto
  const kellyFrac = edgeData.fractional_kelly;
  const sentimentAmplifier = Math.abs(sentimentDelta) * 0.15; // Aura adds up to 15% confidence
  const priceOffCenter = Math.abs(yesPrice - 0.5) > 0.05;
  // Task 3: Oracle divergence drives signal even when Kelly=0
  const oracleDivergence = Math.abs(trueProbEstimate - yesPrice);
  const derivedKelly = kellyFrac > 0 ? kellyFrac : Math.min(oracleDivergence / 2, 0.10);
  // hasEdge: Kelly > 2% OR oracle divergence > 8% OR strong Aura signal OR reasonable Oracle conf
  // Require REAL edge: oracle divergence > 12% (meaningful mispricing) or Kelly > 3%
  // Removed weak fallback conditions — priceOffCenter alone is not edge
  const hasEdge = kellyFrac >= 0.03 || oracleDivergence > 0.12;
  // Sentiment-aligned direction: if Aura is bullish and Oracle > yesPrice → YES; else follow Kelly
  let direction = edgeData.direction;
  if (Math.abs(sentimentDelta) >= 0.10) {
    direction = sentimentDelta > 0 ? "YES" : "NO";
  }
  const sigmaDecision = clauseData.veto ? "VETO" : hasEdge ? `BET_${direction}` : "SKIP";
  const baseConf = hasEdge ? 0.50 + derivedKelly * 3 + sentimentAmplifier + oracleConf * 0.10 : 0;
  const sigmaConfidence = clauseData.veto ? 0 : Math.min(baseConf, 0.80);
  const sigmaData = {
    confidence: sigmaConfidence,
    decision: sigmaDecision,
    thesis: `Oracle(pipeline)=${trueProbEstimate.toFixed(2)} market=${yesPrice.toFixed(2)} kelly=${(kellyFrac*100).toFixed(1)}% aura_sentiment=${sentimentDelta.toFixed(2)}. ${clauseData.veto ? "VETOED." : sigmaDecision}`,
  };

  const bundle: AgentBundle = { oracle, edge_agent: edgeData, sigma: sigmaData, clause: clauseData };
  agentCache.set(slug, { ts: Date.now(), data: bundle });

  return {
    sigma: sigmaData,
    edge: { kelly_fraction: kellyFrac, estimated_true_prob: trueProbEstimate, kelly_amount: edgeData.position_size },
    clause: { veto: clauseData.veto, risk_level: clauseData.riskLevel, summary: clauseData.resolutionCriteria?.slice(0, 120) ?? "No summary" },
    pipelineResult: bundle,
  };
}

// ── Market Scoring ────────────────────────────────────────────

function scoreMarket(volume: number, daysToExpiry: number, yesPrice: number, liquidity: number, maxVol: number, maxLiq: number): number {
  const volScore = maxVol > 0 ? Math.log10(Math.max(volume, 1)) / Math.log10(Math.max(maxVol, 2)) : 0;
  const urgencyScore = Math.min(1, 3 / Math.max(daysToExpiry, 0.1));
  const centralityScore = 1 - Math.abs(yesPrice - 0.5) / 0.5;
  const liqScore = maxLiq > 0 ? Math.log10(Math.max(liquidity, 1)) / Math.log10(Math.max(maxLiq, 2)) : 0;
  return (volScore * 0.35) + (urgencyScore * 0.25) + (centralityScore * 0.20) + (liqScore * 0.20);
}

// ── State ──────────────────────────────────────────────────────

let scannerRunning = false;
let scannerHealthy = false;
let lastScanAt = 0;
let scannedToday = 0;
let alertsTriggered = 0;
let lastScanDay = new Date().toDateString();

// ── Helpers ────────────────────────────────────────────────────

function runPolymarketCli(args: string[]): Promise<unknown> {
  const bin = process.env.POLYMARKET_CLI || "polymarket";
  const fullArgs = ["-o", "json", ...args];
  return new Promise((resolve, reject) => {
    execFile(bin, fullArgs, { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`polymarket ${args.join(" ")} failed: ${stderr || err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

function daysUntilClose(endDate: string): number {
  const end = new Date(endDate).getTime();
  const now = Date.now();
  return (end - now) / (1000 * 60 * 60 * 24);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Pipeline simulation (matches pipeline.ts logic) ───────────

function buildPipelineResult(slug: string, yesPrice: number): {
  sigma: { confidence: number; decision: string };
  edge: { kelly_fraction: number; estimated_true_prob: number };
  pipelineResult: object;
} {
  // FALLBACK pipeline — used only when real agent pipeline throws
  // DO NOT use Math.random(). If we have no signal, we have no edge. Return SKIP with 0 confidence.
  // This prevents random-noise trades from firing via the fallback path.
  const estimatedTrueProb = yesPrice; // no fake oracle — market price is our null hypothesis
  const edge = 0; // no computed edge without real agents
  const kellyFraction = 0;
  const adjustedConf = 0; // zero confidence → should not fire shouldAlert
  const decision = "SKIP"; // always SKIP in fallback — never trade on noise

  const pipelineResult = {
    slug,
    oracle: { yes_price: yesPrice, estimated_true_prob: estimatedTrueProb },
    edge: {
      estimated_true_prob: estimatedTrueProb,
      market_price: yesPrice,
      edge: parseFloat(edge.toFixed(4)),
      kelly_fraction: parseFloat(kellyFraction.toFixed(4)),
      ev_grade: kellyFraction > 0.4 ? "A" : kellyFraction > 0.2 ? "B" : "C",
    },
    sigma: {
      decision,
      confidence: parseFloat((adjustedConf * 100).toFixed(1)),
      thesis: `Edge=${edge.toFixed(3)}, Kelly=${kellyFraction.toFixed(3)}. Decision: ${decision}`,
    },
  };

  return {
    sigma: { confidence: adjustedConf, decision },
    edge: { kelly_fraction: kellyFraction, estimated_true_prob: estimatedTrueProb },
    pipelineResult,
  };
}

// ── Scanner class ──────────────────────────────────────────────

export class MarketScanner {
  async scan(): Promise<void> {
    // GLOBAL KILL SWITCH: Respect panic_mode and circuit breaker
    const db = getDb();
    const panicMode = db.prepare("SELECT panic_mode_enabled FROM global_circuit_breakers LIMIT 1").get() as { panic_mode_enabled: number } | undefined;
    if (panicMode?.panic_mode_enabled === 1) {
      console.log("[Scanner] GLOBAL KILL SWITCH: panic_mode_enabled is 1. Stopping scan.");
      return;
    }

    if (scannerRunning) {
      console.log("[Scanner] Already running, skipping cycle");
      return;
    }

    scannerRunning = true;
    lastScanAt = Date.now();

    // Health check: verify DB is accessible before scanning
    try {
      const db = getDb();
      db.prepare("SELECT COUNT(*) FROM executions").get();
      scannerHealthy = true;
    } catch (e) {
      console.error("[Scanner] Health check failed, skipping scan:", e);
      scannerHealthy = false;
      scannerRunning = false;
      return;
    }

    if (!scannerHealthy) {
      console.log("[Scanner] Scanner unhealthy, skipping cycle");
      scannerRunning = false;
      return;
    }

    // Reset daily counter if day changed
    const today = new Date().toDateString();
    if (today !== lastScanDay) {
      scannedToday = 0;
      lastScanDay = today;
    }

    console.log("[Scanner] Starting market scan cycle");

    try {
      const markets = await this.fetchTopMarkets(200);
      console.log(`[Scanner] Fetched ${markets.length} candidate markets`);

      // Serial market processing — CLOB orders are sequential (not parallel) to avoid
      // concurrent balance reads causing "not enough balance" on simultaneous submissions
      const cycleScanned = new Set<string>();
      const themeCap: Record<string, number> = {}; // max 2 per correlated theme cluster
      const filtered: Market[] = [];
      for (const m of markets) {
        if (cycleScanned.has(m.slug)) continue;
        if (await this.shouldSkip(m.slug)) continue;
        const theme = m.slug.split("-").slice(0, 3).join("-").substring(0, 18);
        if ((themeCap[theme] ?? 0) >= 2) continue; // cap Iran/similar clusters at 2
        themeCap[theme] = (themeCap[theme] ?? 0) + 1;
        cycleScanned.add(m.slug);
        filtered.push(m);
      }

      console.log(`[Scanner] ${filtered.length} markets to scan after dedup`);

      // Pipeline analysis (Oracle/Aura/Edge) runs in parallel batches of 8 for speed.
      // autoExecute is called serially AFTER each batch to prevent concurrent CLOB balance exhaustion.
      for (let i = 0; i < filtered.length; i += 8) {
        const batch = filtered.slice(i, i + 8);
        // Phase 1: run all pipelines in parallel (no CLOB calls here)
        const batchResults: Array<{ result: any; question: string } | null> = await Promise.all(
          batch.map(async (m) => {
            try {
              const result = await this.runPipelineForMarket(m.slug, m.yesPrice, m.tokenId, m.question, m.noTokenId ?? "");
              await this.storeScanResult(result, m.question);
              scannedToday++;
              console.log(`[Scanner] ${m.slug}: σ=${result.sigmaConfidence.toFixed(2)} Kelly=${result.kellyFraction.toFixed(2)} rec=${result.recommendation} shouldAlert=${result.shouldAlert}`);
              return { result, question: m.question };
            } catch (err) {
              console.error(`[Scanner] Pipeline error for ${m.slug}:`, err);
              return null;
            }
          })
        );

        // Phase 2: execute trades SERIALLY — one CLOB order at a time, no race on balance
        for (const item of batchResults) {
          if (!item) continue;
          const { result, question } = item;
          if (result.shouldAlert) {
            alertsTriggered++;
            console.log(`[Scanner] ALERT triggered for ${result.slug}: σ=${result.sigmaConfidence.toFixed(2)} Kelly=${result.kellyFraction.toFixed(2)}`);
            await this.autoExecute(result, question).catch(e =>
              console.error(`[Scanner] autoExecute failed for ${result.slug}:`, e)
            );
          }
        }

        // Small delay between batches
        if (i + 8 < filtered.length) await sleep(1000);
      }

      console.log(`[Scanner] Scan cycle complete. Processed ${filtered.length} markets.`);
    } catch (err) {
      console.error("[Scanner] Scan cycle failed:", err);
    } finally {
      scannerRunning = false;
    }
  }

  async fetchTopMarkets(limit: number): Promise<Market[]> {
    let rawMarkets: unknown[];

    // Always use Gamma API (polymarket-cli returns oldest markets by ID, not active ones)
    console.log("[Scanner] Fetching from Gamma API...");
    // Sort by liquidity to favour political/geopolitical markets over daily sports
    const res = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200&order=liquidity&ascending=false`);
    if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
    const data = await res.json() as unknown[];
    rawMarkets = Array.isArray(data) ? data : [];
    console.log(`[Scanner] Gamma API returned ${rawMarkets.length} raw markets`);

    const now = Date.now();
    // date filter: only skip already-closed markets

    const markets: Market[] = [];

    for (const raw of rawMarkets) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;

      const slug = (m["slug"] as string) || "";
      if (!slug) continue;

      // Exclude daily sports, esports, and low-alpha markets
      // Expanded sports exclusion — includes Copa del Rey (cdr-), basketball leagues (bl1/2/3),
      // Russian Premier League (rusrp-), Japanese leagues (j1/j2/j3), individual team slugs, etc.
      const sportsPattern = /^(nba-|nhl-|nfl-|mlb-|nba|lol-|cs2-|valorant-|dota-|cfb-|cbb-|ncaa-|ufc-|boxing-|tennis-|soccer-|epl-|laliga-|serieA-|bundesliga-|champions-league-|nba-player-|mlb-player-|cdr-|bl1-|bl2-|bl3-|bl4-|rusrp-|j1-|j2-|j3-|mls-|liga-mx-|afl-|nrl-|rugby-|cricket-|formula1-|f1-|golf-|pga-|wta-|atp-|nba2k-|fifa-|pes-|overwatch-|esport|spread-|handicap-|map-handicap-|point-spread-|moneyline-|over-under-|ats-|val-|lal-|atm-|bar-|mad-|sev-|bet-|vil-|cel-|osa-|ray-|get-|ala-)|highest-temperature-|lowest-temperature-|-up-or-down-on-/i;
      if (sportsPattern.test(slug)) continue;

      const endDate = (m["endDate"] as string) || (m["end_date_iso"] as string) || "";
      const volume = Number(m["volume24hr"] ?? m["volume"] ?? 0);
      const liquidity = Number(m["liquidity"] ?? 0);

      const outcomePrices = m["outcomePrices"];
      let yesPrice = 0.5;
      try {
        const prices = typeof outcomePrices === "string"
          ? JSON.parse(outcomePrices)
          : Array.isArray(outcomePrices) ? outcomePrices : [];
        yesPrice = prices.length > 0 ? Number(prices[0]) : 0.5;
      } catch {
        yesPrice = Number(m["lastTradePrice"] ?? 0.5);
      }

      // Filter criteria:
      // 1. Not already closed + must close within 96h
      if (endDate) {
        const closeTime = new Date(endDate).getTime();
        if (closeTime < now) continue; // already closed
        if (closeTime - now > 30 * 24 * 60 * 60 * 1000) continue; // too far out (30 days)
      }

      // 2. Volume > $1k (liquid enough to trade; $5k was too restrictive)
      if (volume < 1000) continue;

      // 3. Price 0.03–0.97: exclude near-certain but keep low-prob YES (our BET_NO targets)
      // Previous 0.05 floor was cutting all Iran/geo markets at 3-4% YES price
      if (yesPrice < 0.03 || yesPrice > 0.97) continue;

      let tokenId = "";
      const clobTokenIds = m["clobTokenIds"];
      let noTokenId = "";
      if (Array.isArray(clobTokenIds) && clobTokenIds.length > 0) {
        tokenId = String(clobTokenIds[0]);
        noTokenId = clobTokenIds.length > 1 ? String(clobTokenIds[1]) : "";
      } else if (typeof clobTokenIds === "string") {
        try { const p = JSON.parse(clobTokenIds); tokenId = Array.isArray(p) ? String(p[0]) : ""; noTokenId = Array.isArray(p) && p.length > 1 ? String(p[1]) : ""; } catch { tokenId = ""; }
      }

      markets.push({
        slug,
        question: (m["question"] as string) || slug,
        volume,
        liquidity,
        endDate,
        yesPrice,
        tokenId,
        noTokenId,
      });
    }

    // Score and rank markets
    const maxVol = Math.max(...markets.map(m => m.volume), 1);
    const maxLiq = Math.max(...markets.map(m => m.liquidity), 1);

    const scored = markets.map(m => ({
      market: m,
      score: scoreMarket(m.volume, daysUntilClose(m.endDate), m.yesPrice, m.liquidity, maxVol, maxLiq),
    }));
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(s => s.market);
  }

  async shouldSkip(slug: string): Promise<boolean> {
    const db = getDb();
    // 3-min TTL: prevents double-scan within single cycle, but allows next 5-min cycle to re-scan
    const fifteenMinAgo = Date.now() - 3 * 60 * 1000;
    const row = db
      .prepare<[string, number], { scanned_at: number }>(
        "SELECT scanned_at FROM scanner_results WHERE slug = ? AND scanned_at >= ? ORDER BY scanned_at DESC LIMIT 1"
      )
      .get(slug, fifteenMinAgo);
    return !!row;
  }

  async runPipelineForMarket(slug: string, yesPrice: number = 0.5, tokenId: string = '', question: string = slug, noTokenId: string = ''): Promise<ScanResult> {
    let sigma: { confidence: number; decision: string; thesis?: string };
    let edge: { kelly_fraction: number; estimated_true_prob: number; kelly_amount?: number };
    let pipelineResult: object;
    let clause: { veto?: boolean; risk_level?: string; summary?: string } | undefined;

    try {
      const real = await runRealPipeline(slug, yesPrice, question);
      sigma = real.sigma;
      edge = real.edge;
      pipelineResult = real.pipelineResult;
      clause = real.clause;
    } catch {
      // Fallback to simulated pipeline
      const fallback = buildPipelineResult(slug, yesPrice);
      sigma = fallback.sigma;
      edge = fallback.edge;
      pipelineResult = fallback.pipelineResult;
    }

    const recommendation = clause?.veto
      ? "VETO"
      : sigma.decision === "BET_YES"
        ? "BET_YES"
        : sigma.decision === "BET_NO"
          ? "BET_NO"
          : "SKIP";

    // Task 2: fire when sigma confident OR oracle diverges meaningfully from market
    const pipelineOracle = (pipelineResult as any)?.oracle;
    // Oracle returns `market_implied`, not `yes_price` — fix field name for divergence check
    const marketYesPrice: number = (pipelineOracle?.market_implied as number | undefined) ?? (pipelineOracle?.yes_price as number | undefined) ?? (pipelineOracle?.yesPrice as number | undefined) ?? 0;
    const estimatedProb: number = (pipelineOracle?.calibrated_prob as number | undefined) ?? (pipelineOracle?.estimated_true_prob as number | undefined) ?? edge.estimated_true_prob;
    // Real edge threshold: oracle must diverge >12% from market, AND sigma ≥0.55
    // This prevents low-confidence spray trades that drain capital with no edge
    const oracleDivergenceFromMarket = marketYesPrice > 0 && Math.abs(estimatedProb - marketYesPrice) > 0.12;
    const shouldAlert =
      (!clause?.veto) &&
      edge.kelly_fraction > 0 &&
      sigma.confidence >= 0.55 &&
      recommendation !== "SKIP" &&
      recommendation !== "VETO";

    return {
      slug,
      scannedAt: Date.now(),
      sigmaConfidence: sigma.confidence,
      kellyFraction: edge.kelly_fraction,
      recommendation: recommendation as ScanResult["recommendation"],
      probability: edge.estimated_true_prob,
      yesPrice: marketYesPrice,
      tokenId,
      noTokenId,
      alertSent: false,
      shouldAlert,
      pipelineResult,
    };
  }

  async storeScanResult(result: ScanResult, question?: string): Promise<void> {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO scanner_results
        (slug, scanned_at, sigma_confidence, kelly_fraction, recommendation, probability, alert_sent, pipeline_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.slug,
      result.scannedAt,
      result.sigmaConfidence,
      result.kellyFraction,
      result.recommendation,
      result.probability,
      result.alertSent ? 1 : 0,
      JSON.stringify(result.pipelineResult),
    );

    // If this market should alert, write a pipeline_runs entry so the alert poller catches it
    if (result.shouldAlert) {
      const pr = result.pipelineResult as Record<string, unknown>;
      const edgeData = (pr["edge"] ?? {}) as Record<string, unknown>;
      const sigmaData = (pr["sigma"] ?? {}) as Record<string, unknown>;
      const runId = `scanner-${result.slug}-${result.scannedAt}`;

      // Only insert if not already present
      const existing = db.prepare("SELECT id FROM pipeline_runs WHERE id = ?").get(runId);
      if (!existing) {
        db.prepare(`
          INSERT INTO pipeline_runs
            (id, market_slug, market_question, created_at, completed_at, decision, confidence,
             edge_output, sigma_output, alert_sent, signal_state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'TRADE')
        `).run(
          runId,
          result.slug,
          question ?? result.slug,
          result.scannedAt,
          result.scannedAt,
          result.recommendation,
          result.sigmaConfidence,
          JSON.stringify({
            net_edge: edgeData["kelly_fraction"] ?? 0,
            fractional_kelly: result.kellyFraction,
            position_size: result.kellyFraction * 10,
            direction: result.recommendation === "BET_YES" ? "YES" : "NO",
            estimated_true_prob: result.probability,
          }),
          JSON.stringify({
            recommendation: result.recommendation,
            confidence: result.sigmaConfidence,
            thesis: (sigmaData["thesis"] as string) ?? `Scanner signal: ${result.recommendation} @ p=${result.probability.toFixed(2)}`,
            decision: result.recommendation,
          }),
        );
        console.log(`[Scanner] Wrote pipeline_runs entry for alert: ${result.slug}`);
      }

      // Also insert/update edge_results so the alert poller JOIN works
      db.prepare(`
        INSERT OR REPLACE INTO edge_results
          (marketSlug, scoredAt, gross_edge, net_edge, ev_grade, net_ev, kelly_recommended,
           fractional_kelly, position_size, kelly_multiplier, time_decay_watch,
           arb_opportunities, correlation_penalty, corr_blocked, direction, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.slug,
        result.scannedAt,
        result.kellyFraction,
        result.kellyFraction,
        result.sigmaConfidence >= 0.7 ? "A" : result.sigmaConfidence >= 0.5 ? "B" : "C",
        result.kellyFraction * result.probability,
        result.kellyFraction,
        result.kellyFraction,
        result.kellyFraction * 10,
        0.25,
        0,
        "[]",
        0,
        0,
        result.recommendation === "BET_YES" ? "YES" : "NO",
        result.sigmaConfidence,
      );
    }
  }

  async autoExecute(result: ScanResult, question: string): Promise<void> {
    const db = getDb();
    const settings = getSettings();
    const paperMode = settings.paper_mode;
    const maxBet = parseFloat(process.env.MAX_BET_USDC ?? "10");
    const maxPerDay = parseInt(process.env.MAX_TRADES_PER_DAY ?? "50", 10);
    const dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT_USDC ?? "25");

    // Circuit breaker reads — fail closed on DB errors
    let tradesRow: { cnt: number };
    let pnlRow: { total: number };
    let recent: unknown;
    const today = new Date(); today.setHours(0,0,0,0);
    const todayTs = today.getTime();

    try {
      tradesRow = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayTs) as { cnt: number };
      pnlRow = db.prepare("SELECT COALESCE(SUM(pnl),0) as total FROM executions WHERE executed_at >= ?").get(todayTs) as { total: number };
      const sixHAgo = Date.now() - 2 * 60 * 60 * 1000; // 2hr rate limit (was 6hr)
      recent = db.prepare("SELECT id FROM executions WHERE slug = ? AND executed_at >= ?").get(result.slug, sixHAgo);
    } catch (e) {
      console.error("[autoExecute] Circuit breaker DB read failed — fail closed:", e);
      return;
    }

    if (tradesRow.cnt >= maxPerDay) {
      console.log(`[autoExecute] MAX_TRADES_PER_DAY (${maxPerDay}) reached — skipping ${result.slug}`);
      return;
    }

    if (pnlRow.total <= -dailyLossLimit) {
      console.log(`[autoExecute] DAILY_LOSS_LIMIT hit ($${pnlRow.total.toFixed(2)}) — pausing`);
      return;
    }

    if (recent) {
      console.log(`[autoExecute] Rate limit: already traded ${result.slug} in last 2h`);
      return;
    }

    // BET_YES: buy YES token (clobTokenIds[0]); BET_NO: buy NO token (clobTokenIds[1])
    // Never sell tokens we don't own — always BUY with USDC.e collateral
    const clobSide = "buy";

    // Kelly amount: NO edge = NO trade. Kelly=0 means skip, not default to $10.
    // A $10 floor on a zero-edge signal is just gambling — remove it.
    const portfolioUsdc = parseFloat(process.env.PORTFOLIO_USDC ?? "247");
    if (result.kellyFraction <= 0) {
      console.log(`[autoExecute] Kelly=0 on ${result.slug} — no edge, skipping (not gambling)`);
      return;
    }
    const kellyAmount = result.kellyFraction * portfolioUsdc;
    const amount = Math.max(5, Math.min(kellyAmount, maxBet)); // floor $5 only when kelly > 0

    // Flux liquidity gate: check orderbook depth before CLOB — prevents FOK failures on illiquid markets
    // FIXED F1: pass the correct tokenId for direction (NO token for BET_NO, YES token for BET_YES)
    if (!paperMode) {
      try {
        const fluxIsBetNo = result.recommendation === "BET_NO";
        const fluxTokenId = fluxIsBetNo ? (result.noTokenId || result.tokenId || "") : (result.tokenId || "");
        const fluxUrl = fluxTokenId
          ? `${BACKEND_URL}/api/flux/${result.slug}?tokenId=${encodeURIComponent(fluxTokenId)}`
          : `${BACKEND_URL}/api/flux/${result.slug}`;
        const fluxCheck = await fetch(fluxUrl, { signal: AbortSignal.timeout(8000) });
        if (fluxCheck.ok) {
          const fluxData = await fluxCheck.json() as Record<string, unknown>;
          if (fluxData?.soft_veto === true) {
            console.log(`[autoExecute] FLUX soft_veto triggered for ${result.slug} — insufficient liquidity, skipping CLOB`);
            db.prepare("INSERT INTO executions (slug, side, amount, executed_at, status, order_id, fill_price) VALUES (?, ?, ?, ?, 'skipped_flux', NULL, NULL)").run(
              result.slug, clobSide, amount, Date.now()
            );
            return;
          }
          console.log(`[autoExecute] Flux OK for ${result.slug} — liquidity sufficient`);
        }
      } catch (e) {
        console.warn(`[autoExecute] Flux check failed — proceeding with caution:`, (e as Error).message);
      }
    }



    if (paperMode) {
      // Paper mode — log only
      const entryPrice = Math.max(0.01, Math.min(0.99, result.probability || 0.5));
      db.prepare("INSERT INTO executions (slug, side, amount, executed_at, status, fill_price) VALUES (?, ?, ?, ?, 'paper', ?)").run(
        result.slug, clobSide, amount, Date.now(), entryPrice
      );
      console.log(`[autoExecute] PAPER trade: ${result.slug} ${clobSide} $${amount.toFixed(2)}`);
      const pnlRowP = db.prepare("SELECT COALESCE(SUM(pnl),0) as total FROM executions WHERE executed_at >= ?").get(todayTs) as { total: number };
      const tradeRowP = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayTs) as { cnt: number };
      const { sendSignalAlert } = await import("../alerts/telegramAlert");
      await sendSignalAlert({
        id: result.slug,
        slug: result.slug,
        question,
        recommendation: result.recommendation === "BET_YES" ? "BET YES" : "BET NO",
        sigma_confidence: isNaN(result.sigmaConfidence) ? 0 : result.sigmaConfidence,
        kelly_fraction: isNaN(result.kellyFraction) ? 0 : result.kellyFraction,
        kelly_amount: amount,
        oracle_prob: isNaN(result.probability) ? 0 : result.probability,
        market_price: isNaN(result.yesPrice ?? NaN) ? (isNaN(result.probability) ? 0 : result.probability) : result.yesPrice!,
        edge: isNaN(result.kellyFraction) ? 0 : result.kellyFraction,
        sigma_thesis: (result.pipelineResult as any)?.sigma?.thesis ?? `Scanner: ${result.recommendation} @ ${(result.probability * 100).toFixed(0)}%`,
        clause_risk_level: (result.pipelineResult as any)?.clause?.risk_level ?? "LOW",
        clause_summary: "",
        orderId: "PAPER-MODE",
        executionStatus: "paper",
        pnlToday: pnlRowP.total,
        tradesToday: tradeRowP.cnt,
      } as any);
      return;
    }

    // Pre-execution dedup: reject if this slug was already successfully traded today
    const alreadyTraded = db.prepare(
      "SELECT id FROM executions WHERE slug = ? AND executed_at >= ? AND status IN ('placed','paper')"
    ).get(result.slug, todayTs);
    if (alreadyTraded) {
      console.log(`[autoExecute] Slug ${result.slug} already traded today — skipping (dedup)`);
      return;
    }

    // Live balance guard: check on-chain USDC.e before every order
    // Prevents spending non-existent balance and burning gas on doomed orders
    if (!paperMode) {
      try {
        const balRes = await fetch("https://quantik-backend-production.up.railway.app/api/clob/balance", { signal: AbortSignal.timeout(5000) });
        if (balRes.ok) {
          const balData = await balRes.json() as any;
          const onChainBalance = parseFloat(balData?.data?.balance ?? "0");
          if (onChainBalance < amount + 2) { // require balance > bet + $2 buffer
            console.log(`[autoExecute] Insufficient on-chain balance $${onChainBalance.toFixed(2)} for $${amount.toFixed(2)} bet on ${result.slug} — pausing trading`);
            return;
          }
          console.log(`[autoExecute] Balance check: $${onChainBalance.toFixed(2)} on-chain — OK for $${amount.toFixed(2)} bet`);
        }
      } catch (e) {
        console.warn(`[autoExecute] Balance check failed — proceeding with caution:`, (e as Error).message);
      }
    }

    // Live execution via polymarket CLI — market orders (FOK, fills immediately at best ask)
    const { runCli } = await import("../cli");
    // For BET_YES: buy YES token; for BET_NO: buy NO token (clobTokenIds[1])
    const isBetYes = result.recommendation === "BET_YES";
    const yesTokenId = result.tokenId || result.slug;
    const noTokenId = result.noTokenId || "";
    const clobTokenId = isBetYes ? yesTokenId : (noTokenId || yesTokenId);
    // market-order: --amount is USDC for buys (no --price or --size needed)
    try {
      const cliArgs = ["clob", "market-order",
        "--token", clobTokenId,
        "--side", clobSide,
        "--amount", amount.toFixed(2),
        "--signature-type", process.env.POLYMARKET_SIGNATURE_TYPE ?? "eoa"
      ];
      const output = await runCli(cliArgs) as Record<string, unknown>;
      const orderId = String((output as any)?.id ?? (output as any)?.order_id ?? "unknown");

      // Store the ACTUAL token price as fill_price (not oracle prob)
      // For BET_NO: fill_price = NO token price = 1 - yesPrice
      // For BET_YES: fill_price = YES token price = yesPrice
      const yesMarketPrice = result.yesPrice ?? result.probability ?? 0.5;
      const actualFillPrice = isBetYes
        ? Math.max(0.01, Math.min(0.99, yesMarketPrice))       // YES token price
        : Math.max(0.01, Math.min(0.99, 1 - yesMarketPrice));  // NO token price
      db.prepare("INSERT INTO executions (slug, side, amount, executed_at, status, order_id, fill_price) VALUES (?, ?, ?, ?, 'placed', ?, ?)").run(
        result.slug, clobSide, amount, Date.now(), orderId, actualFillPrice
      );
      console.log(`[autoExecute] LIVE trade placed: ${result.slug} ${clobSide} $${amount.toFixed(2)} orderId=${orderId}`);

      const pnlRow2 = db.prepare("SELECT COALESCE(SUM(pnl),0) as total FROM executions WHERE executed_at >= ?").get(todayTs) as { total: number };
      const tradeRow2 = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayTs) as { cnt: number };

      const { sendSignalAlert } = await import("../alerts/telegramAlert");
      await sendSignalAlert({
        id: result.slug,
        slug: result.slug,
        question,
        recommendation: result.recommendation === "BET_YES" ? "BET YES" : "BET NO",
        sigma_confidence: isNaN(result.sigmaConfidence) ? 0 : result.sigmaConfidence,
        kelly_fraction: isNaN(result.kellyFraction) ? 0 : result.kellyFraction,
        kelly_amount: amount,
        oracle_prob: isNaN(result.probability) ? 0 : result.probability,
        market_price: isNaN(result.yesPrice ?? NaN) ? (isNaN(result.probability) ? 0 : result.probability) : result.yesPrice!,
        edge: isNaN(result.kellyFraction) ? 0 : result.kellyFraction,
        sigma_thesis: (result.pipelineResult as any)?.sigma?.thesis ?? `Scanner: ${result.recommendation} @ ${(result.probability * 100).toFixed(0)}%`,
        clause_risk_level: (result.pipelineResult as any)?.clause?.risk_level ?? "LOW",
        clause_summary: "",
        orderId,
        executionStatus: "placed",
        pnlToday: pnlRow2.total,
        tradesToday: tradeRow2.cnt,
      } as any);
    } catch (err) {
      db.prepare("INSERT INTO executions (slug, side, amount, executed_at, status) VALUES (?, ?, ?, ?, 'failed')").run(
        result.slug, clobSide, amount, Date.now()
      );
      console.error(`[autoExecute] LIVE trade FAILED for ${result.slug}:`, err);
      // Still send FYI alert so Carlos knows a signal fired (even though execution failed)
      try {
        const { sendSignalAlert } = await import("../alerts/telegramAlert");
        await sendSignalAlert({
          id: result.slug,
          slug: result.slug,
          question,
          recommendation: result.recommendation === "BET_YES" ? "BET YES" : "BET NO",
          sigma_confidence: isNaN(result.sigmaConfidence) ? 0 : result.sigmaConfidence,
          kelly_fraction: isNaN(result.kellyFraction) ? 0 : result.kellyFraction,
          kelly_amount: amount,
          oracle_prob: isNaN(result.probability) ? 0 : result.probability,
          market_price: isNaN(result.probability) ? 0 : result.probability,
          edge: isNaN(result.kellyFraction) ? 0 : result.kellyFraction,
          sigma_thesis: (result.pipelineResult as any)?.sigma?.thesis ?? `Scanner: ${result.recommendation} @ ${(result.probability * 100).toFixed(0)}%`,
          clause_risk_level: (result.pipelineResult as any)?.clause?.risk_level ?? "LOW",
          clause_summary: "",
          orderId: "FAILED",
          executionStatus: "failed",
          pnlToday: pnlRow.total,
          tradesToday: tradesRow.cnt,
        } as any);
      } catch {}
    }
  }
}

// ── Status accessors ───────────────────────────────────────────

export function getScannerStatus() {
  return {
    running: scannerRunning,
    lastScan: lastScanAt,
    scannedToday,
    alertsTriggered,
  };
}
