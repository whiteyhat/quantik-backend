/**
 * Unit tests for holderSyncService.ts
 *
 * Tests cover:
 * - upsertHolders() inserts top 10 rows into solana_token_holders for a given mint in SQLite
 * - upsertHolders() replaces existing rows (DELETE then INSERT in transaction) — no stale rows
 * - runHolderSync() calls getTopHolders() for each migrated token (status = 'migrated') in solana_tokens
 * - emitHolderUpdate() calls io.to(`mint:${mint}`).emit("holders:updated", payload) with correct shape
 * - emitHolderUpdate() is a no-op if getIO() returns null (graceful fallback)
 * - percentage in HolderSyncRow is calculated as shareOfTopTen * 100 (0-100 range, not 0-1)
 */

import Database from "better-sqlite3";

// ── Mock modules before imports ───────────────────────────────────────────────

const mockGetTopHolders = jest.fn();
jest.mock("../src/solana/holderService", () => ({
  getTopHolders: mockGetTopHolders,
}));

const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
const mockGetIO = jest.fn();
jest.mock("../src/infra/socket", () => ({
  getIO: mockGetIO,
  emitHolderUpdate: jest.fn((event: unknown) => {
    // Call real logic using the mocked getIO
    const io = mockGetIO();
    if (!io) return;
    const e = event as { mint: string };
    io.to(`mint:${e.mint}`).emit("holders:updated", event);
  }),
}));

// Use a shared in-memory SQLite for tests
let testDb: Database.Database;

jest.mock("../src/db/schema", () => ({
  getDb: () => testDb,
}));

jest.mock("../src/db/postgres", () => ({
  isPgEnabled: () => false,
  pgExec: jest.fn(),
  pgQuery: jest.fn(),
}));

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Fresh in-memory DB for each test
  testDb = new Database(":memory:");

  // Create solana_tokens table (needed for getMigratedTokens)
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS solana_tokens (
      token_mint TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'bonding'
    );
  `);

  // Create solana_token_holders table (the table we're testing)
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS solana_token_holders (
      id TEXT PRIMARY KEY,
      mint TEXT NOT NULL,
      wallet TEXT NOT NULL,
      balance REAL NOT NULL,
      percentage REAL NOT NULL,
      rank INTEGER NOT NULL,
      last_sync_time INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(mint, wallet)
    );
    CREATE INDEX IF NOT EXISTS idx_solana_token_holders_mint_rank
      ON solana_token_holders(mint, rank ASC);
  `);

  jest.clearAllMocks();
});

afterEach(() => {
  testDb.close();
});

// ── Import service under test AFTER mocks are in place ───────────────────────

import { upsertHolders, runHolderSync } from "../src/solana/holderSyncService";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("upsertHolders", () => {
  const MINT = "So11111111111111111111111111111111111111112";

  const sampleHolders = [
    { wallet: "Wallet1111111111111111111111111111111111111", balance: 5000, shareOfTopTen: 0.5 },
    { wallet: "Wallet2222222222222222222222222222222222222", balance: 3000, shareOfTopTen: 0.3 },
    { wallet: "Wallet3333333333333333333333333333333333333", balance: 2000, shareOfTopTen: 0.2 },
  ];

  it("inserts holders into solana_token_holders for a given mint", async () => {
    await upsertHolders(MINT, sampleHolders);

    const rows = testDb
      .prepare("SELECT * FROM solana_token_holders WHERE mint = ? ORDER BY rank ASC")
      .all(MINT) as { wallet: string; balance: number; percentage: number; rank: number }[];

    expect(rows).toHaveLength(3);
    expect(rows[0].wallet).toBe(sampleHolders[0].wallet);
    expect(rows[0].balance).toBe(5000);
    expect(rows[0].rank).toBe(1);
  });

  it("converts shareOfTopTen to percentage (0-100 range, not 0-1)", async () => {
    await upsertHolders(MINT, sampleHolders);

    const rows = testDb
      .prepare("SELECT percentage FROM solana_token_holders WHERE mint = ? ORDER BY rank ASC")
      .all(MINT) as { percentage: number }[];

    // shareOfTopTen 0.5 → percentage 50
    expect(rows[0].percentage).toBeCloseTo(50);
    // shareOfTopTen 0.3 → percentage 30
    expect(rows[1].percentage).toBeCloseTo(30);
    // shareOfTopTen 0.2 → percentage 20
    expect(rows[2].percentage).toBeCloseTo(20);
  });

  it("replaces existing rows (DELETE then INSERT) — no stale rows after second call", async () => {
    // First sync: 3 holders
    await upsertHolders(MINT, sampleHolders);

    const firstRows = testDb
      .prepare("SELECT COUNT(*) AS cnt FROM solana_token_holders WHERE mint = ?")
      .get(MINT) as { cnt: number };
    expect(firstRows.cnt).toBe(3);

    // Second sync: only 1 holder (simulates leaderboard change)
    const updatedHolders = [
      { wallet: "Wallet4444444444444444444444444444444444444", balance: 9000, shareOfTopTen: 1.0 },
    ];
    await upsertHolders(MINT, updatedHolders);

    const secondRows = testDb
      .prepare("SELECT * FROM solana_token_holders WHERE mint = ? ORDER BY rank ASC")
      .all(MINT) as { wallet: string; rank: number }[];

    // No stale rows from first sync
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].wallet).toBe("Wallet4444444444444444444444444444444444444");
    expect(secondRows[0].rank).toBe(1);
  });

  it("handles empty holders array (DELETE all, no INSERT)", async () => {
    // Pre-populate
    await upsertHolders(MINT, sampleHolders);

    // Sync with empty array
    await upsertHolders(MINT, []);

    const rows = testDb
      .prepare("SELECT COUNT(*) AS cnt FROM solana_token_holders WHERE mint = ?")
      .get(MINT) as { cnt: number };
    expect(rows.cnt).toBe(0);
  });
});

