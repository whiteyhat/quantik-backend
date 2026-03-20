describe("PostgreSQL stability regressions", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("loadLinkedAgentForUser uses UUID-safe casts and returns text ids", async () => {
    const pgQueryOneMock = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        user_id: "11111111-1111-1111-1111-111111111111",
        agent_id: "22222222-2222-2222-2222-222222222222",
        status: "active",
        agent_type: "created",
        wallet_address: null,
        autopilot_enabled: 1,
      });
    const pgExecMock = jest.fn().mockResolvedValue(1);

    jest.doMock("../src/db/postgres", () => ({
      isPgEnabled: () => true,
      pgQuery: jest.fn(),
      pgQueryOne: (...args: unknown[]) => pgQueryOneMock(...args),
      pgExec: (...args: unknown[]) => pgExecMock(...args),
    }));

    const { loadLinkedAgentForUser } = require("../src/utils/linkedAgent") as typeof import("../src/utils/linkedAgent");
    await loadLinkedAgentForUser("11111111-1111-1111-1111-111111111111");

    expect(pgQueryOneMock.mock.calls[0][0]).toContain("users.id::text AS user_id");
    expect(pgQueryOneMock.mock.calls[0][0]).toContain("agents.id::text AS agent_id");
    expect(pgQueryOneMock.mock.calls[0][0]).toContain("WHERE users.id = $1::uuid");

    expect(pgQueryOneMock.mock.calls[1][0]).toContain("$1::uuid::text AS user_id");
    expect(pgQueryOneMock.mock.calls[1][0]).toContain("agents.user_id = $1::uuid");
    expect(pgQueryOneMock.mock.calls[1][0]).toContain("agents.id::text AS agent_id");

    expect(pgExecMock.mock.calls[0][0]).toContain("UPDATE users SET agent_id = $1::uuid WHERE id = $2::uuid");
  });

  test("arena leaderboard uses UUID array filters and quoted window reads in PG mode", async () => {
    const pgQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM agents")) {
        return [{
          id: "22222222-2222-2222-2222-222222222222",
          user_id: "11111111-1111-1111-1111-111111111111",
          agent_code: "Q-001",
          status: "active",
          name: "Arena Wolf",
          avatar_emoji: "W",
          animal_type: "wolf",
          agent_type: "created",
          connection_status: "connected",
          autopilot_enabled: 1,
          polymarket_ready: 1,
        }];
      }

      if (sql.includes("FROM executions")) {
        return [];
      }

      if (sql.includes("FROM scanner_results")) {
        return [];
      }

      if (sql.includes("FROM arena_snapshots")) {
        return [];
      }

      if (sql.includes("FROM orchestrator_candidates")) {
        return [];
      }

      return [];
    });

    jest.doMock("../src/db/postgres", () => ({
      isPgEnabled: () => true,
      pgQuery: (...args: unknown[]) => pgQueryMock(...args),
      pgQueryOne: jest.fn().mockResolvedValue(null),
      pgExec: jest.fn(),
    }));
    jest.doMock("../src/utils/executionDirection", () => ({
      getLatestScannerDirectionMap: jest.fn().mockResolvedValue(new Map()),
    }));

    const { loadArenaLeaderboard, resetArenaLeaderboardCache } = require("../src/performance/arenaService") as typeof import("../src/performance/arenaService");
    resetArenaLeaderboardCache();
    await loadArenaLeaderboard("day");

    expect(
      pgQueryMock.mock.calls.some(([sql]: [string]) => sql.includes("agent_id = ANY($1::uuid[])"))
    ).toBe(true);
    expect(
      pgQueryMock.mock.calls.some(([sql]: [string]) => sql.includes('WHERE "window" = $1'))
    ).toBe(true);
  });

  test("arena snapshot processing writes quoted window SQL in PG mode", async () => {
    const pgQueryMock = jest.fn().mockResolvedValue([]);
    const pgExecMock = jest.fn().mockResolvedValue(1);

    jest.doMock("../src/db/postgres", () => ({
      isPgEnabled: () => true,
      pgQuery: (...args: unknown[]) => pgQueryMock(...args),
      pgQueryOne: jest.fn().mockResolvedValue(null),
      pgExec: (...args: unknown[]) => pgExecMock(...args),
    }));
    jest.doMock("../src/performance/arenaService", () => ({
      loadArenaLeaderboard: jest.fn().mockResolvedValue({
        leaders: [{
          agentId: "22222222-2222-2222-2222-222222222222",
          name: "Arena Wolf",
          avatarEmoji: "W",
          rank: 1,
          selectedPnl: 12,
          allTimePnl: 12,
          winRate: 1,
          totalTrades: 1,
        }],
      }),
      loadCachedArenaAgents: jest.fn().mockResolvedValue([]),
    }));
    jest.doMock("../src/infra/socket", () => ({
      emitToAll: jest.fn(),
    }));
    jest.doMock("../src/performance/arenaNotifications", () => ({
      emitArenaNotifications: jest.fn(),
    }));

    const { processArenaSnapshots } = require("../src/performance/arenaSnapshots") as typeof import("../src/performance/arenaSnapshots");
    await processArenaSnapshots();

    expect(
      pgExecMock.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO arena_snapshots (agent_id, "window"'))
    ).toBe(true);
    expect(
      pgExecMock.mock.calls.some(([sql]: [string]) => sql.includes('ON CONFLICT (agent_id, "window", snapshot_at) DO NOTHING'))
    ).toBe(true);
  });

  test("migratePg creates and seeds the PG risk state tables", async () => {
    const queryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });

    jest.doMock("pg", () => ({
      Pool: jest.fn().mockImplementation(() => ({
        query: queryMock,
        on: jest.fn(),
      })),
    }));

    const { migratePg } = require("../src/db/postgres") as typeof import("../src/db/postgres");
    await migratePg();

    expect(
      queryMock.mock.calls.some(([sql]: [string]) => sql.includes("CREATE TABLE IF NOT EXISTS circuit_breaker_state"))
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO circuit_breaker_state"))
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO risk_configurations"))
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]: [string]) => sql.includes('"window" TEXT NOT NULL'))
    ).toBe(true);
  });
});
