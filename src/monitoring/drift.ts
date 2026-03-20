// ── DriftDetection — microstructure & concept drift monitoring ──

import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery } from "../db/postgres";

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

function computeMicrostructureDrift(rows: Array<{ spread: number }>): MicrostructureDrift {
  if (rows.length === 0) {
    return { detected: false, avgSpread: 0, baseline: SPREAD_BASELINE, delta: 0 };
  }

  const avgSpread = rows.reduce((s, r) => s + r.spread, 0) / rows.length;
  const delta = avgSpread - SPREAD_BASELINE;
  const detected = delta > SPREAD_BASELINE * 0.5;

  return { detected, avgSpread, baseline: SPREAD_BASELINE, delta };
}

function computeConceptDrift(rows: Array<{ predicted: number; outcome: number }>): ConceptDrift {
  if (rows.length === 0) {
    return { detected: false, rollingHitRate: 0, threshold: CONCEPT_DRIFT_THRESHOLD };
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

export class DriftDetection {
  /**
   * Check if market microstructure has shifted.
   * Compares recent average spread against baseline.
   */
  async checkMicrostructureDrift(): Promise<MicrostructureDrift> {
    if (isPgEnabled()) {
      return this.checkMicrostructureDriftPg();
    }

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT spread FROM flux_results
         ORDER BY scoredAt DESC
         LIMIT 20`
      )
      .all() as Array<{ spread: number }>;

    return computeMicrostructureDrift(rows);
  }

  private async checkMicrostructureDriftPg(): Promise<MicrostructureDrift> {
    const rows = await pgQuery<{ spread: number }>(
      `SELECT spread FROM flux_results
       ORDER BY "scoredAt" DESC
       LIMIT 20`
    );
    return computeMicrostructureDrift(rows);
  }

  /**
   * Check for concept drift: rolling hit rate of recent predictions.
   * If hit rate drops below 45%, signals potential model degradation.
   */
  async checkConceptDrift(): Promise<ConceptDrift> {
    if (isPgEnabled()) {
      return this.checkConceptDriftPg();
    }

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT predicted, outcome
         FROM resolutions
         ORDER BY resolved_at DESC
         LIMIT 20`
      )
      .all() as Array<{ predicted: number; outcome: number }>;

    return computeConceptDrift(rows);
  }

  private async checkConceptDriftPg(): Promise<ConceptDrift> {
    const rows = await pgQuery<{ predicted: number; outcome: number }>(
      `SELECT predicted, outcome
       FROM resolutions
       ORDER BY resolved_at DESC
       LIMIT 20`
    );
    return computeConceptDrift(rows);
  }
}
