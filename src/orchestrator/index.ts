import { getDb } from "../db/schema";

// ── Types ──────────────────────────────────────────────────────

export interface MarketScore {
  slug: string;
  tokenId: string;
  question: string;
  opportunityScore: number;
  components: {
    volume: number;
    priceMove: number;
    liquidity: number;
    recency: number;
  };
  triggers: string[];
  scoredAt: number;
}

export interface OrchestratorState {
  lastScanAt: number;
  nextScanAt: number;
  marketsScanned: number;
  candidatesFound: number;
  scanIntervalMs: number;
  status: "idle" | "scanning";
  scanCycle: number;
}

// ── Constants ──────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (aggressive mode)
export const SCAN_COOLDOWN_MS = 30 * 1000; // 30s cooldown for manual scans
const TOP_N = 20;
const MIN_SCORE = 15;
const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const PRICE_SNAPSHOT_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── Scoring weights ────────────────────────────────────────────

const W_VOLUME = 0.35;
const W_PRICE_MOVE = 0.30;
const W_LIQUIDITY = 0.20;
const W_RECENCY = 0.15;

// ── State ──────────────────────────────────────────────────────

function loadPersistedState(): Omit<OrchestratorState, "nextScanAt" | "scanIntervalMs" | "status"> {
  try {
    const db = getDb();
    const row = db
      .prepare<[], { last_scan_at: number; markets_scanned: number; candidates_found: number; scan_cycle: number }>(
        "SELECT last_scan_at, markets_scanned, candidates_found, scan_cycle FROM orchestrator_scan_state WHERE id = 1"
      )
      .get();
    if (row) {
      return {
        lastScanAt: row.last_scan_at,
        marketsScanned: row.markets_scanned,
        candidatesFound: row.candidates_found,
        scanCycle: row.scan_cycle,
      };
    }
  } catch { /* table may not exist yet on first boot */ }
  return { lastScanAt: 0, marketsScanned: 0, candidatesFound: 0, scanCycle: 0 };
}

function persistState(): void {
  try {
    const db = getDb();
    db.prepare(
      "UPDATE orchestrator_scan_state SET last_scan_at = ?, markets_scanned = ?, candidates_found = ?, scan_cycle = ? WHERE id = 1"
    ).run(state.lastScanAt, state.marketsScanned, state.candidatesFound, state.scanCycle);
  } catch (err) {
    console.error("[orchestrator] Failed to persist state:", err);
  }
}

const persisted = loadPersistedState();
let state: OrchestratorState = {
  lastScanAt: persisted.lastScanAt,
  nextScanAt: persisted.lastScanAt > 0
    ? persisted.lastScanAt + SCAN_INTERVAL_MS
    : Date.now() + SCAN_INTERVAL_MS,
  marketsScanned: persisted.marketsScanned,
  candidatesFound: persisted.candidatesFound,
  scanIntervalMs: SCAN_INTERVAL_MS,
  status: "idle",
  scanCycle: persisted.scanCycle,
};

let scanTimer: ReturnType<typeof setInterval> | null = null;

// ── Gamma API types ────────────────────────────────────────────

interface GammaMarket {
  slug?: string;
  conditionId?: string;
  question?: string;
  outcomePrices?: string;
  volume24hr?: number;
  volume?: number;
  liquidity?: number;
  createdAt?: string;
  startDate?: string;
  [key: string]: unknown;
}

// ── Scoring functions ──────────────────────────────────────────

function computeVolumeScore(market: GammaMarket): number {
  const vol = market.volume24hr ?? market.volume ?? 0;
  const slug = market.slug ?? market.conditionId ?? "";

  // Check for volume spike by comparing to previous snapshot
  if (slug) {
    try {
      const db = getDb();
      const prev = db
        .prepare<[string], { volume: number }>(
          "SELECT volume FROM market_volume_snapshots WHERE slug = ?"
        )
        .get(slug);
      if (prev && prev.volume > 0) {
        const ratio = vol / prev.volume;
        // >2x volume increase = spike bonus
        if (ratio > 5) return 100;
        if (ratio > 3) return 90;
        if (ratio > 2) return 80;
      }
    } catch { /* table may not exist yet */ }
  }

  // Fallback: absolute volume tiers
  if (vol > 500000) return 100;
  if (vol > 100000) return 80;
  if (vol > 50000) return 60;
  if (vol > 10000) return 40;
  if (vol > 1000) return 20;
  return 5;
}

