import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

function seedUser(getDb: typeof import("../src/db/schema").getDb, userId: string) {
  const db = getDb();
  db.prepare("INSERT INTO users (id, clerk_id, created_at) VALUES (?, ?, ?)").run(userId, `clerk-${userId}`, Date.now());
  return db;
}

function seedAgent(
  db: ReturnType<typeof import("../src/db/schema").getDb>,
  userId: string,
  overrides: Partial<{ id: string; name: string; agent_type: string }> = {},
) {
  const now = Date.now();
  const agentId = overrides.id ?? `agent-${Math.random().toString(16).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO agents (
      id, agent_code, status, name, avatar_emoji, personality, decision_style,
      trading_instinct, time_patience, profit_dream, money_approach, protection_mindset,
      leverage_vibe, market_sense, asset_love, system_prompt, wallet_address, user_id,
      agent_type, connection_status, last_heartbeat, webhook_events, autopilot_enabled,
      autopilot_updated_at, polymarket_ready, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, '🦞', 'balanced', 'analyst', 'value_hunter', 'swing', 'wealth_builder',
      'smart_scaling', 'flexible', 'none', 'fixed_rules', 'crypto', 'Arena tool agent',
      '0x1111111111111111111111111111111111111111', ?, ?, 'connected', ?, '["*"]', 1, ?, 1, ?, ?)
  `).run(
    agentId,
    `Q-AGENT-${Math.floor(Math.random() * 900 + 100)}`,
    overrides.name ?? "Arena API Agent",
    userId,
    overrides.agent_type ?? "byo",
    now,
    now,
    now,
    now,
  );
  return agentId;
}

function seedExecution(
  db: ReturnType<typeof import("../src/db/schema").getDb>,
  userId: string,
  agentId: string,
  slug: string,
  pnl: number,
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO executions (user_id, agent_id, slug, side, amount, executed_at, status, order_id, fill_price, pnl, closed_at, updated_at)
     VALUES (?, ?, ?, 'buy', 100, ?, 'settled', NULL, 0.45, ?, ?, ?)`
  ).run(userId, agentId, slug, now, pnl, now, now);
}

async function startServer() {
  jest.resetModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-arena-tool-api-"));
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;

  const express = require("express") as typeof import("express");
  const { apiKeyAuth, generateApiKey } = require("../src/middleware/apiKeyAuth") as typeof import("../src/middleware/apiKeyAuth");
  const { default: toolApiRouter } = require("../src/routes/toolApi") as typeof import("../src/routes/toolApi");
  const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");
  const { resetArenaLeaderboardCache } = require("../src/performance/arenaService") as typeof import("../src/performance/arenaService");

  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use("/api/v1/tools", toolApiRouter);

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, getDb, generateApiKey, resetArenaLeaderboardCache };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("arena tool API", () => {
  test("returns the canonical arena leaderboard and logs usage for a BYO agent", async () => {
    const { server, baseUrl, getDb, generateApiKey, resetArenaLeaderboardCache } = await startServer();

    try {
      const userId = "user-arena-api";
      const db = seedUser(getDb, userId);
      const agentId = seedAgent(db, userId, { id: "agent-arena-api" });
      seedExecution(db, userId, agentId, "arena-live", 84);

      const { fullKey, keyHash, keyPrefix } = generateApiKey();
      db.prepare(
        "INSERT INTO api_keys (id, agent_id, user_id, key_hash, key_prefix, scopes, rate_limit_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, 'standard', ?)"
      ).run("key-arena", agentId, userId, keyHash, keyPrefix, JSON.stringify(["read", "trade", "analysis", "config"]), Date.now());

      resetArenaLeaderboardCache();
      const response = await fetch(`${baseUrl}/api/v1/tools/get_arena_leaderboard`, {
        headers: { Authorization: `Bearer ${fullKey}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        success: boolean;
        data: { window: string; viewer: { agentId: string | null }; leaders: Array<{ name: string }> };
      };
      expect(body.success).toBe(true);
      expect(body.data.window).toBe("all");
      expect(body.data.viewer.agentId).toBe(agentId);
      expect(body.data.leaders[0]?.name).toBe("Arena API Agent");

      const requestLog = db.prepare(
        "SELECT tool_name FROM byo_request_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(agentId) as { tool_name: string } | undefined;
      expect(requestLog?.tool_name).toBe("get_arena_leaderboard");
    } finally {
      await closeServer(server);
    }
  });

  test("rejects invalid arena windows and accepts the day filter", async () => {
    const { server, baseUrl, getDb, generateApiKey, resetArenaLeaderboardCache } = await startServer();

    try {
      const userId = "user-arena-window";
      const db = seedUser(getDb, userId);
      const agentId = seedAgent(db, userId, { id: "agent-arena-window" });
      seedExecution(db, userId, agentId, "arena-day", 21);

      const { fullKey, keyHash, keyPrefix } = generateApiKey();
      db.prepare(
        "INSERT INTO api_keys (id, agent_id, user_id, key_hash, key_prefix, scopes, rate_limit_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, 'standard', ?)"
      ).run("key-window", agentId, userId, keyHash, keyPrefix, JSON.stringify(["read"]), Date.now());

      const invalid = await fetch(`${baseUrl}/api/v1/tools/get_arena_leaderboard?window=month`, {
        headers: { Authorization: `Bearer ${fullKey}` },
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ success: false, code: "INVALID_PARAMS" });

      resetArenaLeaderboardCache();
      const valid = await fetch(`${baseUrl}/api/v1/tools/get_arena_leaderboard?window=day`, {
        headers: { Authorization: `Bearer ${fullKey}` },
      });
      expect(valid.status).toBe(200);
      const validBody = await valid.json() as { data: { window: string } };
      expect(validBody.data.window).toBe("day");
    } finally {
      await closeServer(server);
    }
  });
});
