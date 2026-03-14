import { getDb } from "../db/schema";
import { extractMainKeyword } from "./keywords";
import { fetchGNews } from "./gnews";
import { fetchGuardian } from "./guardian";
import { fetchNYT } from "./nyt";
import { fetchCoinDesk } from "./coindesk";
import { fetchHackerNews, scoreHNSentiment } from "./hackernews";
import { fetchCryptoPanic, scoreCryptoPanic } from "./cryptopanic";

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
  newsArticles: { title: string; url: string; source: string }[];
  searchTrendSpike: boolean;
  searchTrendValue: number;
  whalePosYesPct: number;
  whalePositioning: "LONG" | "SHORT" | "NEUTRAL" | "MIXED";
  echoChamberRisk: number;
  dataSufficiency: number;
  confidence: number;
  sourcesUsed: string[];
  sourceStatus: Record<string, "ok" | "unavailable" | "timeout">;
  summary: string;
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
  crypto: parseWeights(process.env.AURA_WEIGHTS_CRYPTO, { social: 2, cryptopanic: 3, news: 1, trends: 1 }),
  political: parseWeights(process.env.AURA_WEIGHTS_POLITICAL, { social: 1, cryptopanic: 0, news: 2, trends: 1 }),
  sports: parseWeights(process.env.AURA_WEIGHTS_SPORTS, { social: 1, cryptopanic: 0, news: 1, trends: 2 }),
  default: parseWeights(process.env.AURA_WEIGHTS_DEFAULT, { social: 1, cryptopanic: 1, news: 1, trends: 1 }),
};

async function runWithTimeout<T>(promise: Promise<T>, ms: number = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Market data cache TTL: 10 mins
let marketDataCache: { data: { yesProbability: number; volume24h: number }; slug: string; timestamp: number } | null = null;
const MARKET_CACHE_TTL = 10 * 60 * 1000;

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

// Aggregate news from GNews + Guardian + NYT + CoinDesk in parallel, deduplicated
// Small stagger between API calls to reduce concurrent rate-limit hits
const stagger = (ms: number) => new Promise((r) => setTimeout(r, ms));

type NewsArticle = { title: string; publishedAt: string; source?: string; description?: string; url?: string };
type NewsSourceFetchStatus = "ok" | "empty" | "error";

interface FetchAllNewsResult {
  articles: NewsArticle[];
  perSource: {
    gnews: NewsSourceFetchStatus;
    guardian: NewsSourceFetchStatus;
    nyt: NewsSourceFetchStatus;
    coindesk: NewsSourceFetchStatus;
  };
}

// Simple in-memory news cache: query → {articles, perSource, ts}
const newsCache = new Map<string, { data: FetchAllNewsResult; ts: number }>();
const NEWS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function fetchAllNews(query: string): Promise<FetchAllNewsResult> {
  const cacheKey = query.toLowerCase().trim();
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NEWS_CACHE_TTL) {
    return cached.data;
  }

  const [gnews, guardian, nyt, coindesk] = await Promise.allSettled([
    fetchGNews(query, { maxResults: 10, periodDays: 7 }),
    stagger(300).then(() => fetchGuardian(query, { maxResults: 10, daysBack: 7 })),
    stagger(600).then(() => fetchNYT(query, { maxResults: 10, daysBack: 7 })),
    stagger(900).then(() => fetchCoinDesk(query, { maxResults: 10 })),
  ]);

  const articles: NewsArticle[] = [];
  const seen = new Set<string>();

  const add = (items: { title: string; publishedAt: string; source?: string; description?: string; snippet?: string; url?: string }[]) => {
    for (const a of items) {
      const key = a.title.toLowerCase().slice(0, 60);
      if (!seen.has(key)) {
        seen.add(key);
        articles.push({
          title: a.title,
          publishedAt: a.publishedAt,
          source: a.source,
          description: (a as any).description || (a as any).snippet || "",
          url: a.url,
        });
      }
    }
  };

  const status = (r: PromiseSettledResult<{ title: string }[]>): "ok" | "empty" | "error" =>
    r.status === "rejected" ? "error" : r.value.length > 0 ? "ok" : "empty";

  if (gnews.status === "fulfilled") add(gnews.value);
  if (guardian.status === "fulfilled") add(guardian.value);
  if (nyt.status === "fulfilled") add(nyt.value);
  if (coindesk.status === "fulfilled") add(coindesk.value);

  const result: FetchAllNewsResult = {
    articles,
    perSource: {
      gnews: status(gnews),
      guardian: status(guardian),
      nyt: status(nyt),
      coindesk: status(coindesk),
    },
  };

  if (articles.length > 0) {
    newsCache.set(cacheKey, { data: result, ts: Date.now() });
  }

  return result;
}