function computePriceMoveScore(slug: string, currentYesPrice: number): number {
  const db = getDb();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const snapshot = db
    .prepare<[string, number], { yes_price: number }>(
      "SELECT yes_price FROM market_price_snapshots WHERE slug = ? AND snapshot_at >= ? ORDER BY snapshot_at ASC LIMIT 1"
    )
    .get(slug, oneHourAgo);

  if (!snapshot) return 0;
  const delta = Math.abs(currentYesPrice - snapshot.yes_price);
  // 5c move = 100 score
  return Math.min(delta * 2000, 100);
}

function computeLiquidityScore(liquidity: number): number {
  if (liquidity > 50000) return 100;
  if (liquidity > 10000) return 70;
  if (liquidity > 1000) return 40;
  return 10;
}

function computeRecencyScore(createdAt: string | undefined): number {
  if (!createdAt) return 0;
  const created = new Date(createdAt).getTime();
  if (isNaN(created)) return 0;
  const hoursOld = (Date.now() - created) / (1000 * 60 * 60);
  if (hoursOld < 6) return 100;
  if (hoursOld < 24) return 70;
  if (hoursOld < 48) return 40;
  return 0;
}

function parseYesPrice(market: GammaMarket): number {
  try {
    const prices = JSON.parse(market.outcomePrices ?? "[]");
    if (Array.isArray(prices) && prices.length >= 2) {
      return parseFloat(String(prices[1])) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

function detectTriggers(
  market: GammaMarket,
  yesPrice: number,
  priceMoveScore: number,
  volumeScore: number,
  liquidity: number,
  recencyScore: number
): string[] {
  const triggers: string[] = [];

  // Volume spike: score >= 80 from either absolute tier or spike detection
  if (volumeScore >= 80) triggers.push("volume_spike");

  // Sharp price move: >7c in 1hr
  if (priceMoveScore >= 100 * 0.07 * 2000 / 100) {
    // 7c * 2000 = 140 → capped at 100, so check if raw delta > 0.07
    const db = getDb();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const snapshot = db
      .prepare<[string, number], { yes_price: number }>(
        "SELECT yes_price FROM market_price_snapshots WHERE slug = ? AND snapshot_at >= ? ORDER BY snapshot_at ASC LIMIT 1"
      )
      .get(market.slug ?? "", oneHourAgo);
    if (snapshot && Math.abs(yesPrice - snapshot.yes_price) > 0.07) {
      triggers.push("sharp_price_move");
    }
  }

  // New high-liquidity: <48h old AND liquidity > $50k
  if (recencyScore >= 40 && liquidity > 50000) {
    triggers.push("new_high_liquidity");
  }

  return triggers;
}

function scoreMarket(market: GammaMarket): MarketScore | null {
  const slug = market.slug ?? market.conditionId ?? "";
  if (!slug) return null;

  const yesPrice = parseYesPrice(market);
  const liquidity = market.liquidity ?? 0;
  const createdAt = market.createdAt ?? market.startDate;

  const volumeScore = computeVolumeScore(market);
  const priceMoveScore = computePriceMoveScore(slug, yesPrice);
  const liquidityScore = computeLiquidityScore(liquidity);
  const recencyScore = computeRecencyScore(createdAt);

  const opportunityScore =
    volumeScore * W_VOLUME +
    priceMoveScore * W_PRICE_MOVE +
    liquidityScore * W_LIQUIDITY +
    recencyScore * W_RECENCY;

  const triggers = detectTriggers(market, yesPrice, priceMoveScore, volumeScore, liquidity, recencyScore);

  return {
    slug,
    tokenId: market.conditionId ?? "",
    question: market.question ?? "",
    opportunityScore: Math.round(opportunityScore * 10) / 10,
    components: {
      volume: Math.round(volumeScore * 10) / 10,
      priceMove: Math.round(priceMoveScore * 10) / 10,
      liquidity: Math.round(liquidityScore * 10) / 10,
      recency: Math.round(recencyScore * 10) / 10,
    },
    triggers,
    scoredAt: Date.now(),
  };
}

// ── Price snapshot persistence ─────────────────────────────────

function savePriceSnapshots(markets: GammaMarket[]): void {
  const db = getDb();
  const now = Date.now();

  const insert = db.prepare(
    "INSERT OR REPLACE INTO market_price_snapshots (slug, yes_price, snapshot_at) VALUES (?, ?, ?)"
  );

  const tx = db.transaction(() => {
    for (const market of markets) {
      const slug = market.slug ?? market.conditionId ?? "";
      if (!slug) continue;
      const yesPrice = parseYesPrice(market);
      if (yesPrice > 0) {
        insert.run(slug, yesPrice, now);
      }
    }
  });
  tx();

  // Purge snapshots older than 24h
  db.prepare("DELETE FROM market_price_snapshots WHERE snapshot_at < ?").run(
    now - PRICE_SNAPSHOT_TTL
  );
}

function saveVolumeSnapshots(markets: GammaMarket[]): void {
  const db = getDb();
  const now = Date.now();
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO market_volume_snapshots (slug, volume, snapshot_at) VALUES (?, ?, ?)"
  );
  const tx = db.transaction(() => {
    for (const market of markets) {
      const slug = market.slug ?? market.conditionId ?? "";
      const vol = market.volume24hr ?? market.volume ?? 0;
      if (slug && vol > 0) upsert.run(slug, vol, now);
    }
  });
  tx();
}

// ── Candidate persistence ──────────────────────────────────────

function upsertCandidates(candidates: MarketScore[]): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO orchestrator_candidates
      (slug, token_id, question, opportunity_score, volume_score, price_move_score,
       liquidity_score, recency_score, triggers, scored_at, pipeline_triggered, pipeline_triggered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
  `);

  // Clear old candidates before inserting new batch
  db.prepare("DELETE FROM orchestrator_candidates").run();

  const tx = db.transaction(() => {
    for (const c of candidates) {
      upsert.run(
        c.slug,
        c.tokenId,
        c.question,
        c.opportunityScore,
        c.components.volume,
        c.components.priceMove,
        c.components.liquidity,
        c.components.recency,
        JSON.stringify(c.triggers),
        c.scoredAt
      );
    }
  });
  tx();
}

// ── Core scan ──────────────────────────────────────────────────

async function fetchAllMarkets(): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  let offset = 0;
  const limit = 100;

  // Fetch in batches — Gamma API caps at ~100 per page
  while (true) {
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      limit: String(limit),
      offset: String(offset),
    });

    try {
      const res = await fetch(`${GAMMA_MARKETS_URL}?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) break;
      const batch: unknown = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      allMarkets.push(...(batch as GammaMarket[]));
      if (batch.length < limit) break; // last page
      offset += limit;

      // Safety cap — don't fetch more than 10k markets
      if (allMarkets.length >= 10000) break;
    } catch {
      break;
    }
  }

  return allMarkets;
}

