import { getDb } from "../db/schema";
import { extractKeywords, extractMainKeyword } from "./keywords";
import { fetchGNews } from "./gnews";

const EXA_API_KEY = process.env.EXA_API_KEY || "";
const NEWS_API_KEY = process.env.NEWS_API_KEY || "";

export interface AuraResult {
  marketSlug: string;
  scoredAt: number;
  sentimentDelta: number;
  shiftDetected: boolean;
  shiftDirection: "YES" | "NO" | "NEUTRAL";
  shiftVelocity: number;
  shiftTrend: "ACCELERATING" | "STEADY" | "DECELERATING" | "REVERSING";
  shiftPersistence: number;
  twitterSentiment: number;
  twitterVolumeDelta: number;
  telegramBias: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNAVAILABLE";
  breakingNews: boolean;
  newsHeadlines: string[];
  searchTrendSpike: boolean;
  searchTrendValue: number;
  whalePosYesPct: number;
  whalePositioning: "LONG" | "SHORT" | "NEUTRAL" | "MIXED";
  echoChamberRisk: number;
  dataSufficiency: number;
  confidence: number;
  sourcesUsed: string[];
  sourceStatus: Record<string, "ok" | "unavailable" | "timeout">;
  error?: string;
}

function parseWeights(envVar: string | undefined, defaultWeights: Record<string, number>) {
  if (envVar) {
    try {
      return JSON.parse(envVar);
    } catch {
      return defaultWeights;
    }
  }
  return defaultWeights;
}

const WEIGHTS = {
  crypto: parseWeights(process.env.AURA_WEIGHTS_CRYPTO, { twitter: 2, telegram: 2, news: 1, trends: 1, default: 1 }),
  political: parseWeights(process.env.AURA_WEIGHTS_POLITICAL, { twitter: 1, telegram: 1, news: 2, trends: 1, default: 1 }),
  sports: parseWeights(process.env.AURA_WEIGHTS_SPORTS, { twitter: 1, telegram: 1, news: 1, trends: 2, default: 1 }),
  default: parseWeights(process.env.AURA_WEIGHTS_DEFAULT, { twitter: 1, telegram: 1, news: 1, trends: 1, default: 1 }),
};

const timeout = <T>(ms: number): Promise<T> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms));

async function runWithTimeout<T>(promise: Promise<T>, ms: number = 20000): Promise<T> {
  return Promise.race([promise, timeout<T>(ms)]);
}

// Market data cache TTL: 10 mins
let marketDataCache: { data: { yesProbability: number; volume24h: number }; slug: string; timestamp: number } | null = null;
const MARKET_CACHE_TTL = 10 * 60 * 1000;

// --- Free data source functions ---

const POSITIVE_KEYWORDS = ["likely", "will", "yes", "bullish", "confirmed", "happening", "surge", "rally", "up", "win"];
const NEGATIVE_KEYWORDS = ["unlikely", "no", "bearish", "cancelled", "delayed", "doubt", "crash", "down", "lose", "fail"];

async function searchExa(query: string, daysBack: number): Promise<{ title: string; snippet: string; url: string }[]> {
  try {
    const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": EXA_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        numResults: 10,
        startPublishedDate: startDate,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { results?: { title?: string; text?: string; url?: string }[] };
    return (data.results || []).map((r) => ({
      title: r.title || "",
      snippet: r.text || "",
      url: r.url || "",
    }));
  } catch {
    return [];
  }
}

async function fetchNewsApi(keyword: string): Promise<{ title: string; publishedAt: string; source?: string }[]> {
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(keyword)}&pageSize=5&sortBy=publishedAt&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { articles?: { title?: string; publishedAt?: string }[] };
    return (data.articles || []).map((a) => ({
      title: a.title || "",
      publishedAt: a.publishedAt || "",
    }));
  } catch {
    return [];
  }
}

