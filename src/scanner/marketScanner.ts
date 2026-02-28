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
}

// ── State ──────────────────────────────────────────────────────

let scannerRunning = false;
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
      // 1. Not already closed
      if (endDate) {
        const closeTime = new Date(endDate).getTime();
        if (closeTime < now) continue; // already closed
      }

      // 2. Volume > $5k (lowered to surface more candidates)
      if (volume < 5000) continue;

      // 3. Price between 0.10 and 0.90 (avoid near-certain only)
      if (yesPrice < 0.10 || yesPrice > 0.90) continue;

      markets.push({
        slug,
        question: (m["question"] as string) || slug,
        volume,
        liquidity,
        endDate,
        yesPrice,
      });
    }

    // Sort: closing soonest first (highest urgency)
    markets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

    return markets.slice(0, limit);
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
    const { sigma, edge, pipelineResult } = buildPipelineResult(slug, yesPrice);

    const recommendation = sigma.decision === "BET_YES"
      ? "BET_YES"
      : sigma.decision === "BET_NO"
        ? "BET_NO"
        : "SKIP";

    const shouldAlert =
      sigma.confidence >= 0.50 &&
      edge.kelly_fraction >= 0.05 &&
      recommendation !== "SKIP";

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
      INSERT OR IGNORE INTO scanner_results
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

    // Circuit breaker: daily trade count
    const today = new Date(); today.setHours(0,0,0,0);
    const todayTs = today.getTime();
    const tradesRow = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayTs) as { cnt: number };
    if (tradesRow.cnt >= maxPerDay) {
      console.log(`[autoExecute] MAX_TRADES_PER_DAY (${maxPerDay}) reached — skipping ${result.slug}`);
      return;
    }

    // Circuit breaker: daily P&L loss limit
    const pnlRow = db.prepare("SELECT COALESCE(SUM(pnl),0) as total FROM executions WHERE executed_at >= ?").get(todayTs) as { total: number };
    if (pnlRow.total <= -dailyLossLimit) {
      console.log(`[autoExecute] DAILY_LOSS_LIMIT hit ($${pnlRow.total.toFixed(2)}) — pausing`);
      return;
    }

    // Circuit breaker: rate limit 1 trade per slug per 6h
    const sixHAgo = Date.now() - 6 * 60 * 60 * 1000;
    const recent = db.prepare("SELECT id FROM executions WHERE slug = ? AND executed_at >= ?").get(result.slug, sixHAgo);
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
      const { sendSignalAlert } = await import("../alerts/telegramAlert");
      await sendSignalAlert({ ...result, question } as any);
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
      const output = await runCli(cliArgs, { timeout: 15000 });
      const orderId = (output.match(/order[_-]?id[:\s]+([a-f0-9-]+)/i) ?? [])[1] ?? "unknown";

      db.prepare("INSERT INTO executions (slug, side, amount, executed_at, status, order_id) VALUES (?, ?, ?, ?, 'placed', ?)").run(
        result.slug, side, amount, Date.now(), orderId
      );
      console.log(`[autoExecute] LIVE trade placed: ${result.slug} ${side} $${amount.toFixed(2)} orderId=${orderId}`);

      const { sendSignalAlert } = await import("../alerts/telegramAlert");
      await sendSignalAlert({ ...result, question } as any);
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
