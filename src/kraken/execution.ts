// ── Kraken trade execution engine (paper + live) ─────────────────
import {
  krakenPaperBuy, krakenPaperSell, krakenFuturesPaperBuy, krakenFuturesPaperSell,
  krakenLiveBuy, krakenLiveSell, krakenFuturesLiveBuy, krakenFuturesLiveSell,
  krakenTicker,
  type KrakenCredentials,
} from "./cli";
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
  direction: "BUY" | "SELL";
  amount: number;
  price?: number;
  timestamp: number;
  raw?: unknown;
  assetClass: "crypto" | "forex" | "futures";
}

// ── executeKrakenTrade ──────────────────────────────────────────
// Routes a KrakenTradeSignal through the correct CLI based on asset class
// and trading mode (paper vs live).

export async function executeKrakenTrade(
  signal: KrakenTradeSignal,
  creds?: KrakenCredentials
): Promise<KrakenExecutionResult> {
  const { pair, direction, amount, assetClass } = signal;
  const isLive = !!creds;

  let fn: (pair: string, amount: number) => Promise<unknown>;
  if (isLive) {
    // Live mode — route through authenticated CLI commands
    if (assetClass === "futures") {
      fn = direction === "BUY"
        ? (p, a) => krakenFuturesLiveBuy(p, a, creds)
        : (p, a) => krakenFuturesLiveSell(p, a, creds);
    } else {
      fn = direction === "BUY"
        ? (p, a) => krakenLiveBuy(p, a, creds)
        : (p, a) => krakenLiveSell(p, a, creds);
    }
  } else {
    // Paper mode — no auth needed
    if (assetClass === "futures") {
      fn = direction === "BUY" ? krakenFuturesPaperBuy : krakenFuturesPaperSell;
    } else {
      fn = direction === "BUY" ? krakenPaperBuy : krakenPaperSell;
    }
  }

  try {
    const result = await fn(pair, amount);
    const mode = isLive ? "live" : "paper";
    console.log(`[Kraken][${mode}] ${direction} ${amount} ${pair} — success`);
    return { success: true, pair, direction, amount, assetClass, timestamp: Date.now(), raw: result };
  } catch (err) {
    const mode = isLive ? "live" : "paper";
    console.error(`[Kraken][${mode}] Trade failed: ${direction} ${amount} ${pair} (${assetClass})`, err instanceof Error ? err.message : String(err));
    return { success: false, pair, direction, amount, assetClass, timestamp: Date.now() };
  }
}

// ── executeMultiLegKrakenTrades ─────────────────────────────────
// Processes multiple trade signals sequentially (respects Kraken rate limits)
// and returns all results. Pass creds for live mode, omit for paper.

export async function executeMultiLegKrakenTrades(
  signals: KrakenTradeSignal[],
  creds?: KrakenCredentials
): Promise<KrakenExecutionResult[]> {
  const results: KrakenExecutionResult[] = [];
  for (const signal of signals) {
    const result = await executeKrakenTrade(signal, creds);
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

// ── USDC → base currency conversion ───────────────────────────
export async function convertUsdcToBaseAmount(
  pair: string,
  usdcAmount: number
): Promise<number> {
  try {
    const ticker = await krakenTicker(pair);
    // Ticker wraps data under a Kraken-specific key (e.g. XXBTZUSD); c[0] is last trade price
    let price: number | undefined;
    if (typeof ticker === "object" && ticker !== null) {
      const inner = Object.values(ticker as Record<string, unknown>)[0];
      if (typeof inner === "object" && inner !== null) {
        const data = inner as Record<string, unknown>;
        if (Array.isArray(data["c"]) && data["c"].length > 0) {
          price = Number(data["c"][0]);
        }
      }
    }

    if (!price || price <= 0) {
      console.warn(`[Kraken] Could not parse ticker price for ${pair}, raw:`, JSON.stringify(ticker));
      return usdcAmount; // fallback: pass through (will likely fail but at least logged)
    }

    const baseAmount = usdcAmount / price;
    // Round to 8 decimal places (Kraken precision)
    return Math.round(baseAmount * 1e8) / 1e8;
  } catch (err) {
    console.warn(`[Kraken] Ticker fetch failed for ${pair}:`, err instanceof Error ? err.message : String(err));
    return usdcAmount; // fallback
  }
}
