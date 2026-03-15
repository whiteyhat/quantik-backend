import fs from "fs";
import os from "os";
import path from "path";

function seedAgent(
  db: ReturnType<typeof import("../src/db/schema").getDb>,
  userId: string,
  overrides: Partial<{
    id: string;
    name: string;
    agent_type: string;
    status: string;
    connection_status: string | null;
    autopilot_enabled: number;
    polymarket_ready: number;
  }> = {},
) {
  const now = Date.now();
  const agent = {
    id: overrides.id ?? `agent-${Math.random().toString(16).slice(2, 10)}`,
    agent_code: `Q-AGENT-${Math.floor(Math.random() * 900 + 100)}`,
    status: overrides.status ?? "active",
    name: overrides.name ?? "Arena Agent",
    avatar_emoji: "🦞",
    personality: "balanced",
    decision_style: "analyst",
    trading_instinct: "value_hunter",
    time_patience: "swing",
    profit_dream: "wealth_builder",
    money_approach: "smart_scaling",
    protection_mindset: "flexible",
    leverage_vibe: "none",
    market_sense: "fixed_rules",
    asset_love: "crypto",
    system_prompt: "You are a Quantik trading agent.",
    wallet_address: "0x1111111111111111111111111111111111111111",
    user_id: userId,
    agent_type: overrides.agent_type ?? "created",
    endpoint_url: null,
    agent_url: null,
    connection_status: overrides.connection_status ?? "connected",
    last_heartbeat: now,
    description: null,
    webhook_secret: null,
    webhook_events: JSON.stringify(["*"]),
    autopilot_enabled: overrides.autopilot_enabled ?? 1,
    autopilot_updated_at: now,
    polymarket_ready: overrides.polymarket_ready ?? 1,
    created_at: now,
    updated_at: now,
  };

  db.prepare(`
    INSERT INTO agents (
      id, agent_code, status, name, avatar_emoji,
      personality, decision_style, trading_instinct, time_patience, profit_dream,
      money_approach, protection_mindset, leverage_vibe, market_sense, asset_love,
      system_prompt, wallet_address, user_id, agent_type, endpoint_url, agent_url,
      connection_status, last_heartbeat, description, webhook_secret, webhook_events,
      autopilot_enabled, autopilot_updated_at, polymarket_ready, created_at, updated_at
    ) VALUES (
      @id, @agent_code, @status, @name, @avatar_emoji,
      @personality, @decision_style, @trading_instinct, @time_patience, @profit_dream,
      @money_approach, @protection_mindset, @leverage_vibe, @market_sense, @asset_love,
      @system_prompt, @wallet_address, @user_id, @agent_type, @endpoint_url, @agent_url,
      @connection_status, @last_heartbeat, @description, @webhook_secret, @webhook_events,
      @autopilot_enabled, @autopilot_updated_at, @polymarket_ready, @created_at, @updated_at
    )
  `).run(agent);

  return agent.id;
}

function seedExecution(
  db: ReturnType<typeof import("../src/db/schema").getDb>,
  userId: string,
  agentId: string,
  slug: string,
  pnl: number,
  executedAt: number,
) {
  db.prepare(
    `INSERT INTO executions (user_id, agent_id, slug, side, amount, executed_at, status, order_id, fill_price, pnl, closed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, agentId, slug, "buy", 100, executedAt, "settled", null, 0.45, pnl, executedAt, executedAt);
}

describe("arena service", () => {
  test("supports day, week, and all-time windows and resolves a viewer outside the active board", async () => {
    jest.resetModules();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-arena-service-"));
    process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;

    const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");
    const { loadArenaLeaderboard, resetArenaLeaderboardCache } = require("../src/performance/arenaService") as typeof import("../src/performance/arenaService");

    const db = getDb();
    const now = Date.now();
    const leaderId = seedAgent(db, "user-leader", { id: "agent-leader", name: "Arena Wolf" });
    const rivalId = seedAgent(db, "user-rival", { id: "agent-rival", name: "Podium Fox" });
    const viewerId = seedAgent(db, "user-viewer", {
      id: "agent-viewer",
      name: "OpenClaw Scout",
      agent_type: "byo",
      status: "paused",
    });

    seedExecution(db, "user-leader", leaderId, "leader-recent", 120, now - 2 * 60_000);
    seedExecution(db, "user-leader", leaderId, "leader-old", 75, now - 10 * 24 * 60 * 60 * 1000);
    seedExecution(db, "user-rival", rivalId, "rival-recent", 90, now - 3 * 24 * 60 * 60 * 1000);
    seedExecution(db, "user-viewer", viewerId, "viewer-recent", 45, now - 4 * 60_000);

    resetArenaLeaderboardCache();
    const day = await loadArenaLeaderboard("day", viewerId);
    const week = await loadArenaLeaderboard("week", viewerId);
    const all = await loadArenaLeaderboard("all", viewerId);

    expect(day.window).toBe("day");
    expect(day.leaders.map((entry: { name: string }) => entry.name)).toEqual(["Arena Wolf", "Podium Fox"]);
    expect(day.leaders[0].selectedPnl).toBe(120);

    expect(week.window).toBe("week");
    expect(week.leaders[0].selectedPnl).toBe(120);
    expect(week.leaders[1].selectedPnl).toBe(90);

    expect(all.window).toBe("all");
    expect(all.leaders[0].selectedPnl).toBe(195);
    expect(all.viewer.agentId).toBe(viewerId);
    expect(all.viewer.reason).toBe("inactive");
    expect(all.viewer.entry?.name).toBe("OpenClaw Scout");
    expect(all.viewer.rank).toBeNull();
    expect(all.viewer.gapToCrown).toBe(150);
  });

  test("tool executor returns the shared arena leaderboard payload", async () => {
    jest.resetModules();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-arena-tool-"));
    process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;

    const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");
    const { executeTool } = require("../src/agents/tools") as typeof import("../src/agents/tools");
    const { resetArenaLeaderboardCache } = require("../src/performance/arenaService") as typeof import("../src/performance/arenaService");

    const db = getDb();
    const agentId = seedAgent(db, "user-tool", { id: "agent-tool", name: "Tool Agent", agent_type: "byo" });
    seedExecution(db, "user-tool", agentId, "tool-market", 33, Date.now() - 60_000);

    resetArenaLeaderboardCache();
    const result = await executeTool("get_arena_leaderboard", { window: "all" }, {
      userId: "user-tool",
      linkedAgentId: agentId,
      agentType: "byo",
      walletAddress: "0x1111111111111111111111111111111111111111",
      autopilotEnabled: true,
      connectionStatus: "connected",
      agentName: "Tool Agent",
      lastHeartbeat: Date.now(),
      agentStatus: "active",
      polymarketReady: true,
    });

    const payload = result.data as { window: string; viewer: { agentId: string | null } };
    expect(result.name).toBe("get_arena_leaderboard");
    expect(payload.window).toBe("all");
    expect(payload.viewer.agentId).toBe(agentId);
  });
});
