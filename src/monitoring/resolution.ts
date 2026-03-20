// ── ResolutionMonitor — polls Polymarket for resolved markets, scores predictions ──

import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";

import { GAMMA_API_BASE, fetchWithRetry } from "../utils/market-fetch";
const GAMMA_API = GAMMA_API_BASE;

interface GammaMarket {
  condition_id: string;
  question: string;
  slug: string;
  resolved: boolean;
  outcome: string; // "Yes" | "No"
  outcome_prices: string; // JSON "[\"0.6\",\"0.4\"]"
}

interface Resolution {
  id: string;
  pipeline_run_id: string;
  market_slug: string;
  predicted: number;
  outcome: number;
  brier_score: number;
  signal_type: string | null;
  resolved_at: number;
}

interface PipelineRunRow {
  id: string;
  market_slug: string;
  confidence: number | null;
  oracle_output: string | null;
  signal_state: string | null;
}

export class ResolutionMonitor {
  /**
   * Poll Gamma API for resolved markets that match our pipeline_runs.
   * Stores resolutions + Brier scores for any new resolutions found.
   */
  async checkResolutions(): Promise<{ checked: number; newResolutions: number }> {
    const db = getDb();

    // Get pipeline runs that don't yet have a resolution
    const unresolvedRuns = db
      .prepare(
        `SELECT pr.id, pr.market_slug, pr.confidence, pr.oracle_output, pr.signal_state
         FROM pipeline_runs pr
         LEFT JOIN resolutions r ON r.pipeline_run_id = pr.id
         WHERE r.id IS NULL AND pr.decision = 'TRADE'
         ORDER BY pr.created_at DESC
         LIMIT 50`
      )
      .all() as PipelineRunRow[];

    if (unresolvedRuns.length === 0) {
      return { checked: 0, newResolutions: 0 };
    }

    // Deduplicate slugs
    const slugs = [...new Set(unresolvedRuns.map((r) => r.market_slug))];
    let newResolutions = 0;

    for (const slug of slugs) {
      try {
        const res = await fetchWithRetry(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;

        const markets = (await res.json()) as GammaMarket[];
        const market = markets.find((m) => m.slug === slug);
        if (!market || !market.resolved) continue;

        const outcome: 0 | 1 = market.outcome === "Yes" ? 1 : 0;

        // Store resolution for each pipeline run matching this slug
        const runs = unresolvedRuns.filter((r) => r.market_slug === slug);
        for (const run of runs) {
          const predicted = this.extractPredicted(run);
          const brierScore = this.computeBrierScore(predicted, outcome);
          const signalType = this.classifySignalType(run);

          this.storeResolution(run.id, slug, predicted, outcome, brierScore, signalType);
          newResolutions++;
        }
      } catch {
        // Skip network errors for individual slugs
      }
    }

    return { checked: slugs.length, newResolutions };
  }

  /** Brier score: (predicted - outcome)^2 */
  computeBrierScore(predicted: number, outcome: 0 | 1): number {
    return (predicted - outcome) ** 2;
  }

  /** Save a resolution record to SQLite */
  storeResolution(
    runId: string,
    slug: string,
    predicted: number,
    outcome: 0 | 1,
    brierScore: number,
    signalType: string | null
  ): void {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO resolutions (id, pipeline_run_id, market_slug, predicted, outcome, brier_score, signal_type, resolved_at)
       VALUES (@id, @pipeline_run_id, @market_slug, @predicted, @outcome, @brier_score, @signal_type, @resolved_at)`
    ).run({
      id: uuid(),
      pipeline_run_id: runId,
      market_slug: slug,
      predicted,
      outcome,
      brier_score: brierScore,
      signal_type: signalType,
      resolved_at: Date.now(),
    });
  }

  /** Get recent Brier scores for the dashboard */
  getRecentBrierScores(limit = 20): Resolution[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT r.id, r.pipeline_run_id AS pipeline_run_id, r.market_slug, r.predicted, r.outcome, r.brier_score, r.signal_type, r.resolved_at
         FROM resolutions r
         ORDER BY r.resolved_at DESC
         LIMIT ?`
      )
      .all(limit) as Resolution[];
  }

  /** Extract predicted probability from a pipeline run */
  private extractPredicted(run: PipelineRunRow): number {
    // Prefer oracle calibrated_prob
    if (run.oracle_output) {
      try {
        const oracle = JSON.parse(run.oracle_output);
        if (typeof oracle.calibrated_prob === "number") return oracle.calibrated_prob;
      } catch {
        // fall through
      }
    }
    // Fallback to pipeline confidence
    return run.confidence ?? 0.5;
  }

  /** Classify signal type from pipeline run data */
  private classifySignalType(run: PipelineRunRow): string | null {
    const signalState = run.signal_state;
    if (!signalState) return null;

    try {
      const state = JSON.parse(signalState);
      if (state.signalType) return state.signalType;
    } catch {
      // fall through
    }

    // Heuristic classification from oracle output
    if (run.oracle_output) {
      try {
        const oracle = JSON.parse(run.oracle_output);
        if (oracle.arb_detected) return "arb";
        if (oracle.cross_market_divergence) return "forecast-driven";
      } catch {
        // fall through
      }
    }

    return "sentiment-driven";
  }
}
