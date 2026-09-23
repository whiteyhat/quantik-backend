import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

// Internal user ID (what getUserIdAsync returns) and Clerk user ID (what
// getAuth returns) for the simulated caller. null = signed out.
let currentUserId: string | null = null;
let currentClerkId: string | null = null;

jest.mock("../src/middleware/auth", () => ({
  getUserId: jest.fn(() => currentUserId),
  getUserIdAsync: jest.fn(async () => currentUserId),
}));

jest.mock("@clerk/express", () => ({
  ...jest.requireActual("@clerk/express"),
  getAuth: jest.fn(() => ({ userId: currentClerkId })),
}));

const OWNER_ID = "user-owner";
const AGENT_ID = "agent-secret";

function signIn(userId: string, clerkId = `clerk_${userId}`) {
  currentUserId = userId;
  currentClerkId = clerkId;
}

function signOut() {
  currentUserId = null;
  currentClerkId = null;
}

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;

async function startServer() {
  jest.resetModules();
  process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-guards-"));
  process.env.ADMIN_USER_IDS = "clerk_admin";
  process.env.TELEGRAM_CHAT_ID = "12345";

  const express = require("express") as typeof import("express");
  const { default: agentsRouter } = require("../src/routes/agents") as typeof import("../src/routes/agents");
  const { default: settingsRouter } = require("../src/routes/settings") as typeof import("../src/routes/settings");
  const { default: oracleRouter } = require("../src/routes/oracle") as typeof import("../src/routes/oracle");
  const { default: scannerRouter } = require("../src/routes/scanner") as typeof import("../src/routes/scanner");
  const { default: meAccessRouter } = require("../src/routes/meAccess") as typeof import("../src/routes/meAccess");
  const guards = require("../src/middleware/guards") as typeof import("../src/middleware/guards");
  const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");

  const app = express();
  app.use(express.json());
  app.use("/api/v1", agentsRouter);
  app.use("/api/v1", settingsRouter);
  app.use("/api/oracle", oracleRouter);
  app.use("/api/scanner", scannerRouter);
  app.use("/api/v1", meAccessRouter);
  app.use("/guarded", guards.forWrites(guards.requireUser), (_req, res) => res.json({ ok: true }));
  app.use("/admin", guards.requireAdmin, (_req, res) => res.json({ ok: true }));
  const internal = require("../src/infra/internalAuth") as typeof import("../src/infra/internalAuth");
  internalHeadersFor = internal.internalHeaders;

  const db = getDb();
  const now = Date.now();
  db.prepare("INSERT INTO users (id, clerk_id, agent_id, created_at) VALUES (?, ?, ?, ?)")
    .run(OWNER_ID, `clerk_${OWNER_ID}`, AGENT_ID, now);
  db.prepare(`
    INSERT INTO agents (
      id, agent_code, status, name, avatar_emoji, personality, decision_style, trading_instinct,
      time_patience, profit_dream, money_approach, protection_mindset, leverage_vibe, market_sense,
      asset_love, system_prompt, user_id, encrypted_private_key, encrypted_seed_phrase, webhook_secret,
      created_at, updated_at
    ) VALUES (?, 'SECRET-01', 'active', 'Vault', '🦊', 'balanced', 'analyst', 'value_hunter',
      'swing', 'wealth_builder', 'smart_scaling', 'flexible', 'none', 'fixed_rules',
      'crypto', 'prompt', ?, 'enc-key', 'enc-seed', 'whsec', ?, ?)
  `).run(AGENT_ID, OWNER_ID, now, now);

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

let server: Server;
let baseUrl: string;
let internalHeadersFor: (userId?: string | null) => Record<string, string>;

beforeAll(async () => {
  ({ server, baseUrl } = await startServer());
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => signOut());

const SECRET_FIELDS = [
  "encrypted_private_key",
  "encrypted_seed_phrase",
  "webhook_secret",
];

describe("agent detail never leaks key material", () => {
  it("shows guests only public fields", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agents/${AGENT_ID}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.name).toBe("Vault");
    for (const field of [...SECRET_FIELDS, "user_id", "system_prompt"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("strips secrets even for the owner", async () => {
    signIn(OWNER_ID);
    const body = await json(await fetch(`${baseUrl}/api/v1/agents/${AGENT_ID}`));
    expect(body.system_prompt).toBe("prompt");
    for (const field of SECRET_FIELDS) expect(body).not.toHaveProperty(field);
  });
});

describe("agent edits require the owner", () => {
  const patch = () =>
    fetch(`${baseUrl}/api/v1/agents/${AGENT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hijacked" }),
    });

  it("rejects guests", async () => {
    expect((await patch()).status).toBe(401);
  });

  it("hides other users' agents", async () => {
    signIn("user-intruder");
    expect((await patch()).status).toBe(404);
  });
});

describe("platform settings are operator-only", () => {
  const enablePaperMode = () =>
    fetch(`${baseUrl}/api/v1/settings/paper-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

  it("rejects guests and regular users", async () => {
    expect((await enablePaperMode()).status).toBe(401);
    signIn("user-regular");
    expect((await enablePaperMode()).status).toBe(403);
  });

  it("lets operators change them", async () => {
    signIn("user-admin", "clerk_admin");
    expect((await enablePaperMode()).status).toBe(200);
  });

  it("hides the Telegram chat from non-operators", async () => {
    signIn("user-regular");
    const regular = await json(await fetch(`${baseUrl}/api/v1/settings/telegram`));
    expect(regular.chatId).toBe("");
    signIn("user-admin", "clerk_admin");
    const admin = await json(await fetch(`${baseUrl}/api/v1/settings/telegram`));
    expect(admin.chatId).toBe("12345");
  });
});

describe("guards", () => {
  it("forWrites lets reads through and blocks signed-out writes", async () => {
    expect((await fetch(`${baseUrl}/guarded`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/guarded`, { method: "POST" })).status).toBe(401);
    signIn("user-regular");
    expect((await fetch(`${baseUrl}/guarded`, { method: "POST" })).status).toBe(200);
  });

  it("requireAdmin fails closed when no operators are configured", async () => {
    const saved = process.env.ADMIN_USER_IDS;
    process.env.ADMIN_USER_IDS = "";
    signIn("user-admin", "clerk_admin");
    expect((await fetch(`${baseUrl}/admin`)).status).toBe(403);
    process.env.ADMIN_USER_IDS = saved;
  });
});

describe("allowed origins", () => {
  const { isAllowedOrigin } = jest.requireActual("../src/infra/origins") as typeof import("../src/infra/origins");

  it.each([
    ["https://quantik.fun", true],
    ["https://app.quantik.fun", true],
    ["https://quantik-iyr2b0b3t-elixir-games.vercel.app", true],
    ["https://quantik-anything.vercel.app", false],
    ["https://quantik-abc123-evil-elixir-games.vercel.app", false],
    ["http://localhost:3000", true],
    ["https://quantik.fun.evil.com", false],
    ["https://evil.vercel.app", false],
    ["http://app.quantik.fun", false],
  ])("%s → %s", (origin, allowed) => {
    expect(isAllowedOrigin(origin)).toBe(allowed);
  });
});

describe("internal self-calls", () => {
  it("pass requireUser only with this process's secret", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(`${baseUrl}/guarded`, { method: "POST", headers });
    expect((await post(internalHeadersFor())).status).toBe(200);
    expect((await post({ "x-quantik-internal": "not-the-secret" })).status).toBe(401);
  });
});

describe("oracle status", () => {
  it("is served by the cheap status route, not the LLM /:slug route", async () => {
    const body = await json(await fetch(`${baseUrl}/api/oracle/status`));
    expect(body.status).toBe("running");
  });
});

describe("execution log", () => {
  it("returns nothing for guests instead of everyone's trades", async () => {
    const res = await fetch(`${baseUrl}/api/scanner/results?executed=true`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("platform-wide chat tools", () => {
  it("update_risk_config refuses non-operators", async () => {
    const { executeTool } = require("../src/agents/tools") as typeof import("../src/agents/tools");
    const result = await executeTool(
      "update_risk_config",
      { drawdown_limit: 0.9 },
      {
        userId: OWNER_ID, linkedAgentId: AGENT_ID, agentType: "created", walletAddress: null,
        autopilotEnabled: false, connectionStatus: null, agentName: "Vault", lastHeartbeat: null,
        agentStatus: "active", polymarketReady: false, isOperator: false,
      },
    );
    expect(result.data).toEqual({ error: expect.stringContaining("operators") });
  });
});

describe("internal secret comparison", () => {
  it("rejects a same-length header with non-ASCII bytes instead of throwing", () => {
    const { isInternalRequest } = jest.requireActual("../src/infra/internalAuth") as typeof import("../src/infra/internalAuth");
    const header = "é" + "a".repeat(63);
    const req = { get: () => header } as unknown as import("express").Request;
    expect(() => isInternalRequest(req)).not.toThrow();
    expect(isInternalRequest(req)).toBe(false);
  });
});

describe("GET /api/v1/me/access", () => {
  it("tells guests nothing about operators", async () => {
    const body = await json(await fetch(`${baseUrl}/api/v1/me/access`));
    expect(body).toEqual({ signedIn: false, hasAgent: false, isOperator: false });
  });

  it("reports the owner's agent", async () => {
    signIn(OWNER_ID);
    const body = await json(await fetch(`${baseUrl}/api/v1/me/access`));
    expect(body).toEqual({ signedIn: true, hasAgent: true, isOperator: false });
  });

  it("recognises the operator", async () => {
    signIn("user-admin", "clerk_admin");
    const body = await json(await fetch(`${baseUrl}/api/v1/me/access`));
    expect(body).toEqual({ signedIn: true, hasAgent: false, isOperator: true });
  });
});
