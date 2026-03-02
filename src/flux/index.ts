// src/flux/index.ts - Flux Liquidity Agent
// CLI primary → graceful degradation (empty book → Grade D) — no CLOB API
import { runCli } from "../cli";
import { getDb } from "../db/schema";

export interface FluxResult {
  marketSlug: string;
  scoredAt: number;
  liquidity_grade: "A" | "B" | "C" | "D";
  spread: number;
  slippage_10: number;
  slippage_50: number;
  whale_detected: boolean;
  whale_signals: number;
  depth_imbalance: number;
  depth_yes_pct: number;
  grade_degrading: boolean;
  soft_veto: boolean;
  total_liquidity: number;
  confidence: number;
  data_source: "cli" | "api" | "mock";
}

interface OrderbookLevel {
  price: string | number;
  size: string | number;
}

interface OrderbookData {
  bids?: OrderbookLevel[];
  asks?: OrderbookLevel[];
}

// ── Fetch orderbook: CLI only (no CLOB API) ────────────────────
// Per architecture decision: Polymarket CLI is the sole data source.
// If CLI fails (token unavailable, network), degrade gracefully to empty book.

async function fetchOrderbook(tokenId: string): Promise<{ book: OrderbookData | null; source: "cli" | "api"; reason?: string }> {
  if (!tokenId) {
    return { book: null, source: "cli", reason: "no_token_id" };
  }

  // Try CLOB REST API directly (public endpoint, no auth needed)
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      // CLOB API returns { bids: [{price, size},...], asks: [{price, size},...] }
      const book: OrderbookData = {
        bids: data.bids || [],
        asks: data.asks || [],
      };
      return { book, source: "api" };
    }
  } catch (err) {
    console.warn(`[Flux] CLOB REST failed for ${tokenId}: ${(err as Error).message}`);
  }

  // Fallback: try CLI
  try {
    const raw = await runCli(["clob", "book", tokenId]);
    return { book: raw as OrderbookData, source: "cli" };
  } catch (err) {
    console.warn(`[Flux] CLI orderbook also failed for ${tokenId}: ${(err as Error).message}`);
    return { book: { bids: [], asks: [] }, source: "cli", reason: "cli_error" };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function parseLevels(levels: OrderbookLevel[] | undefined): { price: number; size: number }[] {
  if (!levels || !Array.isArray(levels)) return [];
  return levels.map((l) => ({
    price: Number(l.price),
    size: Number(l.size),
  }));
}

function totalDepth(levels: { price: number; size: number }[]): number {
  return levels.reduce((s, l) => s + l.size, 0);
}

function computeSlippage(
  levels: { price: number; size: number }[],
  targetUsd: number
): number {
  if (levels.length === 0) return 0;
  const bestPrice = levels[0].price;
  let remaining = targetUsd;
  let totalCost = 0;

  for (const l of levels) {
    const fillAmt = Math.min(remaining, l.size);
    totalCost += fillAmt * l.price;
    remaining -= fillAmt;
    if (remaining <= 0) break;
  }

  const filled = targetUsd - remaining;
  if (filled === 0) return 0;
  const avgPrice = totalCost / filled;
  return Math.abs(avgPrice - bestPrice) * 100; // percentage
}

function gradeLiquidity(depth: number): "A" | "B" | "C" | "D" {
  if (depth > 50_000) return "A";
  if (depth > 10_000) return "B";
  if (depth > 1_000) return "C";
  return "D";
}

function detectWhales(
  levels: { price: number; size: number }[],
  totalBookDepth: number
): { detected: boolean; count: number } {
  let count = 0;
  for (const l of levels) {
    if (l.size > 500 && totalBookDepth > 0 && l.size / totalBookDepth > 0.05) {
      count++;
    }
  }
  return { detected: count > 0, count };
}

function checkGradeDegrading(slug: string, currentGrade: string): boolean {
  const db = getDb();
  const gradeOrder: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };
  const rows = db
    .prepare(
      "SELECT liquidity_grade FROM flux_results WHERE marketSlug = ? ORDER BY scoredAt DESC LIMIT 3"
    )
    .all(slug) as { liquidity_grade: string }[];

  if (rows.length < 2) return false;

  const prev = gradeOrder[rows[0].liquidity_grade] ?? 0;
  const curr = gradeOrder[currentGrade] ?? 0;
  return curr < prev;
}

// ── Main entry point ─────────────────────────────────────────