export async function runScan(): Promise<{
  marketsScanned: number;
  candidatesFound: number;
}> {
  state.status = "scanning";

  try {
    const markets = await fetchAllMarkets();
    state.marketsScanned = markets.length;

    // Save price snapshots for delta computation (before scoring so current scan has prior data)
    savePriceSnapshots(markets);

    // Score all markets
    const scored: MarketScore[] = [];
    for (const market of markets) {
      const result = scoreMarket(market);
      if (result) scored.push(result);
    }

    // Sort by opportunity score (descending)
    scored.sort((a, b) => b.opportunityScore - a.opportunityScore);

    // Auto-qualify triggered markets, then fill with top-scored
    const triggered = scored.filter((s) => s.triggers.length > 0);
    const nonTriggered = scored.filter(
      (s) => s.triggers.length === 0 && s.opportunityScore >= MIN_SCORE
    );

    // Merge: triggered first, then top non-triggered, cap at TOP_N
    const candidates: MarketScore[] = [];
    const seen = new Set<string>();

    for (const s of triggered) {
      if (candidates.length >= TOP_N) break;
      if (!seen.has(s.slug)) {
        candidates.push(s);
        seen.add(s.slug);
      }
    }
    for (const s of nonTriggered) {
      if (candidates.length >= TOP_N) break;
      if (!seen.has(s.slug)) {
        candidates.push(s);
        seen.add(s.slug);
      }
    }

    // Re-sort final list
    candidates.sort((a, b) => b.opportunityScore - a.opportunityScore);

    // Persist candidates
    upsertCandidates(candidates);

    // Save volume snapshots AFTER scoring so next scan can detect spikes
    saveVolumeSnapshots(markets);

    // Queue Aura runs for the top 5 candidates
    candidates.slice(0, 5).forEach((c) => {
      // Background execution, skip await
      import("../aura/index").then((m) => m.runAura({ slug: c.slug, question: c.question })).catch((err) => {
        console.error(`[orchestrator] Aura run failed for ${c.slug}:`, err);
      });
    });

    state.lastScanAt = Date.now();
    state.nextScanAt = Date.now() + SCAN_INTERVAL_MS;
    state.candidatesFound = candidates.length;
    state.scanCycle += 1;
    state.status = "idle";
    persistState();

    console.log(
      `[orchestrator] Scan #${state.scanCycle}: ${markets.length} markets scanned, ${candidates.length} candidates found`
    );

    return { marketsScanned: markets.length, candidatesFound: candidates.length };
  } catch (err) {
    state.status = "idle";
    console.error("[orchestrator] Scan failed:", err);
    throw err;
  }
}

