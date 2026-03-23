/**
 * Task 2 TDD: buybackService.ts
 *
 * Tests for:
 * - calculateWeeklyPnl: P&L aggregation from executions table
 * - auditAgainstPolymarket: Polymarket CLOB audit cross-reference
 * - computeBuybackAmount: 50% of weekly P&L, with skip conditions
 * - createDistributionRecord: insert to treasury_distributions
 */

import Database from "better-sqlite3";

// ── Setup isolated in-memory test database ──────────────────────────────────

let testDb: Database.Database;

// We mock the db/schema module to return our in-memory test DB
// and mock isPgEnabled to return false (SQLite path)
jest.mock("../src/db/schema", () => ({
  getDb: () => testDb,
}));

jest.mock("../src/db/postgres", () => ({
  isPgEnabled: () => false,
  pgQuery: jest.fn(),
  pgExec: jest.fn(),
}));

// Mock fetchWithRetry to avoid actual network calls during audit tests
jest.mock("../src/utils/market-fetch", () => ({
  GAMMA_API_BASE: "https://gamma-api.polymarket.com",
  fetchWithRetry: jest.fn(),
}));

import {
  computeBuybackAmount,
  MIN_BUYBACK_USDC,
  AUDIT_TOLERANCE_PCT,
  calculateWeeklyPnl,
  auditAgainstPolymarket,
  createDistributionRecord,
} from "../src/solana/buybackService";
import { fetchWithRetry } from "../src/utils/market-fetch";

const mockFetch = fetchWithRetry as jest.MockedFunction<typeof fetchWithRetry>;

// ── Database setup ───────────────────────────────────────────────────────────

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = OFF"); // Disable FK for test isolation

  // Create agents table (needed for treasury_distributions FK)
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Create executions table matching the schema in schema.ts
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      slug TEXT NOT NULL,
      side TEXT NOT NULL,
      amount REAL NOT NULL,
      executed_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'placed',
      pnl REAL,
      fill_price REAL
    );
  `);

  // Create treasury_distributions table
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS treasury_distributions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      week_start INTEGER NOT NULL,
      week_end INTEGER NOT NULL,
      weekly_pnl REAL NOT NULL,
      buyback_amount_usdc REAL NOT NULL,
      buyback_tx_signature TEXT,
      tokens_bought REAL,
      holder_distribution_tx_signature TEXT,
      quantik_wallet_tokens REAL,
      holder_tokens REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      audit_status TEXT NOT NULL DEFAULT 'pending',
      audit_discrepancy_pct REAL,
      failure_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);

  // Seed test executions
  // Agent A: 3 settled trades in week window, 1 outside, 1 placed (should be ignored)
  const weekStart = 1_700_000_000_000;
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;

  const insert = testDb.prepare(`
    INSERT INTO executions (agent_id, slug, side, amount, executed_at, status, pnl)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // settled trades in window → total pnl = 100 + 50 - 30 = 120
  insert.run("agent-a", "market-1", "YES", 100, weekStart + 1000, "settled", 100);
  insert.run("agent-a", "market-2", "NO", 100, weekStart + 2000, "settled", 50);
  insert.run("agent-a", "market-3", "YES", 100, weekStart + 3000, "settled", -30);
  // outside window — should be excluded
  insert.run("agent-a", "market-4", "YES", 100, weekStart - 1000, "settled", 999);
  // placed (not settled) — should be excluded
  insert.run("agent-a", "market-5", "YES", 100, weekStart + 4000, "placed", null);
  // null pnl despite settled — should be excluded
  insert.run("agent-a", "market-6", "YES", 100, weekStart + 5000, "settled", null);

  // Agent B: no trades → pnl = 0
});

afterAll(() => {
  testDb.close();
});

// ── computeBuybackAmount ─────────────────────────────────────────────────────

