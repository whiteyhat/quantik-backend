export type ChainMode = "polymarket" | "kraken";
export type KrakenTradingMode = "paper" | "live";

const DEFAULT_CHAIN_MODE: ChainMode = "polymarket";

// Runtime override: set by settings routes when user toggles kraken mode
let runtimeKrakenMode: KrakenTradingMode | null = null;

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

/** Get kraken trading mode (paper or live). Checks runtime override, then env, then default. */
export function getKrakenTradingMode(): KrakenTradingMode {
  if (runtimeKrakenMode) return runtimeKrakenMode;
  const env = process.env.KRAKEN_TRADING_MODE?.trim().toLowerCase();
  if (env === "live") return "live";
  return "paper";
}

export function setKrakenTradingMode(mode: KrakenTradingMode): void {
  runtimeKrakenMode = mode;
}

export function isKrakenLiveMode(): boolean {
  return getKrakenTradingMode() === "live";
}
