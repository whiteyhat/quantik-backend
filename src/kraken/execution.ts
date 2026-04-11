// ── Kraken paper trade execution engine ──────────────────────────
import { krakenPaperBuy, krakenPaperSell } from "./cli";
import type { TradeSignal } from "../execution";

export interface KrakenTradeSignal {
  pair: string; // "BTCUSD", "ETHUSD", "SOLUSD"
  direction: "BUY" | "SELL";
  amount: number; // quantity in base currency (e.g., 0.1 BTC)
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
}

// ── executeKrakenTrade ──────────────────────────────────────────
// Routes a KrakenTradeSignal through the paper trading CLI.

export async function executeKrakenTrade(
  signal: KrakenTradeSignal
): Promise<KrakenExecutionResult> {
  const { pair, direction, amount } = signal;
  const fn = direction === "BUY" ? krakenPaperBuy : krakenPaperSell;

  try {
    const result = await fn(pair, amount);
    return {
      success: true,
      pair,
      direction,
      amount,
      timestamp: Date.now(),
      raw: result,
    };
  } catch {
    return {
      success: false,
      pair,
      direction,
      amount,
      timestamp: Date.now(),
    };
  }
}

// ── mapPipelineSignalToKraken ───────────────────────────────────
// Converts a Polymarket-style TradeSignal to a KrakenTradeSignal.
// YES -> BUY, NO -> SELL. sizeUsdc maps to amount directly
// (in real usage would convert USDC to base qty via ticker price).

export function mapPipelineSignalToKraken(
  signal: TradeSignal,
  pair: string
): KrakenTradeSignal {
  const direction: "BUY" | "SELL" = signal.direction === "YES" ? "BUY" : "SELL";
  return {
    pair,
    direction,
    amount: signal.sizeUsdc,
  };
}