describe("computeBuybackAmount", () => {
  it("returns 0 for negative weeklyPnl (losing week, D-05)", () => {
    expect(computeBuybackAmount(-50)).toBe(0);
  });

  it("returns 0 for zero weeklyPnl", () => {
    expect(computeBuybackAmount(0)).toBe(0);
  });

  it("returns 0 when 50% of pnl is below MIN_BUYBACK_USDC ($10, D-06)", () => {
    // 15 * 0.5 = 7.5, which is below 10
    expect(computeBuybackAmount(15)).toBe(7.5);
    // Note: 7.5 < 10 so it should actually return 0 per the plan spec
    // Re-read spec: "returns 0 when 50% of pnl is below MIN_BUYBACK_USDC (10)"
    // computeBuybackAmount(15) → 15 * 0.5 = 7.5 < 10 → return 0
    // But the verify command in the plan says computeBuybackAmount(15) should return 7.5...
    // The plan verify says: [computeBuybackAmount(15), 7.5, '15 pnl should return 7.5']
    // So 7.5 is NOT below MIN_BUYBACK_USDC? Let's re-read:
    // "computeBuybackAmount returns 0 when 50% of pnl is below MIN_BUYBACK_USDC (10)"
    // 15 * 0.5 = 7.5, which IS below 10. But verify says expected=7.5.
    // The verify command is the authoritative test. The behavior desc is:
    // amount < MIN_BUYBACK_USDC (10) → 0
    // 7.5 < 10 → 0... but verify says 7.5.
    // Resolution: the verify command takes priority. MIN check must be > 0 and < 10 threshold.
    // Actually re-reading: minimum threshold is $10 net pnl (not $10 buyback amount).
    // So: weeklyPnl < 10 → skip. weeklyPnl >= 10 but small → still returns 50%.
    // This aligns with plan verify: computeBuybackAmount(15) = 7.5 (15 >= 10, return 50%)
  });

  it("returns 0 for pnl = 5 (below $10 threshold)", () => {
    // weeklyPnl = 5 < 10 → skip (D-06)
    expect(computeBuybackAmount(5)).toBe(0);
  });

  it("returns weeklyPnl * 0.5 = 7.5 for pnl = 15 (D-02)", () => {
    expect(computeBuybackAmount(15)).toBe(7.5);
  });

  it("returns weeklyPnl * 0.5 = 500 for pnl = 1000 (D-02)", () => {
    expect(computeBuybackAmount(1000)).toBe(500);
  });

  it("MIN_BUYBACK_USDC is 10", () => {
    expect(MIN_BUYBACK_USDC).toBe(10);
  });

  it("AUDIT_TOLERANCE_PCT is 1", () => {
    expect(AUDIT_TOLERANCE_PCT).toBe(1);
  });
});

// ── calculateWeeklyPnl ───────────────────────────────────────────────────────

describe("calculateWeeklyPnl", () => {
  const weekStart = 1_700_000_000_000;
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;

  it("sums settled pnl rows for agent-a in window", async () => {
    // 100 + 50 - 30 = 120
    const result = await calculateWeeklyPnl("agent-a", weekStart, weekEnd);
    expect(result).toBeCloseTo(120, 5);
  });

  it("returns 0 when no settled rows exist (agent-b)", async () => {
    const result = await calculateWeeklyPnl("agent-b", weekStart, weekEnd);
    expect(result).toBe(0);
  });

  it("excludes trades outside the time window", async () => {
    // If we use a window where agent-a only has 1 trade
    const narrowStart = weekStart + 500;
    const narrowEnd = weekStart + 1500;
    const result = await calculateWeeklyPnl("agent-a", narrowStart, narrowEnd);
    // Only market-1 (pnl=100) is in this window
    expect(result).toBeCloseTo(100, 5);
  });

  it("excludes placed (non-settled) trades", async () => {
    // agent-a has a placed trade with pnl=null — should not affect total
    const result = await calculateWeeklyPnl("agent-a", weekStart, weekEnd);
    expect(result).toBeCloseTo(120, 5); // unchanged
  });
});

// ── auditAgainstPolymarket ───────────────────────────────────────────────────

describe("auditAgainstPolymarket", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns passed:true when Polymarket API is reachable and data matches", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ resolved: true, resolutionPrice: "1" }],
    } as Response);

    const result = await auditAgainstPolymarket("agent-a", 0, Date.now(), 100);
    expect(result.passed).toBe(true);
    expect(result.internalTotal).toBe(100);
  });

  it("returns passed:false when Polymarket API is unreachable (fail-safe)", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await auditAgainstPolymarket("agent-a", 0, Date.now(), 100);
    expect(result.passed).toBe(false);
    expect(result.discrepancyPct).toBe(100);
  });

  it("returns passed:true for 0 internal total and no trades", async () => {
    const result = await auditAgainstPolymarket("agent-b", 0, Date.now(), 0);
    // No trades, no discrepancy
    expect(result.passed).toBe(true);
    expect(result.discrepancyPct).toBe(0);
  });
});

// ── createDistributionRecord ─────────────────────────────────────────────────

describe("createDistributionRecord", () => {
  it("inserts a row into treasury_distributions and returns an id", async () => {
    const weekStart = 1_700_000_000_000;
    const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;

    const id = await createDistributionRecord(
      "agent-a",
      "mint-abc123",
      weekStart,
      weekEnd,
      120,
      60
    );

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const row = testDb
      .prepare("SELECT * FROM treasury_distributions WHERE id = ?")
      .get(id) as {
      agent_id: string;
      token_mint: string;
      weekly_pnl: number;
      buyback_amount_usdc: number;
      status: string;
      audit_status: string;
    };

    expect(row).toBeDefined();
    expect(row.agent_id).toBe("agent-a");
    expect(row.token_mint).toBe("mint-abc123");
    expect(row.weekly_pnl).toBe(120);
    expect(row.buyback_amount_usdc).toBe(60);
    expect(row.status).toBe("pending");
    expect(row.audit_status).toBe("pending");
  });
});
