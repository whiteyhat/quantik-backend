export type ChainMode = "polymarket" | "kraken";

const DEFAULT_CHAIN_MODE: ChainMode = "polymarket";

export function getChainMode(): ChainMode {
  const raw = String(process.env.CHAIN_MODE ?? DEFAULT_CHAIN_MODE).trim().toLowerCase();
  if (raw === "kraken") return "kraken";
  return "polymarket";
}

export function isPolymarketMode(): boolean {
  return getChainMode() === "polymarket";
}

export function isKrakenMode(): boolean {
  return getChainMode() === "kraken";
}
