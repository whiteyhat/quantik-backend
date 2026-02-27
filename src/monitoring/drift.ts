// ── DriftDetection — microstructure & concept drift monitoring ──

import { getDb } from "../db/schema";

export interface MicrostructureDrift {
  detected: boolean;
  avgSpread: number;
  baseline: number;
  delta: number;
}

export interface ConceptDrift {
  detected: boolean;
  rollingHitRate: number;
  threshold: number;
}

const SPREAD_BASELINE = 0.03; // 3¢ baseline spread
const CONCEPT_DRIFT_THRESHOLD = 0.45;

export class DriftDetection {
  /**
   * Check if market microstructure has shifted.
   * Compares recent average spread against baseline.
   */
  checkMicrostructureDrift(): MicrostructureDrift {
    const db = getDb();

    // Get recent flux results for spread data
    const rows = db
      .prepare(
        `SELECT spread FROM flux_results
         ORDER BY scoredAt DESC
         LIMIT 20`
      )
      .all() as Array<{ spread: number }>;

    if (rows.length === 0) {
      return {
        detected: false,
        avgSpread: 0,
        baseline: SPREAD_BASELINE,
        delta: 0,
      };
    }

    const avgSpread = rows.reduce((s, r) => s + r.spread, 0) / rows.length;
    const delta = avgSpread - SPREAD_BASELINE;
    // Drift detected if spread widened by > 50% above baseline
    const detected = delta > SPREAD_BASELINE * 0.5;

    return { detected, avgSpread, baseline: SPREAD_BASELINE, delta };
  }

  /**
   * Check for concept drift: rolling hit rate of recent predictions.
   * If hit rate drops below 45%, signals potential model degradation.
   */
  checkConceptDrift(): ConceptDrift {
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT predicted, outcome
         FROM resolutions
         ORDER BY resolved_at DESC
         LIMIT 20`
      )
      .all() as Array<{ predicted: number; outcome: number }>;

    if (rows.length === 0) {
      return {
        detected: false,
        rollingHitRate: 0,
        threshold: CONCEPT_DRIFT_THRESHOLD,
      };
    }

    const wins = rows.filter(
      (r) =>
        (r.predicted >= 0.5 && r.outcome === 1) ||
        (r.predicted < 0.5 && r.outcome === 0)
    ).length;

    const rollingHitRate = wins / rows.length;
    const detected = rollingHitRate < CONCEPT_DRIFT_THRESHOLD;

    return { detected, rollingHitRate, threshold: CONCEPT_DRIFT_THRESHOLD };
  }
}