// ── Public getters ─────────────────────────────────────────────

export function getState(): OrchestratorState {
  return { ...state };
}

interface CandidateRow {
  slug: string;
  token_id: string;
  question: string;
  opportunity_score: number;
  volume_score: number;
  price_move_score: number;
  liquidity_score: number;
  recency_score: number;
  triggers: string;
  scored_at: number;
  pipeline_triggered: number;
  pipeline_triggered_at: number | null;
}

export function getCandidates(): {
  candidates: MarketScore[];
  total: number;
  scanCycle: number;
} {
  const db = getDb();
  const rows = db
    .prepare<[], CandidateRow>(
      "SELECT * FROM orchestrator_candidates ORDER BY opportunity_score DESC"
    )
    .all();

  const candidates: MarketScore[] = rows.map((r) => ({
    slug: r.slug,
    tokenId: r.token_id,
    question: r.question,
    opportunityScore: r.opportunity_score,
    components: {
      volume: r.volume_score,
      priceMove: r.price_move_score,
      liquidity: r.liquidity_score,
      recency: r.recency_score,
    },
    triggers: JSON.parse(r.triggers || "[]"),
    scoredAt: r.scored_at,
  }));

  return {
    candidates,
    total: candidates.length,
    scanCycle: state.scanCycle,
  };
}

// ── Scheduler ──────────────────────────────────────────────────

export function startScheduler(): void {
  if (scanTimer) return; // already running

  console.log(`[orchestrator] Starting scheduler — scan every ${SCAN_INTERVAL_MS/60000} minutes`);

  // Run first scan after a short delay (let the server boot)
  setTimeout(() => {
    runScan().catch((err) =>
      console.error("[orchestrator] Initial scan error:", err)
    );
  }, 5000);

  scanTimer = setInterval(() => {
    runScan().catch((err) =>
      console.error("[orchestrator] Scheduled scan error:", err)
    );
  }, SCAN_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
    console.log("[orchestrator] Scheduler stopped");
  }
}
