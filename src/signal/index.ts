// ── AlphaSignal — Edge computation & sizing ─────────────────────

export interface AlphaSignal {
  grossEdge: number;
  netEdge: number;
  kellyFraction: number;
  evGrade: "A" | "B" | "C" | "D";
  direction: "YES" | "NO";
}

const POLY_FEE = 0.02;
const KELLY_MULTIPLIER = 0.25; // quarter-Kelly

export function computeEdge(
  modelProb: number,
  marketPrice: number
): AlphaSignal {
  const direction: "YES" | "NO" = modelProb > marketPrice ? "YES" : "NO";

  // Edge relative to the side we're betting
  const pTarget = direction === "YES" ? modelProb : 1 - modelProb;
  const mTarget = direction === "YES" ? marketPrice : 1 - marketPrice;

  const grossEdge = pTarget - mTarget;
  const netEdge = grossEdge - POLY_FEE;

  // Fractional Kelly: f* = (edge / (1 - mTarget)) * multiplier
  const denom = 1 - mTarget;
  const kellyFraction =
    denom > 0 ? (Math.max(0, netEdge) / denom) * KELLY_MULTIPLIER : 0;

  // Grade the edge
  let evGrade: AlphaSignal["evGrade"];
  if (netEdge > 0.1) evGrade = "A";
  else if (netEdge > 0.07) evGrade = "B";
  else if (netEdge > 0.05) evGrade = "C";
  else evGrade = "D";

  return { grossEdge, netEdge, kellyFraction, evGrade, direction };
}

/** Only trade if netEdge exceeds minimum threshold */
export const MIN_NET_EDGE = 0.05;

export function shouldTrade(signal: AlphaSignal): boolean {
  return signal.netEdge > MIN_NET_EDGE;
}
