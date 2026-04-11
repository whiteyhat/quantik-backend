// ── Kraken module barrel exports ─────────────────────────────────
export {
  KrakenCliError,
  resolveKrakenPath,
  ensureKrakenInstalled,
  execKraken,
  krakenPaperBuy,
  krakenPaperSell,
  krakenPaperBalance,
  krakenTicker,
} from "./cli";

export { executeKrakenTrade, mapPipelineSignalToKraken } from "./execution";
export type { KrakenTradeSignal, KrakenExecutionResult } from "./execution";
