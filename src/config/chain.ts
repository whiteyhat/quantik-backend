export type ChainMode = "polymarket" | "kraken";

const DEFAULT_CHAIN_MODE: ChainMode = "polymarket";

export function getChainMode(): ChainMode {
  const raw = String(process.env.CHAIN_MODE ?? DEFAULT_CHAIN_MODE).trim().toLowerCase();
  if (raw === "kraken") return "kraken";
  return "polymarket";
}

export function isKrakenMode(): boolean {
  return getChainMode() === "kraken";
}

/**
 * Dual-market mode: when enabled, a single SIGMA decision triggers BOTH
 * a Polymarket CLOB order AND a correlated Kraken paper trade.
 */
export function isDualMarketEnabled(): boolean {
  return process.env.DUAL_MARKET === "true";
}
