// ── ModelCalibration — agent weight management and Brier-based recalibration ──

import fs from "fs";
import path from "path";

const WEIGHTS_PATH = path.join(__dirname, "..", "..", "data", "agent_weights.json");

export interface AgentWeight {
  agent: string;
  weight: number;
  brierScore: number | null;
  trend: "improving" | "degrading" | "stable";
}

interface WeightsFile {
  weights: AgentWeight[];
  updatedAt: number | null;
}

const DEFAULT_WEIGHTS: AgentWeight[] = [
  { agent: "Edge",   weight: 0.30, brierScore: null, trend: "stable" },
  { agent: "Oracle", weight: 0.25, brierScore: null, trend: "stable" },
  { agent: "Clause", weight: 0.20, brierScore: null, trend: "stable" },
  { agent: "Aura",   weight: 0.15, brierScore: null, trend: "stable" },
  { agent: "Flux",   weight: 0.10, brierScore: null, trend: "stable" },
];

export class ModelCalibration {
  /** Read current agent weights from file */
  getAgentWeights(): AgentWeight[] {
    try {
      const raw = fs.readFileSync(WEIGHTS_PATH, "utf-8");
      const data = JSON.parse(raw) as WeightsFile;
      return data.weights;
    } catch {
      return DEFAULT_WEIGHTS;
    }
  }

  /**
   * Update an agent's weight based on new Brier score.
   * Lower Brier = better calibration = weight moves up.
   * Higher Brier = worse calibration = weight moves down.
   */
  updateAgentWeight(agent: string, newBrierScore: number): void {
    const data = this.readFile();
    const entry = data.weights.find((w) => w.agent === agent);
    if (!entry) return;

    const prevBrier = entry.brierScore;

    // Determine trend
    if (prevBrier === null) {
      entry.trend = "stable";
    } else if (newBrierScore < prevBrier - 0.01) {
      entry.trend = "improving";
    } else if (newBrierScore > prevBrier + 0.01) {
      entry.trend = "degrading";
    } else {
      entry.trend = "stable";
    }

    entry.brierScore = newBrierScore;

    // Adjust weight: ±2% based on trend
    if (entry.trend === "improving") {
      entry.weight = Math.min(0.50, entry.weight + 0.02);
    } else if (entry.trend === "degrading") {
      entry.weight = Math.max(0.05, entry.weight - 0.02);
    }

    // Renormalize weights to sum to 1.0
    const totalWeight = data.weights.reduce((s, w) => s + w.weight, 0);
    if (totalWeight > 0) {
      for (const w of data.weights) {
        w.weight = w.weight / totalWeight;
      }
    }

    data.updatedAt = Date.now();
    this.writeFile(data);
  }

  private readFile(): WeightsFile {
    try {
      const raw = fs.readFileSync(WEIGHTS_PATH, "utf-8");
      return JSON.parse(raw) as WeightsFile;
    } catch {
      return { weights: [...DEFAULT_WEIGHTS], updatedAt: null };
    }
  }

  private writeFile(data: WeightsFile): void {
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
}
