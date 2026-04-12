// ── Correlation engine: map Polymarket questions to crypto pairs ──

export interface CorrelationResult {
  pair: string; // Kraken pair e.g. "BTCUSD"
  asset: string; // Human-readable e.g. "Bitcoin"
  polarity: "bullish" | "bearish";
  confidence: number; // 0-1 how confident the match is
}

const ASSET_PATTERNS: Array<{
  patterns: RegExp[];
  pair: string;
  asset: string;
}> = [
  {
    patterns: [/\bBTC\b/i, /\bBitcoin\b/i],
    pair: "BTCUSD",
    asset: "Bitcoin",
  },
  {
    patterns: [/\bETH\b/i, /\bEthereum\b/i],
    pair: "ETHUSD",
    asset: "Ethereum",
  },
  {
    patterns: [/\bSOL\b/i, /\bSolana\b/i],
    pair: "SOLUSD",
    asset: "Solana",
  },
  {
    patterns: [/\bDOGE\b/i, /\bDogecoin\b/i],
    pair: "DOGEUSD",
    asset: "Dogecoin",
  },
  {
    patterns: [/\bXRP\b/i, /\bRipple\b/i],
    pair: "XRPUSD",
    asset: "XRP",
  },
];

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
): CorrelationResult | null {
  // Find matching asset
  let matchedAsset: { pair: string; asset: string } | null = null;
  for (const { patterns, pair, asset } of ASSET_PATTERNS) {
    if (patterns.some((p) => p.test(question))) {
      matchedAsset = { pair, asset };
      break;
    }
  }
  if (!matchedAsset) return null;

  // Determine polarity from question text
  const bullishScore = BULLISH_PATTERNS.filter((p) =>
    p.test(question)
  ).length;
  const bearishScore = BEARISH_PATTERNS.filter((p) =>
    p.test(question)
  ).length;
  const polarity: "bullish" | "bearish" =
    bullishScore >= bearishScore ? "bullish" : "bearish";
  const confidence = Math.min(
    1,
    (bullishScore + bearishScore) * 0.3 + 0.4
  );

  return {
    pair: matchedAsset.pair,
    asset: matchedAsset.asset,
    polarity,
    confidence,
  };
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