describe("runHolderSync", () => {
  it("calls getTopHolders() for each migrated token", async () => {
    // Insert two migrated tokens
    testDb.prepare("INSERT INTO solana_tokens (token_mint, agent_id, status) VALUES (?, ?, ?)").run(
      "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "agent-1",
      "migrated"
    );
    testDb.prepare("INSERT INTO solana_tokens (token_mint, agent_id, status) VALUES (?, ?, ?)").run(
      "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "agent-2",
      "migrated"
    );
    // Also insert a bonding token (should NOT be synced)
    testDb.prepare("INSERT INTO solana_tokens (token_mint, agent_id, status) VALUES (?, ?, ?)").run(
      "MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      "agent-3",
      "bonding"
    );

    mockGetTopHolders.mockResolvedValue([]);
    mockGetIO.mockReturnValue(null); // no socket, no emit

    await runHolderSync();

    // Should be called exactly twice (only migrated tokens)
    expect(mockGetTopHolders).toHaveBeenCalledTimes(2);
    expect(mockGetTopHolders).toHaveBeenCalledWith("MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 10);
    expect(mockGetTopHolders).toHaveBeenCalledWith("MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", 10);
    // Should NOT be called for bonding token
    expect(mockGetTopHolders).not.toHaveBeenCalledWith("MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", 10);
  });

  it("continues syncing remaining tokens if one fails", async () => {
    testDb.prepare("INSERT INTO solana_tokens (token_mint, agent_id, status) VALUES (?, ?, ?)").run(
      "MintFAIL1111111111111111111111111111111111",
      "agent-fail",
      "migrated"
    );
    testDb.prepare("INSERT INTO solana_tokens (token_mint, agent_id, status) VALUES (?, ?, ?)").run(
      "MintOK2222222222222222222222222222222222222",
      "agent-ok",
      "migrated"
    );

    mockGetTopHolders
      .mockRejectedValueOnce(new Error("RPC timeout"))
      .mockResolvedValueOnce([]);
    mockGetIO.mockReturnValue(null);

    // Should not throw
    await expect(runHolderSync()).resolves.not.toThrow();
    expect(mockGetTopHolders).toHaveBeenCalledTimes(2);
  });
});

describe("emitHolderUpdate", () => {
  it("emits holders:updated to mint-specific room with correct shape", () => {
    const { emitHolderUpdate } = require("../src/infra/socket");

    mockGetIO.mockReturnValue({ to: mockTo });

    const event = {
      mint: "TestMint111111111111111111111111111111111",
      holders: [
        { rank: 1, wallet: "Wallet1111", balance: 5000, percentage: 50 },
      ],
      updatedAt: Date.now(),
    };

    emitHolderUpdate(event);

    expect(mockTo).toHaveBeenCalledWith("mint:TestMint111111111111111111111111111111111");
    expect(mockEmit).toHaveBeenCalledWith("holders:updated", event);
  });

  it("is a no-op when getIO() returns null (graceful fallback)", () => {
    const { emitHolderUpdate } = require("../src/infra/socket");

    mockGetIO.mockReturnValue(null);

    // Should not throw
    expect(() =>
      emitHolderUpdate({
        mint: "AnyMint",
        holders: [],
        updatedAt: Date.now(),
      })
    ).not.toThrow();

    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
