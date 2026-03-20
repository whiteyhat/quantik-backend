import { runOracle } from "../oracle/index";
import { runEdge } from "../edge/index";
import { runClause } from "../clause/index";
import { runAura } from "../aura/index";
import { runFlux } from "../flux/index";
import { getDb } from "../db/schema";
import { isPanicModeEnabled } from "../risk/state";
import { loadAutopilotExecutionContexts, type AutopilotExecutionContext } from "../utils/linkedAgent";
import { getWalletFundingSnapshot } from "../utils/balances";
import { emitAgentAlert, emitAutopilotStatus } from "../infra/socket";
import { loadAgentWalletContext } from "../utils/agentKey";
import { executeManagedTrade, type ManagedTradeDirection } from "../services/tradeExecution";
import { getAutopilotPolicyEnvelope, insertAutopilotDecision } from "../services/autopilotPolicy";
import { GAMMA_API_BASE, fetchWithRetry } from "../utils/market-fetch";

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
  endDate?: string;
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
  oracle: { confidence: number; estimated_true_prob?: number; market_implied?: number };
  flux?: Record<string, unknown>;
  edge?: Record<string, unknown>;
  edge_agent: { fractional_kelly: number; position_size: number; direction: string; kelly_recommended?: number };
  sigma: { confidence: number; decision: string; thesis: string };
  clause: { riskLevel: string; resolutionCriteria: string; veto: boolean; urgent: boolean; ambiguityScore?: number };
  aura?: { sentimentDelta: number; confidence: number; dataSufficiency: number };
  lucifer?: Record<string, unknown>;
}
const agentCache = new Map<string, { ts: number; data: AgentBundle }>();
const AGENT_CACHE_TTL = 8 * 60 * 1000;
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const DEFAULT_AUTOPILOT_MIN_TRADE_USDC = 1;

function getAutopilotMinTradeUsdc(): number {
  const parsed = Number(process.env.AUTOPILOT_MIN_TRADE_USDC ?? DEFAULT_AUTOPILOT_MIN_TRADE_USDC);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTOPILOT_MIN_TRADE_USDC;
}

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

function buildScannerLuciferPayload(
  slug: string,
  clauseData: { veto: boolean; riskLevel: string; ambiguityScore?: number },
  edgeData: { fractional_kelly: number; position_size: number; direction: string; kelly_recommended?: number },
  auraData: { sentimentDelta: number; confidence: number; dataSufficiency: number }
): Record<string, unknown> {
  const ambiguityScore = Number(clauseData.ambiguityScore ?? 0.4);
  const veto = clauseData.veto;
  const sentimentDelta = Number(auraData.sentimentDelta ?? 0);
  const kellyFraction = Number(edgeData.fractional_kelly ?? edgeData.kelly_recommended ?? 0);
  const biasFlags: string[] = [];

  if (ambiguityScore > 0.5) biasFlags.push(`Resolution ambiguity remains elevated at ${ambiguityScore.toFixed(2)}`);
  if (kellyFraction > 0.3) biasFlags.push("Position sizing looks aggressive for a scanner-derived signal");
  if (Math.abs(sentimentDelta) > 0.1) biasFlags.push("Sentiment moved sharply, so crowd chasing is a real risk");
  if (clauseData.riskLevel === "HIGH") biasFlags.push("Clause marked this market as high-risk for dispute");
  if (biasFlags.length === 0) biasFlags.push("No dominant adversarial flag, but the edge still needs confirmation");

  const adversarialScore = Math.min(
    0.9,
    0.25 + ambiguityScore * 0.4 + (veto ? 0.3 : 0) + (Math.abs(sentimentDelta) > 0.2 ? 0.05 : 0)
  );

  return {
    devils_advocate_score: Number(adversarialScore.toFixed(2)),
    bias_flags: biasFlags,
    counter_thesis: veto
      ? "Resolution risk dominates the setup, so the directional edge is not trustworthy."
      : ambiguityScore > 0.5
        ? "Even a correct directional call can still lose if settlement turns subjective."
        : "The edge is modest enough that a fast repricing or noisy sentiment reversal could erase it.",
    worst_case: veto
      ? "Full loss with contract dispute risk"
      : "Full loss if the edge is noise and the market reprices quickly",
    adjusted_confidence: Number((veto ? -0.2 : ambiguityScore > 0.6 ? -0.1 : -0.03).toFixed(3)),
    pass: !veto && ambiguityScore < 0.7,
    slug,
    riskLevel: clauseData.riskLevel,
    ambiguityScore,
  };
}

