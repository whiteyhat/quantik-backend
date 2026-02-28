import { execFile } from "child_process";
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
              await this.storeScanResult(result);
              scannedToday++;

              if (result.shouldAlert) {
                alertsTriggered++;
                console.log(`[Scanner] ALERT triggered for ${m.slug}: σ=${result.sigmaConfidence.toFixed(2)} Kelly=${result.kellyFraction.toFixed(2)}`);
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

    try {
      const result = await runPolymarketCli(["markets", "list", "--limit", String(limit)]);
      rawMarkets = Array.isArray(result) ? result : [];
    } catch (err) {
      console.warn("[Scanner] polymarket-cli failed, using Gamma API fallback:", err);
      // Fallback to Gamma API
      const res = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&limit=${limit}&order=volume24hr&ascending=false`);
      const data = await res.json() as unknown[];
      rawMarkets = Array.isArray(data) ? data : [];
    }

    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

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
      // 1. Closing within 7 days (urgency)
      if (endDate) {
        const closeTime = new Date(endDate).getTime();
        if (closeTime - now > sevenDaysMs) continue; // closes too far out
        if (closeTime < now) continue; // already closed
      }

      // 2. Volume > $10k
      if (volume < 10000) continue;

      // 3. Price between 0.15 and 0.85 (avoid near-certain)
      if (yesPrice < 0.15 || yesPrice > 0.85) continue;

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
      sigma.confidence >= 0.70 &&
      edge.kelly_fraction >= 0.40 &&
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

  async storeScanResult(result: ScanResult): Promise<void> {
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
