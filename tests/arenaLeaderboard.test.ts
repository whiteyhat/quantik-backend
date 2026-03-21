import {
  buildArenaLeaderboard,
  type ArenaAgentRecord,
  type ArenaExecutionRecord,
} from "../src/performance/arena";

const NOW = 1_763_161_200_000;

function makeAgent(overrides: Partial<ArenaAgentRecord>): ArenaAgentRecord {
  return {
    id: "agent-default",
    agent_code: "Q-AGENT-X000",
    status: "active",
    name: "Default Agent",
    avatar_emoji: "🤖",
    animal_type: null,
    agent_type: "created",
    connection_status: "connected",
    autopilot_enabled: 1,
    polymarket_ready: 1,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ArenaExecutionRecord>): ArenaExecutionRecord {
  return {
    id: 1,
    agent_id: "agent-default",
    slug: "default-market",
    side: "buy",
    direction: "YES",
    source: "autopilot",
    amount: 100,
    executed_at: NOW - 60_000,
    status: "settled",
    fill_price: 0.5,
    pnl: 10,
    closed_at: NOW - 30_000,
    updated_at: NOW - 30_000,
    ...overrides,
  };
}

describe("arena leaderboard builder", () => {
  test("sorts by selected pnl, then all-time pnl, then win rate and recency", () => {
    const agents = [
      makeAgent({ id: "agent-a", agent_code: "Q-AGENT-X101", name: "Alpha" }),
      makeAgent({ id: "agent-b", agent_code: "Q-AGENT-X202", name: "Bravo" }),
      makeAgent({ id: "agent-c", agent_code: "Q-AGENT-X303", name: "Cipher" }),
      makeAgent({ id: "agent-d", agent_code: "Q-AGENT-X404", name: "Delta" }),
    ];

    const executions = [
      makeExecution({ id: 1, agent_id: "agent-a", pnl: 100, slug: "alpha-1", closed_at: NOW - 60_000, updated_at: NOW - 60_000 }),
      makeExecution({ id: 2, agent_id: "agent-a", pnl: 0, slug: "alpha-older", closed_at: NOW - 10 * 24 * 60 * 60 * 1000, updated_at: NOW - 10 * 24 * 60 * 60 * 1000 }),
      makeExecution({ id: 3, agent_id: "agent-b", pnl: 100, slug: "bravo-1", closed_at: NOW - 120_000, updated_at: NOW - 120_000 }),
      makeExecution({ id: 4, agent_id: "agent-b", pnl: 80, slug: "bravo-older", closed_at: NOW - 12 * 24 * 60 * 60 * 1000, updated_at: NOW - 12 * 24 * 60 * 60 * 1000 }),
      makeExecution({ id: 5, agent_id: "agent-c", pnl: 100, slug: "cipher-1", closed_at: NOW - 180_000, updated_at: NOW - 180_000 }),
      makeExecution({ id: 6, agent_id: "agent-c", pnl: -50, slug: "cipher-older", closed_at: NOW - 15 * 24 * 60 * 60 * 1000, updated_at: NOW - 15 * 24 * 60 * 60 * 1000 }),
      makeExecution({ id: 7, agent_id: "agent-d", pnl: 100, slug: "delta-1", executed_at: NOW - 240_000, closed_at: NOW - 240_000, updated_at: NOW - 240_000 }),
    ];

    const result = buildArenaLeaderboard({
      window: "day",
      now: NOW,
      agents,
      executions,
      latestPrices: new Map(),
      scannerDirections: new Map(),
    });

    expect(result.leaders.map((entry) => entry.name)).toEqual(["Bravo", "Delta", "Alpha", "Cipher"]);
    expect(result.leaders.map((entry) => entry.rank)).toEqual([1, 2, 3, 4]);
  });

  test("uses trailing-window net pnl and includes recent open-position mark-to-market", () => {
    const agents = [makeAgent({ id: "agent-a", name: "Alpha" })];
    const executions = [
      makeExecution({
        id: 1,
        agent_id: "agent-a",
        slug: "recent-win",
        pnl: 30,
        closed_at: NOW - 60 * 60 * 1000,
        updated_at: NOW - 60 * 60 * 1000,
      }),
      makeExecution({
        id: 2,
        agent_id: "agent-a",
        slug: "recent-open",
        status: "placed",
        executed_at: NOW - 2 * 60 * 60 * 1000,
        pnl: null,
        fill_price: 0.4,
        closed_at: null,
        updated_at: NOW - 2 * 60 * 60 * 1000,
      }),
      makeExecution({
        id: 3,
        agent_id: "agent-a",
        slug: "old-open",
        status: "placed",
        executed_at: NOW - 9 * 24 * 60 * 60 * 1000,
        pnl: null,
        fill_price: 0.5,
        closed_at: null,
        updated_at: NOW - 9 * 24 * 60 * 60 * 1000,
      }),
    ];

    const result = buildArenaLeaderboard({
      window: "day",
      now: NOW,
      agents,
      executions,
      latestPrices: new Map([
        ["recent-open", 0.6],
        ["old-open", 0.7],
      ]),
      scannerDirections: new Map(),
      viewerAgentId: "agent-a",
    });

    expect(result.leaders).toHaveLength(1);
    expect(result.leaders[0].selectedRealizedPnl).toBe(30);
    expect(result.leaders[0].selectedUnrealizedPnl).toBe(90);
    expect(result.leaders[0].selectedPnl).toBe(120);
    expect(result.leaders[0].allTimePnl).toBe(120);
  });

  test("returns viewer context for active agents with no ranked activity", () => {
    const agents = [
      makeAgent({ id: "viewer-agent", agent_code: "Q-AGENT-X101", name: "Signal Scout" }),
      makeAgent({ id: "leader-agent", agent_code: "Q-AGENT-X999", name: "Rift Hunter" }),
    ];
    const executions = [
      makeExecution({
        id: 1,
        agent_id: "leader-agent",
        slug: "leader-win",
        pnl: 220,
      }),
    ];

    const result = buildArenaLeaderboard({
      window: "all",
      now: NOW,
      agents,
      executions,
      latestPrices: new Map(),
      scannerDirections: new Map(),
      viewerAgentId: "viewer-agent",
    });

    expect(result.viewer.ranked).toBe(false);
    expect(result.viewer.eligible).toBe(false);
    expect(result.viewer.reason).toBe("no_activity");
    expect(result.viewer.entry?.name).toBe("Signal Scout");
    expect(result.viewer.gapToCrown).toBe(220);
  });

  test("computes badges and heat for ranked entries", () => {
    const agents = [
      makeAgent({ id: "agent-a", agent_code: "Q-AGENT-X101", name: "Badge Hunter" }),
    ];

    const now = NOW;
    const executions = Array.from({ length: 55 }, (_, i) =>
      makeExecution({
        id: i + 1,
        agent_id: "agent-a",
        slug: `market-${i % 6}`,
        pnl: i % 3 === 0 ? -5 : 20,
        executed_at: now - (i + 1) * 60_000,
        closed_at: now - i * 60_000,
        updated_at: now - i * 60_000,
      }),
    );

    const result = buildArenaLeaderboard({
      window: "all",
      now,
      agents,
      executions,
      latestPrices: new Map(),
      scannerDirections: new Map(),
    });

    expect(result.leaders).toHaveLength(1);
    const entry = result.leaders[0];

    // Should have badges: first_blood (>= 1 trade), market_maker (>= 50), diversified (>= 5 slugs), speed_demon (closed < 1h), diamond_hands (only agent)
    const badgeIds = entry.badges.map((b) => b.id);
    expect(badgeIds).toContain("first_blood");
    expect(badgeIds).toContain("market_maker");
    expect(badgeIds).toContain("diversified");
    expect(badgeIds).toContain("speed_demon");
    expect(badgeIds).toContain("diamond_hands");

    // Heat should be > 0 since all 55 trades are recent
    expect(entry.heat).toBeGreaterThan(0);
  });
});