async function runRealPipeline(slug: string, yesPrice: number, question: string = slug, tokenId: string = ""): Promise<{
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
  const [oracleRes, clauseRes, auraRes, fluxRes] = await Promise.allSettled([
    runOracle({ slug, question, yesPrice, tokenId: '' }),
    runClause({ slug, question, description: question, days_to_resolution: 7 }),
    runAura({ slug, question }),
    runFlux({ slug, token_id: tokenId }),
  ]);

  // Extract Oracle result
  const rawOracle = (oracleRes.status === "fulfilled" && oracleRes.value) ? oracleRes.value as any : null;
  const trueProbEstimate = rawOracle?.calibrated_prob ?? rawOracle?.p_yes ?? yesPrice;
  const oracleConf = rawOracle?.confidence ?? (Math.abs(yesPrice - 0.5) > 0.05 ? 0.55 : 0.40);
  const oracle = { confidence: oracleConf, estimated_true_prob: trueProbEstimate, market_implied: yesPrice };
  // Extract Aura sentiment delta (positive = bullish, negative = bearish)
  const rawAura = (auraRes.status === "fulfilled" && auraRes.value) ? auraRes.value as any : null;
  const sentimentDelta = rawAura?.sentimentDelta ?? rawAura?.sentiment_score ?? 0;
  const auraConfidence = rawAura?.confidence ?? 0;
  const auraDataSufficiency = rawAura?.dataSufficiency ?? 0;
  const rawFlux = (fluxRes.status === "fulfilled" && fluxRes.value)
    ? fluxRes.value as unknown as Record<string, unknown>
    : null;

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
  const edgePayload = rawEdge ?? {
    fractional_kelly: edgeData.fractional_kelly,
    position_size: edgeData.position_size,
    direction: edgeData.direction,
    kelly_recommended: edgeData.kelly_recommended,
    estimated_true_prob: trueProbEstimate,
    market_price: yesPrice,
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
  const luciferData = buildScannerLuciferPayload(
    slug,
    clauseData,
    edgeData,
    {
      sentimentDelta,
      confidence: auraConfidence,
      dataSufficiency: auraDataSufficiency,
    }
  );

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

  const bundle: AgentBundle = {
    oracle,
    ...(rawFlux ? { flux: rawFlux } : {}),
    edge: edgePayload,
    edge_agent: edgeData,
    sigma: sigmaData,
    clause: clauseData,
    aura: {
      sentimentDelta,
      confidence: auraConfidence,
      dataSufficiency: auraDataSufficiency,
    },
    lucifer: luciferData,
  };
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

function getUtcDayStart(ts = Date.now()): number {
  const day = new Date(ts);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime();
}

function toManagedDirection(recommendation: ScanResult["recommendation"]): ManagedTradeDirection | null {
  if (recommendation === "BET_YES") return "YES";
  if (recommendation === "BET_NO") return "NO";
  return null;
}

function getExecutionSignalMetrics(
  result: ScanResult,
  useAuraSentiment: boolean
): { direction: ManagedTradeDirection | null; sigmaConfidence: number } {
  const pipeline = result.pipelineResult as AgentBundle | undefined;
  const auraDelta = pipeline?.aura?.sentimentDelta ?? 0;
  const edgeDirection = pipeline?.edge_agent?.direction === "NO" ? "NO" : "YES";
  const recommendationDirection = toManagedDirection(result.recommendation);
  const direction = useAuraSentiment ? recommendationDirection : edgeDirection;
  const sigmaConfidence = useAuraSentiment
    ? result.sigmaConfidence
    : Math.max(0, result.sigmaConfidence - Math.abs(auraDelta) * 0.15);
  return { direction, sigmaConfidence };
}

function computeTradeSizeUsdc(
  availableUsdc: number,
  kellyFraction: number,
  maxBetUsdc: number,
  maxPositionFraction: number,
  kellyMultiplier: number
): number {
  if (!Number.isFinite(availableUsdc) || availableUsdc <= 0) return 0;
  if (!Number.isFinite(kellyFraction) || kellyFraction <= 0) return 0;
  const rawSize = availableUsdc * kellyFraction * kellyMultiplier;
  const maxAllowed = Math.min(maxBetUsdc, availableUsdc * maxPositionFraction, availableUsdc);
  if (!Number.isFinite(maxAllowed) || maxAllowed <= 0) return 0;
  const minTradeUsdc = Math.min(getAutopilotMinTradeUsdc(), maxAllowed);
  return Math.round(Math.min(maxAllowed, Math.max(rawSize, minTradeUsdc)) * 100) / 100;
}

function buildSignalSnapshot(result: ScanResult, question: string, sigmaConfidence: number, direction: ManagedTradeDirection | null) {
  return {
    slug: result.slug,
    question,
    recommendation: result.recommendation,
    direction,
    sigmaConfidence,
    kellyFraction: result.kellyFraction,
    probability: result.probability,
    yesPrice: result.yesPrice ?? null,
    tokenId: result.tokenId ?? null,
    noTokenId: result.noTokenId ?? null,
    pipelineResult: result.pipelineResult,
  };
}

async function logAutopilotDecision(
  executionContext: AutopilotExecutionContext,
  result: ScanResult,
  direction: ManagedTradeDirection,
  question: string,
  reasonCode: string,
  decision: "executed" | "skipped" | "failed",
  policySnapshot: Awaited<ReturnType<typeof getAutopilotPolicyEnvelope>>,
  signalSigma: number,
  sizeUsdc: number | null,
  error?: string | null
): Promise<void> {
  await insertAutopilotDecision({
    agentId: executionContext.agentId,
    userId: executionContext.userId,
    slug: result.slug,
    direction,
    decision,
    reasonCode,
    sizeUsdc,
    scannedAt: result.scannedAt,
    policySnapshot,
    signalSnapshot: buildSignalSnapshot(result, question, signalSigma, direction),
    error,
  });
}

// ── Scanner class ──────────────────────────────────────────────

export class MarketScanner {
  async scan(): Promise<void> {
    // GLOBAL KILL SWITCH: Respect panic_mode and circuit breaker
    if (await isPanicModeEnabled()) {
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
              result.endDate = m.endDate || undefined;
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
      emitAutopilotStatus({
        isRunning: false,
        lastScan: new Date().toISOString(),
        tradesToday: alertsTriggered,
        circuitBreakerTriggered: false,
        timestamp: Date.now(),
      });
    }
  }

  async fetchTopMarkets(limit: number): Promise<Market[]> {
    let rawMarkets: unknown[];

    // Always use Gamma API (polymarket-cli returns oldest markets by ID, not active ones)
    console.log("[Scanner] Fetching from Gamma API...");
    // Sort by liquidity to favour political/geopolitical markets over daily sports
    const res = await fetchWithRetry(`${GAMMA_API_BASE}/markets?closed=false&active=true&limit=200&order=liquidity&ascending=false`, { signal: AbortSignal.timeout(15000) });
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
      const real = await runRealPipeline(slug, yesPrice, question, tokenId);
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
      const auraData = (pr["aura"] ?? null) as Record<string, unknown> | null;
      const fluxData = (pr["flux"] ?? null) as Record<string, unknown> | null;
      const oracleData = (pr["oracle"] ?? null) as Record<string, unknown> | null;
      const edgeData = ((pr["edge"] ?? pr["edge_agent"]) ?? {}) as Record<string, unknown>;
      const sigmaData = (pr["sigma"] ?? {}) as Record<string, unknown>;
      const clauseData = (pr["clause"] ?? null) as Record<string, unknown> | null;
      const luciferData = (pr["lucifer"] ?? null) as Record<string, unknown> | null;
      const runId = `scanner-${result.slug}-${result.scannedAt}`;

      // Only insert if not already present
      const existing = db.prepare("SELECT id FROM pipeline_runs WHERE id = ?").get(runId);
      if (!existing) {
        db.prepare(`
          INSERT INTO pipeline_runs
            (id, market_slug, market_question, created_at, completed_at, decision, confidence,
             aura_output, flux_output, oracle_output, edge_output, sigma_output, clause_output, lucifer_output,
             alert_sent, signal_state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'TRADE')
        `).run(
          runId,
          result.slug,
          question ?? result.slug,
          result.scannedAt,
          result.scannedAt,
          result.recommendation,
          result.sigmaConfidence,
          auraData ? JSON.stringify(auraData) : null,
          fluxData ? JSON.stringify(fluxData) : null,
          oracleData ? JSON.stringify(oracleData) : null,
          JSON.stringify(Object.keys(edgeData).length > 0 ? edgeData : {
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
          clauseData ? JSON.stringify(clauseData) : null,
          luciferData ? JSON.stringify(luciferData) : null,
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
    const executionContexts = await loadAutopilotExecutionContexts();

    if (executionContexts.length === 0) {
      console.log(`[autoExecute] No active autopilot execution contexts resolved for ${result.slug}`);
      return;
    }

    for (const executionContext of executionContexts) {
      const policy = await getAutopilotPolicyEnvelope({
        agentId: executionContext.agentId,
        personality: executionContext.personality,
        decision_style: executionContext.decisionStyle,
        trading_instinct: executionContext.tradingInstinct,
        time_patience: executionContext.timePatience,
        money_approach: executionContext.moneyApproach,
        protection_mindset: executionContext.protectionMindset,
        market_sense: executionContext.marketSense,
      });
      const signalMetrics = getExecutionSignalMetrics(result, policy.effective.useAuraSentiment);
      const direction = signalMetrics.direction;

      if (!direction) {
        continue;
      }

      if (!executionContext.walletAddress) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "wallet",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null,
          "No wallet is assigned to this agent."
        );
        continue;
      }

      emitAgentAlert(executionContext.userId, {
        type: "signal",
        title: `${result.recommendation}: ${question.slice(0, 60)}`,
        message: `Confidence ${(signalMetrics.sigmaConfidence * 100).toFixed(0)}% · Kelly ${(result.kellyFraction * 100).toFixed(1)}%`,
        slug: result.slug,
        confidence: signalMetrics.sigmaConfidence,
        timestamp: Date.now(),
      });

      const walletContext = await loadAgentWalletContext(executionContext.agentId).catch(() => null);
      const funding = await getWalletFundingSnapshot(executionContext.walletAddress, walletContext?.privateKey);
      if (!funding.ready) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "funding",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null,
          funding.fundingMessage
        );
        console.log(`[autoExecute] Funding check blocked ${result.slug} for ${executionContext.agentId}: ${funding.fundingMessage}`);
        continue;
      }

      if (!executionContext.polymarketReady) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "polymarket_prep",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null,
          "Polymarket approvals are incomplete for this agent."
        );
        continue;
      }

      const todayTs = getUtcDayStart();
      const now = Date.now();
      const cadenceSince = now - policy.effective.cadenceMinutes * 60_000;
      const cooldownSince = now - policy.effective.cooldownMinutes * 60_000;

      const latestTrade = db.prepare(
        "SELECT executed_at FROM executions WHERE agent_id = ? AND source = 'autopilot' AND status IN ('placed', 'paper') ORDER BY executed_at DESC LIMIT 1"
      ).get(executionContext.agentId) as { executed_at: number } | undefined;
      if (latestTrade && latestTrade.executed_at >= cadenceSince) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "cadence",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null
        );
        continue;
      }

      const tradesRow = db.prepare(
        "SELECT COUNT(*) as cnt FROM executions WHERE agent_id = ? AND source = 'autopilot' AND executed_at >= ? AND status IN ('placed', 'paper')"
      ).get(executionContext.agentId, todayTs) as { cnt: number };
      if (tradesRow.cnt >= policy.effective.maxTradesPerDay) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "daily_cap",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null
        );
        continue;
      }

      const pnlRow = db.prepare(
        "SELECT COALESCE(SUM(COALESCE(pnl, 0)), 0) as total FROM executions WHERE agent_id = ? AND executed_at >= ?"
      ).get(executionContext.agentId, todayTs) as { total: number };
      const availableUsdc = funding.clobBalance > 0 ? funding.clobBalance : funding.onChainUsdc;
      const dailyLossThreshold = availableUsdc * policy.effective.dailyLossLimitPct;
      if (dailyLossThreshold > 0 && pnlRow.total <= -dailyLossThreshold) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "loss_cap",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null
        );
        continue;
      }

      const slugRecent = db.prepare(
        "SELECT executed_at FROM executions WHERE agent_id = ? AND source = 'autopilot' AND slug = ? AND status IN ('placed', 'paper') ORDER BY executed_at DESC LIMIT 1"
      ).get(executionContext.agentId, result.slug) as { executed_at: number } | undefined;
      if (slugRecent && slugRecent.executed_at >= cooldownSince) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "cooldown",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null
        );
        continue;
      }

      if (signalMetrics.sigmaConfidence < policy.effective.minSigma) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "min_sigma",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null
        );
        continue;
      }

      if (result.kellyFraction < policy.effective.minKelly) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "min_kelly",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          null
        );
        continue;
      }

      const amount = computeTradeSizeUsdc(
        availableUsdc,
        result.kellyFraction,
        policy.effective.maxBetUsdc,
        policy.effective.maxPositionFraction,
        policy.effective.kellyMultiplier
      );
      if (!Number.isFinite(amount) || amount < getAutopilotMinTradeUsdc() || availableUsdc < amount) {
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "balance",
          "skipped",
          policy,
          signalMetrics.sigmaConfidence,
          amount > 0 ? amount : null
        );
        continue;
      }

      const fluxTokenId = direction === "NO" ? (result.noTokenId || result.tokenId || "") : (result.tokenId || "");
      try {
        const fluxUrl = fluxTokenId
          ? `${BACKEND_URL}/api/flux/${result.slug}?tokenId=${encodeURIComponent(fluxTokenId)}`
          : `${BACKEND_URL}/api/flux/${result.slug}`;
        const fluxCheck = await fetch(fluxUrl, { signal: AbortSignal.timeout(8000) });
        if (fluxCheck.ok) {
          const fluxData = await fluxCheck.json() as Record<string, unknown>;
          if (fluxData.soft_veto === true) {
            await logAutopilotDecision(
              executionContext,
              result,
              direction,
              question,
              "liquidity",
              "skipped",
              policy,
              signalMetrics.sigmaConfidence,
              amount
            );
            continue;
          }
        }
      } catch (err) {
        console.warn(`[autoExecute] Flux check failed for ${result.slug}:`, err instanceof Error ? err.message : err);
      }

      // Mark alert_sent = 1 BEFORE executing so the AlertPoller doesn't send a
      // premature alert without execution metadata — we send our own alert below
      // with the real orderId and status.
      const runId = `scanner-${result.slug}-${result.scannedAt}`;
      db.prepare("UPDATE pipeline_runs SET alert_sent = 1 WHERE id = ?").run(runId);

      try {
        const tradeResult = await executeManagedTrade({
          userId: executionContext.userId,
          agentId: executionContext.agentId,
          marketSlug: result.slug,
          direction,
          source: "autopilot",
          sizeUsdc: amount,
          requestedTokenId: direction === "NO" ? (result.noTokenId ?? result.tokenId ?? null) : (result.tokenId ?? null),
          quotedPrice: direction === "YES"
            ? (result.yesPrice ?? result.probability ?? null)
            : (result.yesPrice == null && result.probability == null ? null : 1 - (result.yesPrice ?? result.probability ?? 0.5)),
          netEv: result.kellyFraction * result.probability,
          evGrade: signalMetrics.sigmaConfidence >= 0.7 ? "A" : signalMetrics.sigmaConfidence >= 0.5 ? "B" : "C",
          walletPrivateKey: walletContext?.privateKey ?? null,
          emitUserId: executionContext.userId,
        });

        if (!tradeResult.ok) {
          await logAutopilotDecision(
            executionContext,
            result,
            direction,
            question,
            tradeResult.error ? "cli_error" : "balance",
            "failed",
            policy,
            signalMetrics.sigmaConfidence,
            amount,
            tradeResult.error ?? null
          );
          continue;
        }

        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "executed",
          "executed",
          policy,
          signalMetrics.sigmaConfidence,
          amount
        );

        // Only send Telegram alert for successfully executed trades
        const { sendSignalAlert } = await import("../alerts/telegramAlert");
        await sendSignalAlert({
          id: result.slug,
          slug: result.slug,
          question,
          recommendation: direction === "YES" ? "BET YES" : "BET NO",
          sigma_confidence: signalMetrics.sigmaConfidence,
          kelly_fraction: result.kellyFraction,
          kelly_amount: amount,
          oracle_prob: result.probability,
          market_price: result.yesPrice ?? result.probability,
          edge: result.kellyFraction,
          sigma_thesis: (result.pipelineResult as any)?.sigma?.thesis ?? `Scanner: ${result.recommendation}`,
          clause_risk_level: (result.pipelineResult as any)?.clause?.riskLevel ?? (result.pipelineResult as any)?.clause?.risk_level ?? "LOW",
          clause_summary: "",
          orderId: tradeResult.orderId ?? (tradeResult.paper ? "PAPER-MODE" : undefined),
          executionStatus: tradeResult.status,
          pnlToday: pnlRow.total,
          tradesToday: tradesRow.cnt + 1,
        } as any);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await logAutopilotDecision(
          executionContext,
          result,
          direction,
          question,
          "cli_error",
          "failed",
          policy,
          signalMetrics.sigmaConfidence,
          amount,
          errorMessage
        );
        console.error(`[autoExecute] LIVE trade FAILED for ${result.slug} on ${executionContext.agentId}:`, err);
      }
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
