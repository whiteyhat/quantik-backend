// ── Universal cross-market correlation engine ───────────────────
// Maps Polymarket questions to crypto, forex, and futures instruments.

export interface CorrelationResult {
  pair: string; // Kraken pair e.g. "BTCUSD", "EURUSD", "PF_XBTUSD"
  asset: string; // Human-readable e.g. "Bitcoin", "Euro/Dollar"
  polarity: "bullish" | "bearish";
  confidence: number; // 0-1 how confident the match is
  assetClass: "crypto" | "forex" | "futures";
}

const ASSET_PATTERNS: Array<{
  patterns: RegExp[];
  pair: string;
  asset: string;
  assetClass: "crypto" | "forex" | "futures";
}> = [
  // ── Crypto spot ──
  {
    patterns: [/\bBTC\b/i, /\bBitcoin\b/i],
    pair: "BTCUSD",
    asset: "Bitcoin",
    assetClass: "crypto",
  },
  {
    patterns: [/\bETH\b/i, /\bEthereum\b/i],
    pair: "ETHUSD",
    asset: "Ethereum",
    assetClass: "crypto",
  },
  {
    patterns: [/\bSOL\b/i, /\bSolana\b/i],
    pair: "SOLUSD",
    asset: "Solana",
    assetClass: "crypto",
  },
  {
    patterns: [/\bDOGE\b/i, /\bDogecoin\b/i],
    pair: "DOGEUSD",
    asset: "Dogecoin",
    assetClass: "crypto",
  },
  {
    patterns: [/\bXRP\b/i, /\bRipple\b/i],
    pair: "XRPUSD",
    asset: "XRP",
    assetClass: "crypto",
  },

  // ── Forex ──
  {
    patterns: [/\bfed\b/i, /\bfederal reserve\b/i, /\binterest rate\b/i, /\brate cut\b/i, /\brate hike\b/i],
    pair: "EURUSD",
    asset: "Euro/Dollar",
    assetClass: "forex",
  },
  {
    patterns: [/\busd strength\b/i, /\bdollar index\b/i, /\bdxy\b/i],
    pair: "USDJPY",
    asset: "Dollar/Yen",
    assetClass: "forex",
  },
  {
    patterns: [/\buk economy\b/i, /\bbrexit\b/i, /\bpound\b/i, /\bgbp\b/i, /\bsterling\b/i],
    pair: "GBPUSD",
    asset: "Pound/Dollar",
    assetClass: "forex",
  },
  {
    patterns: [/\bjapan\b/i, /\byen\b/i, /\bboj\b/i, /\bbank of japan\b/i],
    pair: "USDJPY",
    asset: "Dollar/Yen",
    assetClass: "forex",
  },

  // ── Macro / commodity proxies ──
  {
    patterns: [/\binflation\b/i, /\bcpi\b/i, /\bgold\b/i],
    pair: "XAUUSD",
    asset: "Gold",
    assetClass: "crypto",
  },
  {
    patterns: [/\boil\b/i, /\bcrude\b/i, /\bopec\b/i, /\bpetroleum\b/i],
    pair: "XRPUSD",
    asset: "XRP (oil proxy)",
    assetClass: "crypto",
  },
];

// Futures perpetual mappings for bearish crypto positions
const FUTURES_PAIRS: Record<string, string> = {
  BTCUSD: "PF_XBTUSD",
  ETHUSD: "PF_ETHUSD",
  SOLUSD: "PF_SOLUSD",
};

// Crypto keywords used to detect cross-match opportunities with forex
const CRYPTO_KEYWORDS = [/\bcrypto\b/i, /\bBTC\b/i, /\bBitcoin\b/i, /\bETH\b/i, /\bEthereum\b/i];

const BULLISH_PATTERNS = [
  /\bhit\b/i,
  /\breach\b/i,
  /\babove\b/i,
  /\bsurpass\b/i,
  /\bexceed\b/i,
  /\brise\b/i,
  /\bnew.?high\b/i,
  /\brally\b/i,
];

const BEARISH_PATTERNS = [
  /\bcrash\b/i,
  /\bbelow\b/i,
  /\bdrop\b/i,
  /\bfall\b/i,
  /\bdecline\b/i,
  /\btumble\b/i,
  /\bplunge\b/i,
  /\blose\b/i,
];

export function correlateQuestionToAsset(
  question: string
): CorrelationResult[] {
  const results: CorrelationResult[] = [];
  const seenPairs = new Map<string, number>(); // pair -> index in results

  // Determine polarity from question text
  const bullishScore = BULLISH_PATTERNS.filter((p) => p.test(question)).length;
  const bearishScore = BEARISH_PATTERNS.filter((p) => p.test(question)).length;
  const polarity: "bullish" | "bearish" =
    bullishScore >= bearishScore ? "bullish" : "bearish";
  const confidence = Math.min(1, (bullishScore + bearishScore) * 0.3 + 0.4);

  // Check if question mentions crypto keywords (for forex cross-match)
  const hasCryptoKeyword = CRYPTO_KEYWORDS.some((p) => p.test(question));

  // Iterate ALL patterns — collect all matching assets
  for (const { patterns, pair, asset, assetClass } of ASSET_PATTERNS) {
    if (!patterns.some((p) => p.test(question))) continue;

    const existing = seenPairs.get(pair);
    if (existing !== undefined) {
      // Deduplicate: keep higher confidence
      if (confidence > results[existing].confidence) {
        results[existing] = { pair, asset, polarity, confidence, assetClass };
      }
      continue;
    }

    seenPairs.set(pair, results.length);
    results.push({ pair, asset, polarity, confidence, assetClass });

    // For bearish crypto matches with a futures pair, add a futures entry
    if (assetClass === "crypto" && polarity === "bearish" && FUTURES_PAIRS[pair]) {
      const futuresPair = FUTURES_PAIRS[pair];
      if (!seenPairs.has(futuresPair)) {
        seenPairs.set(futuresPair, results.length);
        results.push({
          pair: futuresPair,
          asset: `${asset} Perpetual`,
          polarity: "bearish",
          confidence: confidence * 0.9,
          assetClass: "futures",
        });
      }
    }
  }

  // Forex + crypto cross-match: forex match with crypto keywords adds BTC entry
  const hasForexMatch = results.some((r) => r.assetClass === "forex");
  if (hasForexMatch && hasCryptoKeyword && !seenPairs.has("BTCUSD")) {
    // Rate cuts / macro events are generally bullish for risk-on assets
    seenPairs.set("BTCUSD", results.length);
    results.push({
      pair: "BTCUSD",
      asset: "Bitcoin",
      polarity: "bullish",
      confidence: 0.6,
      assetClass: "crypto",
    });
  }

  // Forex match without explicit crypto keyword: still add BTC as secondary
  // (macro events always have crypto implications)
  if (hasForexMatch && !hasCryptoKeyword && !seenPairs.has("BTCUSD")) {
    seenPairs.set("BTCUSD", results.length);
    results.push({
      pair: "BTCUSD",
      asset: "Bitcoin",
      polarity: "bullish",
      confidence: 0.6,
      assetClass: "crypto",
    });
  }

  return results;
}

export function resolveKrakenDirection(
  decision: "BET_YES" | "BET_NO",
  polarity: "bullish" | "bearish"
): "BUY" | "SELL" {
  // BET_YES + bullish = BUY (agree with bullish thesis)
  // BET_YES + bearish = SELL (agree with bearish thesis)
  // BET_NO inverts
  if (decision === "BET_YES") {
    return polarity === "bullish" ? "BUY" : "SELL";
  }
  return polarity === "bullish" ? "SELL" : "BUY";
}
