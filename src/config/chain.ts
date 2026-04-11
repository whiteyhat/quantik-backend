export type ChainMode = "stellar_testnet" | "polymarket" | "bridge" | "kraken";

const DEFAULT_CHAIN_MODE: ChainMode = "stellar_testnet";

export function getChainMode(): ChainMode {
  const raw = String(process.env.CHAIN_MODE ?? DEFAULT_CHAIN_MODE).trim().toLowerCase();
  if (raw === "polymarket") return "polymarket";
  if (raw === "bridge") return "bridge";
  if (raw === "kraken") return "kraken";
  return "stellar_testnet";
}

export function isStellarTestnetMode(): boolean {
  return getChainMode() === "stellar_testnet";
}

export function isPolymarketMode(): boolean {
  return getChainMode() === "polymarket";
}

export function isBridgeMode(): boolean {
  return getChainMode() === "bridge";
}

export function isKrakenMode(): boolean {
  return getChainMode() === "kraken";
}

/** True when Stellar chain is active (stellar_testnet or bridge mode) */
export function isStellarActive(): boolean {
  const mode = getChainMode();
  return mode === "stellar_testnet" || mode === "bridge";
}

/** True when Polygon chain is active (polymarket or bridge mode) */
export function isPolygonActive(): boolean {
  const mode = getChainMode();
  return mode === "polymarket" || mode === "bridge";
}
