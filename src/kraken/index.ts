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
  krakenFuturesPaperBuy,
  krakenFuturesPaperSell,
  krakenLiveBuy,
  krakenLiveSell,
  krakenLiveBalance,
  krakenFuturesLiveBuy,
  krakenFuturesLiveSell,
  krakenAuthTest,
} from "./cli";
export type { KrakenCredentials } from "./cli";

export {
  executeKrakenTrade,
  executeMultiLegKrakenTrades,
  mapPipelineSignalToKraken,
  mapPipelineSignalToKrakenThesisAware,
  convertUsdcToBaseAmount,
} from "./execution";
export type { KrakenTradeSignal, KrakenExecutionResult } from "./execution";

export {
  correlateQuestionToAsset,
  resolveKrakenDirection,
} from "./correlation";
export type { CorrelationResult } from "./correlation";
