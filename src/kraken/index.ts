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

export {
  executeKrakenTrade,
  mapPipelineSignalToKraken,
  mapPipelineSignalToKrakenThesisAware,
} from "./execution";
export type { KrakenTradeSignal, KrakenExecutionResult } from "./execution";

export {
  correlateQuestionToAsset,
  resolveKrakenDirection,
} from "./correlation";
export type { CorrelationResult } from "./correlation";