export async function runAura(market: { slug: string; question: string; category?: string }): Promise<AuraResult> {
  if (process.env.AURA_MOCK === "true") {
    return getMockResult(market.slug);
  }

  const sourceStatus: Record<string, "ok" | "unavailable" | "timeout"> = {};
  const sourcesUsed: string[] = [];
  const cat = market.category?.toLowerCase() || "default";
  const isCrypto = cat === "crypto";

  // --- Market data (cached) ---
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

  // --- News: GNews + Guardian + NYT + CoinDesk ---
  let sharedArticles: NewsArticle[] = [];
  let newsPerSource: FetchAllNewsResult["perSource"] = {
    gnews: "error",
    guardian: "error",
    nyt: "error",
    coindesk: "error",
  };
  try {
    const newsResult = await runWithTimeout(fetchAllNews(market.question));
    sharedArticles = newsResult.articles;
    newsPerSource = newsResult.perSource;
    if (sharedArticles.length === 0) {
      const shortQuery = market.question.split(" ").filter((w) => w.length > 3).slice(0, 3).join(" ");
      if (shortQuery) {
        const retry = await runWithTimeout(fetchAllNews(shortQuery));
        sharedArticles = retry.articles;
        // Merge per-source: upgrade "empty" → "ok" if retry found data
        if (retry.perSource.gnews === "ok") newsPerSource.gnews = "ok";
        if (retry.perSource.guardian === "ok") newsPerSource.guardian = "ok";
        if (retry.perSource.nyt === "ok") newsPerSource.nyt = "ok";
        if (retry.perSource.coindesk === "ok") newsPerSource.coindesk = "ok";
      }
    }
  } catch {
    // timeout — sharedArticles stays empty, perSource stays "error"
  }

  const fetchNewsData = async () => {
    // Track per-source status from the actual API calls
    const mapStatus = (s: "ok" | "empty" | "error"): "ok" | "unavailable" | "timeout" =>
      s === "ok" ? "ok" : s === "empty" ? "unavailable" : "timeout";

    sourceStatus["gnews"] = mapStatus(newsPerSource.gnews);
    sourceStatus["guardian"] = mapStatus(newsPerSource.guardian);
    sourceStatus["nyt"] = mapStatus(newsPerSource.nyt);
    sourceStatus["coindesk"] = mapStatus(newsPerSource.coindesk);

    if (newsPerSource.gnews === "ok") { if (!sourcesUsed.includes("gnews")) sourcesUsed.push("gnews"); }
    if (newsPerSource.guardian === "ok") { if (!sourcesUsed.includes("guardian")) sourcesUsed.push("guardian"); }
    if (newsPerSource.nyt === "ok") { if (!sourcesUsed.includes("nyt")) sourcesUsed.push("nyt"); }
    if (newsPerSource.coindesk === "ok") { if (!sourcesUsed.includes("coindesk")) sourcesUsed.push("coindesk"); }

    return sharedArticles;
  };

  // --- HN social sentiment ---
  const fetchHNSentiment = async () => {
    const keyword = market.question.split(" ").filter((w) => w.length > 3).slice(0, 4).join(" ");
    const stories = await fetchHackerNews(keyword, { maxResults: 15, daysBack: 7 });
    const result = scoreHNSentiment(stories);
    if (result.resultCount > 0) {
      sourceStatus["hackernews"] = "ok";
      sourcesUsed.push("hackernews");
    } else {
      sourceStatus["hackernews"] = "unavailable";
    }
    return result;
  };

  // --- CryptoPanic sentiment (crypto markets or general) ---
  const fetchCPSentiment = async () => {
    if (!process.env.CRYPTOPANIC_API_KEY) {
      sourceStatus["cryptopanic"] = "unavailable";
      return { score: 0, resultCount: 0 };
    }
    const posts = await fetchCryptoPanic({ filter: isCrypto ? "hot" : "important", maxResults: 20 });
    const result = scoreCryptoPanic(posts);
    if (result.resultCount > 0) {
      sourceStatus["cryptopanic"] = "ok";
      sourcesUsed.push("cryptopanic");
    } else {
      sourceStatus["cryptopanic"] = "unavailable";
    }
    return result;
  };

  // --- Trends: GNews 7d vs 30d ratio ---
  const fetchTrends = async () => {
    try {
      const keywords = market.question.split(" ").filter((w) => w.length > 3).slice(0, 3).join(" ");
      const [recent, older] = await Promise.all([
        fetchGNews(keywords, { maxResults: 20, periodDays: 7 }),
        fetchGNews(keywords, { maxResults: 20, periodDays: 30 }),
      ]);

      if (older.length === 0) {
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

      const ratio = recent.length / older.length;
      const value = Math.min(100, Math.round(ratio * 50));
      const spike = ratio > 1.5;
      sourceStatus["trends"] = "ok";
      if (!sourcesUsed.includes("trends")) sourcesUsed.push("trends");
      return { spike, value };
    } catch {
      sourceStatus["trends"] = "unavailable";
      return { spike: false, value: 0 };
    }
  };

  sourceStatus["telegram"] = "unavailable";

  const [newsRes, hnRes, cpRes, trendsRes, marketRes] = await Promise.allSettled([
    runWithTimeout(fetchNewsData()),
    runWithTimeout(fetchHNSentiment()),
    runWithTimeout(fetchCPSentiment()),
    runWithTimeout(fetchTrends()),
    runWithTimeout(fetchMarketDataCached()),
  ]);

  const newsArticles = newsRes.status === "fulfilled" ? newsRes.value : [];
  const hn = hnRes.status === "fulfilled" ? hnRes.value : { score: 0, resultCount: 0 };
  const cp = cpRes.status === "fulfilled" ? cpRes.value : { score: 0, resultCount: 0 };
  const trends = trendsRes.status === "fulfilled" ? trendsRes.value : { spike: false, value: 50 };
  const marketData = marketRes.status === "fulfilled" ? marketRes.value : { yesProbability: 0.5, volume24h: 0 };

  if (newsRes.status === "rejected") {
    sourceStatus["guardian"] = "timeout";
    sourceStatus["nyt"] = "timeout";
    sourceStatus["gnews"] = "timeout";
    sourceStatus["coindesk"] = "timeout";
    sourceStatus["news"] = "timeout";
  }
  if (hnRes.status === "rejected") sourceStatus["hackernews"] = "timeout";
  if (cpRes.status === "rejected") sourceStatus["cryptopanic"] = "timeout";
  if (trendsRes.status === "rejected") sourceStatus["trends"] = "timeout";
  if (marketRes.status === "rejected") sourceStatus["leaderboard"] = "timeout";

  // --- Social sentiment: weighted HN + CryptoPanic ---
  const weights = WEIGHTS[cat as keyof typeof WEIGHTS] || WEIGHTS.default;
  const hnWeight = weights.social ?? 1;
  const cpWeight = (weights.cryptopanic ?? 1);
  const socialDenominator = (hn.resultCount > 0 ? hnWeight : 0) + (cp.resultCount > 0 ? cpWeight : 0) || 1;
  const twitterSentiment = (
    (hn.resultCount > 0 ? hn.score * hnWeight : 0) +
    (cp.resultCount > 0 ? cp.score * cpWeight : 0)
  ) / socialDenominator;
  const twitterVolumeDelta = 0;

  const telegramBias: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNAVAILABLE" = "UNAVAILABLE";

  // --- News headlines ---
  const newsHeadlines = newsArticles.slice(0, 5).map((a) => a.title);
  const now = Date.now();
  const breakingNews = newsArticles.some((a) => {
    const published = new Date(a.publishedAt).getTime();
    return now - published < 24 * 60 * 60 * 1000;
  });

  const searchTrendSpike = trends.spike;
  const searchTrendValue = trends.value;

  const whalePosYesPct = Math.round(marketData.yesProbability * 100);
  const whalePositioning: "LONG" | "SHORT" | "NEUTRAL" | "MIXED" =
    whalePosYesPct > 60 ? "LONG" : whalePosYesPct < 40 ? "SHORT" : "NEUTRAL";

  const socialCount = hn.resultCount + cp.resultCount;
  const dataSufficiency = computeDataSufficiency(socialCount, newsArticles.length);

  let confidence = Math.min(0.40 + dataSufficiency * 0.45, dataSufficiency + 0.15);
  if (socialCount < 3) confidence = Math.min(confidence, 0.35);
  if (newsArticles.length === 0) confidence = Math.min(confidence - 0.1, 0.30);

  const nScore = breakingNews ? 0.5 : 0;
  const trScore = searchTrendSpike ? 0.5 : 0;
  const newsWeight = weights.news ?? 1;
  const trendsWeight = weights.trends ?? 1;
  const totalWeight = hnWeight + cpWeight + newsWeight + trendsWeight;

  const sentimentDelta = (
    (twitterSentiment * (hnWeight + cpWeight)) +
    (nScore * newsWeight) +
    (trScore * trendsWeight)
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
  const hoursSinceBaseline = baselineRun
    ? Math.max((Date.now() - baselineRun.scored_at) / (1000 * 60 * 60), 1.0)
    : 1.0;

  const shiftVelocity = sentimentDelta / hoursSinceBaseline;
  let shiftPersistence = 0;
  for (const run of lastRuns) {
    if (run.shift_direction === shiftDirection) shiftPersistence++;
    else break;
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

  const echoChamberRisk = Math.abs(twitterSentiment) > 0.7 ? 0.8 - dataSufficiency * 0.3 : 0.3;

  const mappedArticles = newsArticles.slice(0, 5).map((a) => ({
    title: a.title,
    url: a.url ?? "",
    source: a.source ?? "",
  }));

  const partialResult: Omit<AuraResult, "summary"> = {
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
    newsArticles: mappedArticles,
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

  const result: AuraResult = {
    ...partialResult,
    summary: generateSummary(partialResult),
  };

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

function generateSummary(result: Omit<AuraResult, "summary">): string {
  const parts: string[] = [];

  // Sentiment direction
  const delta = result.sentimentDelta;
  if (delta >= 0.5) parts.push("Strong bullish sentiment detected");
  else if (delta >= 0.15) parts.push("Moderately bullish sentiment detected");
  else if (delta <= -0.5) parts.push("Strong bearish sentiment detected");
  else if (delta <= -0.15) parts.push("Moderately bearish sentiment detected");
  else parts.push("Neutral sentiment");

  // News activity
  const newsCount = result.newsArticles.length;
  if (result.breakingNews && newsCount > 0) {
    parts.push(`breaking news from ${newsCount} source${newsCount > 1 ? "s" : ""}`);
  } else if (newsCount > 0) {
    parts.push(`${newsCount} recent article${newsCount > 1 ? "s" : ""} found`);
  } else {
    parts.push("no recent news coverage");
  }

  // Social signals
  if (result.twitterSentiment > 0.3) parts.push("social signals bullish");
  else if (result.twitterSentiment < -0.3) parts.push("social signals bearish");

  // Trend
  if (result.searchTrendSpike) parts.push("search trend spiking");

  // Shift dynamics
  if (result.shiftDetected) {
    parts.push(`shift ${result.shiftDirection.toLowerCase()} (${result.shiftTrend.toLowerCase()})`);
  }

  // Echo chamber warning
  if (result.echoChamberRisk > 0.6) parts.push("echo chamber risk elevated");

  // Whale positioning
  if (result.whalePositioning !== "NEUTRAL") {
    parts.push(`whales positioned ${result.whalePositioning.toLowerCase()}`);
  }

  // Data quality
  if (result.dataSufficiency < 0.3) parts.push("limited data available");

  // Confidence
  parts.push(`confidence ${Math.round(result.confidence * 100)}%`);

  // Join: first part is a sentence, rest are comma-separated clauses
  return parts[0] + (parts.length > 1 ? " — " + parts.slice(1).join(", ") : "") + ".";
}

function computeDataSufficiency(socialCount: number, newsCount: number): number {
  let score = 0;
  if (socialCount >= 10) score += 0.4;
  else if (socialCount >= 3) score += 0.25;
  else if (socialCount > 0) score += 0.1;

  if (newsCount >= 5) score += 0.4;
  else if (newsCount >= 2) score += 0.25;
  else if (newsCount > 0) score += 0.15;

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
    newsArticles: [
      { title: "House Democrats push impeachment vote...", url: "", source: "The Guardian" },
      { title: "Market rallies on news", url: "", source: "NYT" },
    ],
    searchTrendSpike: true,
    searchTrendValue: 87,
    whalePosYesPct: 65,
    whalePositioning: "LONG",
    echoChamberRisk: 0.3,
    dataSufficiency: 0.9,
    confidence: 0.85,
    sourcesUsed: ["hackernews", "cryptopanic", "guardian", "nyt", "gnews", "coindesk", "trends", "leaderboard"],
    sourceStatus: {
      hackernews: "ok", cryptopanic: "ok", guardian: "ok", nyt: "ok",
      coindesk: "ok",
      gnews: "ok", trends: "ok", leaderboard: "ok", telegram: "unavailable",
    },
    summary: "Moderately bullish sentiment detected — breaking news from 2 sources, social signals bullish, search trend spiking, shift yes (accelerating), whales positioned long, confidence 85%.",
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
