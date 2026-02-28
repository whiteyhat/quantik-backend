import { execFile } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";

// ── Types ──────────────────────────────────────────────────────

export interface Market {
  slug: string;
  question: string;
  volume: number;
  liquidity: number;
  endDate: string;
  yesPrice: number;
}

export interface ScanResult {
  slug: string;
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
const AGENT_CACHE_TTL = 15 * 60 * 1000;
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

async function runRealPipeline(slug: string, yesPrice: number): Promise<{
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

  // Oracle and Sigma agents need prior pipeline runs — they read from DB, not compute on-demand.
  // We use the Gamma market price (yesPrice) as our oracle estimate directly.
  // Edge and Clause DO compute on-demand and are called here.
  const [edgeRes, clauseRes] = await Promise.allSettled([
    fetchWithTimeout(`${BACKEND_URL}/api/edge/${slug}`),
    fetchWithTimeout(`${BACKEND_URL}/api/clause/${slug}`),
  ]);

  // Oracle: use Gamma yesPrice + a slight Bayesian adjustment as true prob estimate
  // Conservative: treat market price as unbiased until we have agent data
  const trueProbEstimate = yesPrice;
  const oracle = { confidence: Math.abs(yesPrice - 0.5) > 0.05 ? 0.60 : 0.45, estimated_true_prob: trueProbEstimate };

  // Normalize Edge — returns fractional_kelly, position_size, direction
  const rawEdge = (edgeRes.status === "fulfilled" && edgeRes.value) ? edgeRes.value as any : null;
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

  // Synthesize Sigma from market price + Edge Kelly + Clause veto
  // Signal fires when: Edge Kelly ≥ 5%, price is off-centre (edge exists), Clause not vetoed
  const kellyFrac = edgeData.fractional_kelly;
  const hasEdge = kellyFrac >= 0.05 && Math.abs(yesPrice - 0.5) > 0.05;
  const sigmaDecision = clauseData.veto ? "VETO" : hasEdge ? `BET_${edgeData.direction}` : "SKIP";
  const sigmaConfidence = clauseData.veto ? 0 : hasEdge ? Math.min(0.65 + kellyFrac * 2, 0.90) : 0;
  const sigmaData = {
    confidence: sigmaConfidence,
    decision: sigmaDecision,
    thesis: `Market price ${Math.round(yesPrice * 100)}%. Edge=${edgeData.direction} Kelly=${(kellyFrac * 100).toFixed(1)}%. ${clauseData.veto ? "VETOED by Clause." : ""}`,
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
  // Simulated pipeline (mirrors runSigma / runEdge in pipeline.ts)
  // In production this would call full agent pipeline
  const estimatedTrueProb = Math.min(0.95, Math.max(0.05, yesPrice + (Math.random() * 0.1 - 0.05)));
  const edge = estimatedTrueProb - yesPrice;
  const kellyFraction = Math.max(0, edge / (1 - yesPrice));
  const adjustedConf = Math.min(1, Math.max(0, estimatedTrueProb - 0.02));
  const decision =
    adjustedConf > 0.6 ? "BET_YES" : adjustedConf < 0.4 ? "BET_NO" : "SKIP";

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
      const markets = await this.fetchTopMarkets(50);
      console.log(`[Scanner] Fetched ${markets.length} candidate markets`);

      // Process in batches of 3 to avoid memory spikes
      const filtered: Market[] = [];
      for (const m of markets) {
        if (await this.shouldSkip(m.slug)) continue;
        filtered.push(m);
      }

      console.log(`[Scanner] ${filtered.length} markets to scan after dedup`);

      for (let i = 0; i < filtered.length; i += 3) {
        const batch = filtered.slice(i, i + 3);
        await Promise.all(
          batch.map(async (m) => {
            try {
              const result = await this.runPipelineForMarket(m.slug, m.yesPrice);
              await this.storeScanResult(result, m.question);
              scannedToday++;

              if (result.shouldAlert) {
                alertsTriggered++;
                console.log(`[Scanner] ALERT triggered for ${m.slug}: σ=${result.sigmaConfidence.toFixed(2)} Kelly=${result.kellyFraction.toFixed(2)}`);
                // AUTO-EXECUTE — no human approval needed
                await this.autoExecute(result, m.question).catch(e =>
                  console.error(`[Scanner] autoExecute failed for ${m.slug}:`, e)
                );
              }
            } catch (err) {
              console.error(`[Scanner] Pipeline error for ${m.slug}:`, err);
            }
          })
        );
        // Small delay between batches
        if (i + 3 < filtered.length) await sleep(500);
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
    const res = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200&order=volume24hr&ascending=false`);
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
        if (closeTime - now > 96 * 60 * 60 * 1000) continue; // too far out
      }

      // 2. Volume > $30k
      if (volume < 30000) continue;

      // 3. Price between 0.18 and 0.82
      if (yesPrice < 0.18 || yesPrice > 0.82) continue;

      markets.push({
        slug,
        question: (m["question"] as string) || slug,
        volume,
        liquidity,
        endDate,
        yesPrice,
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

    return scored.slice(0, Math.min(limit, 20)).map(s => s.market);
  }

  async shouldSkip(slug: string): Promise<boolean> {
    const db = getDb();
    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    const row = db
      .prepare<[string, number], { scanned_at: number }>(
        "SELECT scanned_at FROM scanner_results WHERE slug = ? AND scanned_at >= ? ORDER BY scanned_at DESC LIMIT 1"
      )
      .get(slug, fifteenMinAgo);
    return !!row;
  }

  async runPipelineForMarket(slug: string, yesPrice: number = 0.5): Promise<ScanResult> {
    let sigma: { confidence: number; decision: string; thesis?: string };
    let edge: { kelly_fraction: number; estimated_true_prob: number; kelly_amount?: number };
    let pipelineResult: object;
    let clause: { veto?: boolean; risk_level?: string; summary?: string } | undefined;

    try {
      const real = await runRealPipeline(slug, yesPrice);
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

    const shouldAlert =
      sigma.confidence >= 0.50 &&
      edge.kelly_fraction >= 0.05 &&
      recommendation !== "SKIP" &&
      recommendation !== "VETO";

    return {
      slug,
      scannedAt: Date.now(),
      sigmaConfidence: sigma.confidence,
      kellyFraction: edge.kelly_fraction,
      recommendation: recommendation as ScanResult["recommendation"],
      probability: edge.estimated_true_prob,
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
    const paperMode = process.env.PAPER_TRADING === "true";
    const maxBet = parseFloat(process.env.MAX_BET_USDC ?? "10");
    const maxPerDay = parseInt(process.env.MAX_TRADES_PER_DAY ?? "5", 10);
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
      const sixHAgo = Date.now() - 6 * 60 * 60 * 1000;
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
      console.log(`[autoExecute] Rate limit: already traded ${result.slug} in last 6h`);
      return;
    }

    const side = result.recommendation === "BET_YES" ? "YES" : "NO";
    const amount = Math.min(result.kellyFraction * 100, maxBet);

    if (paperMode) {
      // Paper mode — log only
      db.prepare("INSERT INTO executions (slug, side, amount, executed_at, status) VALUES (?, ?, ?, ?, 'paper')").run(
        result.slug, side, amount, Date.now()
      );
      console.log(`[autoExecute] PAPER trade: ${result.slug} ${side} $${amount.toFixed(2)}`);
      const pnlRowP = db.prepare("SELECT COALESCE(SUM(pnl),0) as total FROM executions WHERE executed_at >= ?").get(todayTs) as { total: number };
      const tradeRowP = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayTs) as { cnt: number };
      const { sendSignalAlert } = await import("../alerts/telegramAlert");
      await sendSignalAlert({ ...result, question, orderId: "PAPER-MODE", executionStatus: "paper", pnlToday: pnlRowP.total, tradesToday: tradeRowP.cnt } as any);
      return;
    }

    // Live execution via polymarket CLI
    const { runCli } = await import("../cli");
    try {
      const cliArgs = ["clob", "create-order",
        "--token-id", result.slug,
        "--side", side,
        "--price", result.probability.toFixed(4),
        "--size", amount.toFixed(2),
        "--signature-type", process.env.POLYMARKET_SIGNATURE_TYPE ?? "eoa"
      ];
      const output = await runCli(cliArgs) as Record<string, unknown>;
      const orderId = String((output as any)?.id ?? (output as any)?.order_id ?? "unknown");

      db.prepare("INSERT INTO executions (slug, side, amount, executed_at, status, order_id) VALUES (?, ?, ?, ?, 'placed', ?)").run(
        result.slug, side, amount, Date.now(), orderId
      );
      console.log(`[autoExecute] LIVE trade placed: ${result.slug} ${side} $${amount.toFixed(2)} orderId=${orderId}`);

      const pnlRow2 = db.prepare("SELECT COALESCE(SUM(pnl),0) as total FROM executions WHERE executed_at >= ?").get(todayTs) as { total: number };
      const tradeRow2 = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayTs) as { cnt: number };

      const { sendSignalAlert } = await import("../alerts/telegramAlert");
      await sendSignalAlert({ ...result, question, orderId, executionStatus: "placed", pnlToday: pnlRow2.total, tradesToday: tradeRow2.cnt } as any);
    } catch (err) {
      db.prepare("INSERT INTO executions (slug, side, amount, executed_at, status) VALUES (?, ?, ?, ?, 'failed')").run(
        result.slug, side, amount, Date.now()
      );
      console.error(`[autoExecute] LIVE trade FAILED for ${result.slug}:`, err);
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