async function fetchAllNews(query: string): Promise<{ title: string; publishedAt: string; source?: string }[]> {
  // Primary: Google News (no API key, no rate limit, real-time)
  const gnewsArticles = await fetchGNews(query, { maxResults: 15, periodDays: 7 });

  if (gnewsArticles.length > 0) {
    console.log(`[Aura] GNews returned ${gnewsArticles.length} articles for: ${query}`);
    return gnewsArticles.map(a => ({ title: a.title, publishedAt: a.publishedAt, source: a.source }));
  }

  // Fallback: NewsAPI
  console.log(`[Aura] GNews returned 0 — falling back to NewsAPI`);
  return await fetchNewsApi(query);
}

async function getMarketData(slug: string): Promise<{ yesProbability: number; volume24h: number }> {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&order=volume24hr&limit=5`);
    if (!res.ok) return { yesProbability: 0.5, volume24h: 0 };
    const data = await res.json() as { outcomePrices?: string; volume24hr?: number }[];
    if (!Array.isArray(data) || data.length === 0) return { yesProbability: 0.5, volume24h: 0 };
    const market = data[0];
    let yesProbability = 0.5;
    if (market.outcomePrices) {
      try {
        const prices = JSON.parse(market.outcomePrices) as string[];
        yesProbability = parseFloat(prices[0]) || 0.5;
      } catch {
        yesProbability = 0.5;
      }
    }
    return { yesProbability, volume24h: market.volume24hr || 0 };
  } catch {
    return { yesProbability: 0.5, volume24h: 0 };
  }
}

async function computeSocialSentimentFromNews(query: string): Promise<{ score: number; volumeDelta: number; resultCount: number }> {
  const articles = await fetchAllNews(query);
  if (articles.length === 0) return { score: 0, volumeDelta: 0, resultCount: 0 };

  const POSITIVE = ["likely","will","yes","bullish","confirmed","happening","surge","rally","up","win","passes","approved","elected","won","milestone","record"];
  const NEGATIVE = ["unlikely","no","bearish","cancelled","delayed","doubt","crash","down","lose","fail","vetoed","rejected","lost","withdrawn","suspended","dropped"];

  let pos = 0, neg = 0;
  for (const a of articles) {
    const text = a.title.toLowerCase();
    if (POSITIVE.some(k => text.includes(k))) pos++;
    if (NEGATIVE.some(k => text.includes(k))) neg++;
  }
  const score = (pos - neg) / Math.max(articles.length, 1);
  return { score: Math.max(-1, Math.min(1, score)), volumeDelta: 0, resultCount: articles.length }; // volumeDelta: real Twitter API not connected — using news proxy
}

export async function runAura(market: { slug: string; question: string; category?: string }): Promise<AuraResult> {
  if (process.env.APIFY_MOCK === "true") {
    return getMockResult(market.slug);
  }

  const mainKeyword = extractMainKeyword(market.question);
  const sourceStatus: Record<string, "ok" | "unavailable" | "timeout"> = {};
  const sourcesUsed: string[] = [];

  // Fetch market data with cache
  const fetchMarketDataCached = async () => {
    if (marketDataCache && marketDataCache.slug === market.slug && Date.now() - marketDataCache.timestamp < MARKET_CACHE_TTL) {
      sourceStatus["leaderboard"] = "ok";
      sourcesUsed.push("leaderboard");
      return marketDataCache.data;
    }
    const data = await getMarketData(market.slug);
    if (data.volume24h > 0) {
      marketDataCache = { data, slug: market.slug, timestamp: Date.now() };
      sourceStatus["leaderboard"] = "ok";
      sourcesUsed.push("leaderboard");
    } else {
      sourceStatus["leaderboard"] = "unavailable";
    }
    return data;
  };

  // Social sentiment via Exa
  const fetchSocial = async () => {
    try {
      const result = await computeSocialSentimentFromNews(market.question.slice(0, 100));
      if (result.resultCount > 0) {
        sourceStatus["twitter"] = "ok";
        sourcesUsed.push("twitter");
      } else {
        sourceStatus["twitter"] = "unavailable";
      }
      return result;
    } catch (err: any) {
      sourceStatus["twitter"] = err.message === "TIMEOUT" ? "timeout" : "unavailable";
      return { score: 0, volumeDelta: 0, resultCount: 0 };
    }
  };

  // News via GNews (primary) + NewsAPI (fallback)
  const fetchNewsData = async () => {
    try {
      let articles = await fetchAllNews(market.question);
      if (articles.length === 0) {
        // Try shorter query — first 3 meaningful words
        const shortQuery = market.question.split(" ").filter(w => w.length > 3).slice(0, 3).join(" ");
        if (shortQuery) articles = await fetchAllNews(shortQuery);
      }
      if (articles.length > 0) {
        sourceStatus["news"] = "ok";
        if (!sourcesUsed.includes("news")) sourcesUsed.push("news");
      } else {
        sourceStatus["news"] = "unavailable";
      }
      return articles;
    } catch (err: any) {
      sourceStatus["news"] = err.message === "TIMEOUT" ? "timeout" : "unavailable";
      return [];
    }
  };

  // Trends via GNews 7d vs 30d ratio (replaces broken Exa ratio)
  const fetchTrends = async () => {
    try {
      const keywords = market.question.split(" ").filter(w => w.length > 3).slice(0, 3).join(" ");

      const [recent, older] = await Promise.all([
        fetchGNews(keywords, { maxResults: 20, periodDays: 7 }),
        fetchGNews(keywords, { maxResults: 20, periodDays: 30 }),
      ]);

      if (older.length === 0) {
        // Fall back to Gamma volume
        const gammaRes = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(market.slug)}&limit=1`);
        if (gammaRes.ok) {
          const data = await gammaRes.json() as any[];
          const m = Array.isArray(data) && data.length > 0 ? data[0] : null;
          const vol24h = Number(m?.volume24hr ?? 0);
          const value = Math.min(100, Math.round(vol24h / 1000));
          sourceStatus["trends"] = vol24h > 0 ? "ok" : "unavailable";
          if (vol24h > 0 && !sourcesUsed.includes("trends")) sourcesUsed.push("trends");
          return { spike: vol24h > 50000, value };
        }
        sourceStatus["trends"] = "unavailable";
        return { spike: false, value: 0 };
      }

      // GNews 7d vs 30d ratio gives real trend signal
      const ratio = older.length > 0 ? recent.length / older.length : 1;
      const value = Math.min(100, Math.round(ratio * 50));
      const spike = ratio > 1.5; // recent activity > 50% above baseline
      sourceStatus["trends"] = "ok";
      if (!sourcesUsed.includes("trends")) sourcesUsed.push("trends");
      return { spike, value };
    } catch {
      sourceStatus["trends"] = "unavailable";
      return { spike: false, value: 0 };
    }
  };

  // Telegram — always UNAVAILABLE (removed to save cost)
  sourceStatus["telegram"] = "unavailable";

  const [socialRes, newsRes, trendsRes, marketRes] = await Promise.allSettled([
    runWithTimeout(fetchSocial()),
    runWithTimeout(fetchNewsData()),
    runWithTimeout(fetchTrends()),
    runWithTimeout(fetchMarketDataCached()),
  ]);

  const social = socialRes.status === "fulfilled" ? socialRes.value : { score: 0, volumeDelta: 0, resultCount: 0 };
  const newsArticles = newsRes.status === "fulfilled" ? newsRes.value : [];
  const trends = trendsRes.status === "fulfilled" ? trendsRes.value : { spike: false, value: 50 };
  const marketData = marketRes.status === "fulfilled" ? marketRes.value : { yesProbability: 0.5, volume24h: 0 };

  // Mark timeout on failed promises
  if (socialRes.status === "rejected") sourceStatus["twitter"] = "timeout";
  if (newsRes.status === "rejected") sourceStatus["news"] = "timeout";
  if (trendsRes.status === "rejected") sourceStatus["trends"] = "timeout";
  if (marketRes.status === "rejected") sourceStatus["leaderboard"] = "timeout";

  const twitterSentiment = social.score;
  const twitterVolumeDelta = social.volumeDelta;
  const telegramBias: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNAVAILABLE" = "UNAVAILABLE";

  // News
  const newsHeadlines = newsArticles.slice(0, 3).map((a) => a.title);
  const now = Date.now();
  const breakingNews = newsArticles.some((a) => {
    const published = new Date(a.publishedAt).getTime();
    return now - published < 24 * 60 * 60 * 1000;
  });

  // Trends
  const searchTrendSpike = trends.spike;
  const searchTrendValue = trends.value;

  // NOTE A1: whalePosYesPct is derived from market price (Gamma yesProbability) — NOT actual whale order data.
  // True whale tracking requires on-chain wallet analysis (future enhancement).
  const whalePosYesPct = Math.round(marketData.yesProbability * 100);
  const whalePositioning: "LONG" | "SHORT" | "NEUTRAL" | "MIXED" =
    whalePosYesPct > 60 ? "LONG" : whalePosYesPct < 40 ? "SHORT" : "NEUTRAL";

  // Data sufficiency
  const dataSufficiency = computeDataSufficiency(social.resultCount, 0, newsArticles.length);

  // Confidence
  // Confidence cap: 0.40 + dataSufficiency*0.45 prevents overconfidence when data is thin
  let confidence = Math.min(0.40 + dataSufficiency * 0.45, dataSufficiency + 0.15);
  if (social.resultCount < 3) confidence = Math.min(confidence, 0.35);
  if (newsArticles.length === 0) confidence = Math.min(confidence - 0.1, 0.30);

  // Weight computation based on category
  const cat = market.category?.toLowerCase() || "default";
  const weights = WEIGHTS[cat as keyof typeof WEIGHTS] || WEIGHTS.default;

  const tBiasScore = 0; // telegram always unavailable
  const nScore = breakingNews ? 0.5 : 0;
  const trScore = searchTrendSpike ? 0.5 : 0;

  const totalWeight = weights.twitter + weights.telegram + weights.news + weights.trends;
  const sentimentDelta = (
    (twitterSentiment * weights.twitter) +
    (tBiasScore * weights.telegram) +
    (nScore * weights.news) +
    (trScore * weights.trends)
  ) / totalWeight;

  const shiftDetected = Math.abs(sentimentDelta) > 0.15;
  const shiftDirection = sentimentDelta > 0.15 ? "YES" : sentimentDelta < -0.15 ? "NO" : "NEUTRAL";

  // Historical data
  const db = getDb();
  const lastRuns = db.prepare<[string], { sentiment_delta: number; shift_direction: string; scored_at: number }>(
    `SELECT sentiment_delta, shift_direction, scored_at FROM aura_results
     WHERE slug = ? ORDER BY scored_at DESC LIMIT 3`
  ).all(market.slug);

  const baselineRun = lastRuns.length > 0 ? lastRuns[lastRuns.length - 1] : null;
  const hoursSinceBaseline = baselineRun ? Math.max((Date.now() - baselineRun.scored_at) / (1000 * 60 * 60), 1.0) : 1.0;

  const shiftVelocity = sentimentDelta / hoursSinceBaseline;
  let shiftPersistence = 0;

  for (const run of lastRuns) {
    if (run.shift_direction === shiftDirection) {
      shiftPersistence++;
    } else {
      break;
    }
  }

  let shiftTrend: "ACCELERATING" | "STEADY" | "DECELERATING" | "REVERSING" = "STEADY";
  if (lastRuns.length > 0) {
    const prevDelta = lastRuns[0].sentiment_delta;
    if (Math.sign(prevDelta) !== Math.sign(sentimentDelta) && shiftDirection !== "NEUTRAL") {
      shiftTrend = "REVERSING";
    } else if (Math.abs(sentimentDelta) > Math.abs(prevDelta)) {
      shiftTrend = "ACCELERATING";
    } else if (Math.abs(sentimentDelta) < Math.abs(prevDelta)) {
      shiftTrend = "DECELERATING";
    }
  }

  const echoChamberRisk = Math.abs(twitterSentiment) > 0.7 ? 0.8 - (dataSufficiency * 0.3) : 0.3;

  const result: AuraResult = {
    marketSlug: market.slug,
    scoredAt: Date.now(),
    sentimentDelta,
    shiftDetected,
    shiftDirection,
    shiftVelocity,
    shiftTrend,
    shiftPersistence,
    twitterSentiment,
    twitterVolumeDelta,
    telegramBias,
    breakingNews,
    newsHeadlines,
    searchTrendSpike,
    searchTrendValue,
    whalePosYesPct,
    whalePositioning,
    echoChamberRisk,
    dataSufficiency,
    confidence,
    sourcesUsed,
    sourceStatus,
  };

  // Persist
  db.prepare(`
    INSERT INTO aura_results (
      slug, scored_at, sentiment_delta, shift_detected, shift_direction, shift_velocity, shift_trend,
      shift_persistence, twitter_sentiment, twitter_volume_delta, telegram_bias, breaking_news,
      news_headlines, search_trend_spike, search_trend_value, whale_pos_yes_pct, whale_positioning,
      echo_chamber_risk, data_sufficiency, confidence, sources_used, source_status, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.marketSlug, result.scoredAt, result.sentimentDelta, result.shiftDetected ? 1 : 0,
    result.shiftDirection, result.shiftVelocity, result.shiftTrend, result.shiftPersistence,
    result.twitterSentiment, result.twitterVolumeDelta, result.telegramBias, result.breakingNews ? 1 : 0,
    JSON.stringify(result.newsHeadlines), result.searchTrendSpike ? 1 : 0, result.searchTrendValue,
    result.whalePosYesPct, result.whalePositioning, result.echoChamberRisk, result.dataSufficiency,
    result.confidence, JSON.stringify(result.sourcesUsed), JSON.stringify(result.sourceStatus),
    JSON.stringify(result)
  );

  return result;
}

function computeDataSufficiency(socialLen: number, telegramLen: number, newsLen: number): number {
  let score = 0;
  if (socialLen >= 5) score += 0.4;
  else if (socialLen > 0) score += 0.2;

  if (telegramLen >= 5) score += 0.3;
  if (newsLen > 0) score += 0.3;

  return Math.min(score, 1.0);
}

function getMockResult(slug: string): AuraResult {
  const result: AuraResult = {
    marketSlug: slug,
    scoredAt: Date.now(),
    sentimentDelta: 0.23,
    shiftDetected: true,
    shiftDirection: "YES",
    shiftVelocity: 0.05,
    shiftTrend: "ACCELERATING",
    shiftPersistence: 2,
    twitterSentiment: 0.41,
    twitterVolumeDelta: 0.15,
    telegramBias: "BULLISH",
    breakingNews: true,
    newsHeadlines: ["House Democrats push impeachment vote...", "Market rallies on news"],
    searchTrendSpike: true,
    searchTrendValue: 87,
    whalePosYesPct: 65,
    whalePositioning: "LONG",
    echoChamberRisk: 0.3,
    dataSufficiency: 0.9,
    confidence: 0.85,
    sourcesUsed: ["twitter", "googlenews", "trends", "leaderboard"],
    sourceStatus: {
      twitter: "ok", telegram: "timeout", news: "ok", trends: "ok", leaderboard: "ok",
    },
  };

  const db = getDb();
  db.prepare(`
    INSERT INTO aura_results (
      slug, scored_at, sentiment_delta, shift_detected, shift_direction, shift_velocity, shift_trend,
      shift_persistence, twitter_sentiment, twitter_volume_delta, telegram_bias, breaking_news,
      news_headlines, search_trend_spike, search_trend_value, whale_pos_yes_pct, whale_positioning,
      echo_chamber_risk, data_sufficiency, confidence, sources_used, source_status, raw_data, is_mock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    result.marketSlug, result.scoredAt, result.sentimentDelta, result.shiftDetected ? 1 : 0,
    result.shiftDirection, result.shiftVelocity, result.shiftTrend, result.shiftPersistence,
    result.twitterSentiment, result.twitterVolumeDelta, result.telegramBias, result.breakingNews ? 1 : 0,
    JSON.stringify(result.newsHeadlines), result.searchTrendSpike ? 1 : 0, result.searchTrendValue,
    result.whalePosYesPct, result.whalePositioning, result.echoChamberRisk, result.dataSufficiency,
    result.confidence, JSON.stringify(result.sourcesUsed), JSON.stringify(result.sourceStatus),
    JSON.stringify(result)
  );

  return result;
}
