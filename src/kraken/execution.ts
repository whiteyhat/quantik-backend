// ── Kraken paper trade execution engine ──────────────────────────
import { krakenPaperBuy, krakenPaperSell, krakenFuturesPaperBuy, krakenFuturesPaperSell } from "./cli";
import { resolveKrakenDirection } from "./correlation";
import type { TradeSignal } from "../execution";

export interface KrakenTradeSignal {
  pair: string; // "BTCUSD", "ETHUSD", "PF_XBTUSD", "EURUSD"
  direction: "BUY" | "SELL";
  amount: number; // quantity in base currency (e.g., 0.1 BTC)
  assetClass: "crypto" | "forex" | "futures";
}

export interface KrakenExecutionResult {
  success: boolean;
  orderId?: string;
  pair: string;
  direction: string;
  amount: number;
  price?: number;
  timestamp: number;
  raw?: unknown;
  assetClass: "crypto" | "forex" | "futures";
}

// ── executeKrakenTrade ──────────────────────────────────────────
// Routes a KrakenTradeSignal through the correct CLI based on asset class.

export async function executeKrakenTrade(
  signal: KrakenTradeSignal
): Promise<KrakenExecutionResult> {
  const { pair, direction, amount, assetClass } = signal;

  // Route to correct CLI based on asset class
  let fn: (pair: string, amount: number) => Promise<unknown>;
  if (assetClass === "futures") {
    fn = direction === "BUY" ? krakenFuturesPaperBuy : krakenFuturesPaperSell;
  } else {
    // crypto and forex both use spot paper trading
    fn = direction === "BUY" ? krakenPaperBuy : krakenPaperSell;
  }

  try {
    const result = await fn(pair, amount);
    return { success: true, pair, direction, amount, assetClass, timestamp: Date.now(), raw: result };
  } catch {
    return { success: false, pair, direction, amount, assetClass, timestamp: Date.now() };
  }
}

// ── executeMultiLegKrakenTrades ─────────────────────────────────
// Processes multiple trade signals sequentially (respects Kraken rate limits)
// and returns all results.

export async function executeMultiLegKrakenTrades(
  signals: KrakenTradeSignal[]
): Promise<KrakenExecutionResult[]> {
  const results: KrakenExecutionResult[] = [];
  for (const signal of signals) {
    const result = await executeKrakenTrade(signal);
    results.push(result);
  }
  return results;
}

// ── mapPipelineSignalToKraken ───────────────────────────────────
// Converts a Polymarket-style TradeSignal to a KrakenTradeSignal.
// YES -> BUY, NO -> SELL. sizeUsdc maps to amount directly
// (in real usage would convert USDC to base qty via ticker price).

export function mapPipelineSignalToKraken(
  signal: TradeSignal,
  pair: string,
  assetClass: "crypto" | "forex" | "futures" = "crypto"
): KrakenTradeSignal {
  const direction: "BUY" | "SELL" = signal.direction === "YES" ? "BUY" : "SELL";
  return {
    pair,
    direction,
    amount: signal.sizeUsdc,
    assetClass,
  };
}

// ── Thesis-aware mapping for dual-market mode ──────────────────
// Uses correlation polarity instead of blind YES->BUY mapping.
export function mapPipelineSignalToKrakenThesisAware(
  signal: TradeSignal,
  pair: string,
  polarity: "bullish" | "bearish",
  assetClass: "crypto" | "forex" | "futures" = "crypto"
): KrakenTradeSignal {
  const decision: "BET_YES" | "BET_NO" =
    signal.direction === "YES" ? "BET_YES" : "BET_NO";
  const direction = resolveKrakenDirection(decision, polarity);
  return { pair, direction, amount: signal.sizeUsdc, assetClass };
}