export async function runFlux(market: { slug: string; token_id?: string; tokenID?: string }): Promise<FluxResult> {
  const scoredAt = Date.now();
  const slug = market.slug;
  const tokenId = market.token_id || market.tokenID || "";

  // Mock mode
  if (process.env.FLUX_MOCK === "true") {
    const mock: FluxResult = {
      marketSlug: slug,
      scoredAt,
      liquidity_grade: "B",
      spread: 2.5,
      slippage_10: 0.3,
      slippage_50: 1.2,
      whale_detected: false,
      whale_signals: 0,
      depth_imbalance: 0.52,
      depth_yes_pct: 0.52,
      grade_degrading: false,
      soft_veto: false,
      total_liquidity: 25000,
      confidence: 0.7,
      data_source: "mock",
    };
    persist(mock);
    return mock;
  }

  // Live mode
  const gammaLiquidity = (market as any).liquidity ?? 0;

  // If genuinely illiquid by Gamma data
  if (gammaLiquidity < 500 && !tokenId) {
    const result: FluxResult = {
      marketSlug: slug, scoredAt, liquidity_grade: "D", spread: 100,
      slippage_10: 0, slippage_50: 0, whale_detected: false, whale_signals: 0,
      depth_imbalance: 0, depth_yes_pct: 0.5, grade_degrading: false,
      soft_veto: true, total_liquidity: gammaLiquidity, confidence: 0.1,
      data_source: "mock",
    };
    persist(result); return result;
  }

  const { book, source: bookSource, reason } = await fetchOrderbook(tokenId);

  // tokenId missing but market may have liquidity — grade C, no veto
  if (book === null && reason === "no_token_id") {
    const result: FluxResult = {
      marketSlug: slug, scoredAt, liquidity_grade: "C", spread: 3.0,
      slippage_10: 1.0, slippage_50: 2.5, whale_detected: false, whale_signals: 0,
      depth_imbalance: 0, depth_yes_pct: 0.5, grade_degrading: false,
      soft_veto: false, total_liquidity: gammaLiquidity, confidence: 0.4,
      data_source: "mock",
    };
    persist(result); return result;
  }

  const safeBook = book ?? { bids: [], asks: [] };
  const bids = parseLevels(safeBook.bids);
  const asks = parseLevels(safeBook.asks);

  // Sort: bids descending, asks ascending
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  const bidDepth = totalDepth(bids);
  const askDepth = totalDepth(asks);
  const total = bidDepth + askDepth;

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const spread = (bestAsk - bestBid) * 100; // percentage

  const slippage_10 = computeSlippage(asks, 10);
  const slippage_50 = computeSlippage(asks, 50);

  const liquidity_grade = gradeLiquidity(total);

  const allLevels = [...bids, ...asks];
  const { detected: whale_detected, count: whale_signals } = detectWhales(allLevels, total);

  // Depth imbalance: bid-side as "yes" depth
  const depth_yes_pct = total > 0 ? bidDepth / total : 0.5;
  const depth_imbalance = Math.abs(depth_yes_pct - 0.5) * 2; // 0 = balanced, 1 = fully skewed

  const grade_degrading = checkGradeDegrading(slug, liquidity_grade);

  const soft_veto = liquidity_grade === "D" || spread > 5;

  // Confidence: higher liquidity & tighter spread → more confident
  const confidence = Math.min(1, Math.max(0.1, 1 - spread / 20)) * (liquidity_grade === "D" ? 0.3 : liquidity_grade === "C" ? 0.6 : 0.9);

  const result: FluxResult = {
    marketSlug: slug,
    scoredAt,
    liquidity_grade,
    spread: Math.round(spread * 100) / 100,
    slippage_10: Math.round(slippage_10 * 100) / 100,
    slippage_50: Math.round(slippage_50 * 100) / 100,
    whale_detected,
    whale_signals,
    depth_imbalance: Math.round(depth_imbalance * 1000) / 1000,
    depth_yes_pct: Math.round(depth_yes_pct * 1000) / 1000,
    grade_degrading,
    soft_veto,
    total_liquidity: Math.round(total * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    data_source: bookSource,
  };

  persist(result);
  return result;
}

function persist(result: FluxResult): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO flux_results (
      marketSlug, scoredAt, liquidity_grade, spread, slippage_10, slippage_50,
      whale_detected, whale_signals, depth_imbalance, depth_yes_pct,
      grade_degrading, soft_veto, total_liquidity, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.marketSlug, result.scoredAt, result.liquidity_grade, result.spread,
    result.slippage_10, result.slippage_50,
    result.whale_detected ? 1 : 0, result.whale_signals,
    result.depth_imbalance, result.depth_yes_pct,
    result.grade_degrading ? 1 : 0, result.soft_veto ? 1 : 0,
    result.total_liquidity, result.confidence
  );
}
