// ── AttributionEngine — P&L attribution by signal type, alpha decay detection ──

import { getDb } from "../db/schema";

export type SignalType = "sentiment-driven" | "forecast-driven" | "arb" | "liquidity-edge";

export interface Attribution {
  signalType: string;
  wins: number;
  losses: number;
  hitRate: number;
  avgEdge: number;
}

export interface AlphaDecayStatus {
  detected: boolean;
  rollingHitRate: number;
  recommendation: string;
}

const SIGNAL_TYPES: SignalType[] = [
  "sentiment-driven",
  "forecast-driven",
  "arb",
  "liquidity-edge",
];

export class AttributionEngine {
  /** Get P&L attribution breakdown by signal type */
  getAttributionBySignal(): Attribution[] {
    const db = getDb();

    return SIGNAL_TYPES.map((signalType) => {
      const rows = db
        .prepare(
          `SELECT predicted, outcome, brier_score
           FROM resolutions
           WHERE signal_type = ?
           ORDER BY resolved_at DESC`
        )
        .all(signalType) as Array<{
        predicted: number;
        outcome: number;
        brier_score: number;
      }>;

      if (rows.length === 0) {
        return { signalType, wins: 0, losses: 0, hitRate: 0, avgEdge: 0 };
      }

      let wins = 0;
      let losses = 0;
      let totalEdge = 0;

      for (const row of rows) {
        // A "win" = predicted > 0.5 and outcome = 1, or predicted < 0.5 and outcome = 0
        const predictedCorrectly =
          (row.predicted >= 0.5 && row.outcome === 1) ||
          (row.predicted < 0.5 && row.outcome === 0);

        if (predictedCorrectly) {
          wins++;
        } else {
          losses++;
        }

        // Edge = |predicted - 0.5| when correct, negative when wrong
        const edge = Math.abs(row.predicted - 0.5);
        totalEdge += predictedCorrectly ? edge : -edge;
      }

      const total = wins + losses;
      return {
        signalType,
        wins,
        losses,
        hitRate: total > 0 ? wins / total : 0,
        avgEdge: total > 0 ? totalEdge / total : 0,
      };
    });
  }

  /** Detect alpha decay: rolling 10-trade hit rate < 45% */
  getAlphaDecayStatus(): AlphaDecayStatus {
    const db = getDb();

    const recent = db
      .prepare(
        `SELECT predicted, outcome
         FROM resolutions
         ORDER BY resolved_at DESC
         LIMIT 10`
      )
      .all() as Array<{ predicted: number; outcome: number }>;

    if (recent.length < 10) {
      return {
        detected: false,
        rollingHitRate: recent.length > 0
          ? recent.filter(
              (r) =>
                (r.predicted >= 0.5 && r.outcome === 1) ||
                (r.predicted < 0.5 && r.outcome === 0)
            ).length / recent.length
          : 0,
        recommendation: "insufficient_data",
      };
    }

    const wins = recent.filter(
      (r) =>
        (r.predicted >= 0.5 && r.outcome === 1) ||
        (r.predicted < 0.5 && r.outcome === 0)
    ).length;

    const rollingHitRate = wins / recent.length;
    const detected = rollingHitRate < 0.45;

    return {
      detected,
      rollingHitRate,
      recommendation: detected
        ? "decay_detected"
        : "no_decay",
    };
  }
}
