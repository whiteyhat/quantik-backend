import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

let currentUserId: string | null = "user-test";
let pgEnabled = false;

const pgQueryMock = jest.fn();
const pgQueryOneMock = jest.fn();
const pgExecMock = jest.fn();
const generateWalletMock = jest.fn();

jest.mock("../src/middleware/auth", () => ({
  getUserId: jest.fn(() => currentUserId),
  getUserIdAsync: jest.fn(async () => currentUserId),
}));

jest.mock("../src/db/postgres", () => ({
  isPgEnabled: jest.fn(() => pgEnabled),
  pgQuery: (...args: unknown[]) => pgQueryMock(...args),
  pgQueryOne: (...args: unknown[]) => pgQueryOneMock(...args),
  pgExec: (...args: unknown[]) => pgExecMock(...args),
  getPgPool: jest.fn(() => ({
    query: jest.fn(),
    connect: jest.fn(),
  })),
}));

jest.mock("../src/wallet/generate", () => ({
  generateWalletCredentials: (...args: unknown[]) => generateWalletMock(...args),
}));

const VALID_WALLET = {
  address: "0x1111111111111111111111111111111111111111",
  privateKey: "0xabcdef",
  seedPhrase: "alpha beta gamma delta",
};

function buildCreateBody() {
  return {
    name: "Signal Scout",
    avatar: "🦊",
    wallet_address: VALID_WALLET.address,
    personality: "balanced",
    decisionStyle: "analyst",
    tradingInstinct: "value_hunter",
    timePatience: "swing",
    profitDream: "wealth_builder",
    moneyApproach: "smart_scaling",
    protectionMindset: "flexible",
    leverageVibe: "none",
    marketSense: "fixed_rules",
    assetLove: "crypto",
  };
}

async function startTestServer() {
  jest.resetModules();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-agent-factory-"));
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;

  const express = require("express") as typeof import("express");
  const { default: agentsRouter } = require("../src/routes/agents") as typeof import("../src/routes/agents");
  const { default: byoOnboardingRouter } = require("../src/routes/byoOnboarding") as typeof import("../src/routes/byoOnboarding");
  const { default: walletRouter } = require("../src/routes/wallet") as typeof import("../src/routes/wallet");
  const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");

  const app = express();
  app.use(express.json());
  app.use("/api/v1", agentsRouter);
  app.use("/api/v1", byoOnboardingRouter);
  app.use("/api/wallet", walletRouter);

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    getDb,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function seedUser(getDb: typeof import("../src/db/schema").getDb, userId: string) {
  const db = getDb();
  db.prepare(
    "INSERT INTO users (id, clerk_id, created_at) VALUES (?, ?, ?)"
  ).run(userId, `clerk-${userId}`, Date.now());
  return db;
}

beforeEach(() => {
  currentUserId = "user-test";
  pgEnabled = false;
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  pgQueryMock.mockReset();
  pgQueryOneMock.mockReset();
  pgExecMock.mockReset();
  generateWalletMock.mockReset();
  generateWalletMock.mockResolvedValue(VALID_WALLET);
});

describe("agent factory routes", () => {
  test("standard create requires authentication", async () => {
    currentUserId = null;
    const { server, baseUrl } = await startTestServer();

    try {
      const res = await fetch(`${baseUrl}/api/v1/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCreateBody()),
      });

      expect(res.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  test("standard create persists only the WDK wallet address", async () => {
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      const db = seedUser(getDb, currentUserId!);

      const res = await fetch(`${baseUrl}/api/v1/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCreateBody()),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { id: string; wallet_address: string };
      expect(body.wallet_address).toBe(VALID_WALLET.address);

      const row = db.prepare("SELECT wallet_address, user_id FROM agents WHERE id = ?").get(body.id) as {
        wallet_address: string;
        user_id: string;
      } | undefined;
      expect(row).toBeDefined();
      expect(row?.wallet_address).toBe(VALID_WALLET.address);
      expect(row?.user_id).toBe(currentUserId);

      const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).not.toContain("wallet_private_key");
      expect(columnNames).not.toContain("wallet_seed_phrase");
    } finally {
      await closeServer(server);
    }
  });

  test("wallet generation requires authentication", async () => {
    currentUserId = null;
    const { server, baseUrl } = await startTestServer();

    try {
      const res = await fetch(`${baseUrl}/api/wallet/generate`, { method: "POST" });
      expect(res.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  test("legacy direct BYO create route is deprecated", async () => {
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      seedUser(getDb, currentUserId!);

      const res = await fetch(`${baseUrl}/api/v1/agents/byo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Legacy OpenClaw",
          avatar: "🦞",
          agent_url: "https://agent.example.com",
        }),
      });

      expect(res.status).toBe(410);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("BYO_LEGACY_DEPRECATED");
    } finally {
      await closeServer(server);
    }
  });

  test("BYO onboarding claim provisions credentials once and deploys through HTTP", async () => {
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      const db = seedUser(getDb, currentUserId!);

      const createRes = await fetch(`${baseUrl}/api/v1/agents/byo/onboarding`, {
        method: "POST",
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json() as {
        session_id: string;
        onboarding_url: string;
      };

      const claimInfoRes = await fetch(createBody.onboarding_url);
      expect(claimInfoRes.status).toBe(200);
      const claimInfo = await claimInfoRes.json() as { submit_url: string; required_fields: string[] };
      expect(claimInfo.submit_url).toBe(createBody.onboarding_url);
      expect(claimInfo.required_fields).toEqual(["name", "agent_url"]);

      const claimPayload = {
        name: "OpenClaw Prime",
        description: "External runtime claimed via Quantik onboarding",
        emoji: "🦊",
        agent_url: "https://agent.example.com",
        endpoint_url: "https://agent.example.com/webhook",
        webhook_events: ["*"],
      };
      const claimRes = await fetch(createBody.onboarding_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(claimPayload),
      });

      expect(claimRes.status).toBe(200);
      const claimBody = await claimRes.json() as {
        success: boolean;
        agent: { id: string; wallet_address: string };
        credentials: {
          wallet_address: string;
          wallet_private_key: string;
          wallet_seed_phrase: string;
          webhook_secret: string;
        };
      };

      expect(claimBody.success).toBe(true);
      expect(claimBody.credentials.wallet_address).toBe(VALID_WALLET.address);
      expect(claimBody.credentials.wallet_private_key).toBe(VALID_WALLET.privateKey);
      expect(claimBody.credentials.wallet_seed_phrase).toBe(VALID_WALLET.seedPhrase);
      expect(claimBody.credentials.webhook_secret.length).toBeGreaterThan(0);
      expect(claimBody.agent.wallet_address).toBe(VALID_WALLET.address);

      const onboardingRes = await fetch(`${baseUrl}/api/v1/agents/byo/onboarding/${createBody.session_id}`);
      expect(onboardingRes.status).toBe(200);
      const onboardingBody = await onboardingRes.json() as {
        status: string;
        wallet_address: string;
        agent_url: string;
        wallet_download_ready: boolean;
        wallet_downloaded_at: number | null;
        identity: { avatar: string };
      };
      expect(onboardingBody.status).toBe("claimed");
      expect(onboardingBody.wallet_address).toBe(VALID_WALLET.address);
      expect(onboardingBody.agent_url).toBe("https://agent.example.com/");
      expect(onboardingBody.wallet_download_ready).toBe(true);
      expect(onboardingBody.wallet_downloaded_at).toBeNull();
      expect(onboardingBody.identity.avatar).toBe("🦞");

      const agentRow = db.prepare("SELECT wallet_address, status, avatar_emoji FROM agents WHERE id = ?").get(claimBody.agent.id) as {
        wallet_address: string;
        status: string;
        avatar_emoji: string;
      } | undefined;
      expect(agentRow?.wallet_address).toBe(VALID_WALLET.address);
      expect(agentRow?.status).toBe("inactive");
      expect(agentRow?.avatar_emoji).toBe("🦞");

      const walletDownloadRes = await fetch(`${baseUrl}/api/v1/agents/byo/onboarding/${createBody.session_id}/wallet-download`, {
        method: "POST",
      });
      expect(walletDownloadRes.status).toBe(200);
      const walletDownloadBody = await walletDownloadRes.json() as {
        address: string;
        privateKey: string;
        seedPhrase: string;
      };
      expect(walletDownloadBody.address).toBe(VALID_WALLET.address);
      expect(walletDownloadBody.privateKey).toBe(VALID_WALLET.privateKey);
      expect(walletDownloadBody.seedPhrase).toBe(VALID_WALLET.seedPhrase);

      const postDownloadRes = await fetch(`${baseUrl}/api/v1/agents/byo/onboarding/${createBody.session_id}`);
      expect(postDownloadRes.status).toBe(200);
      const postDownloadBody = await postDownloadRes.json() as {
        wallet_download_ready: boolean;
        wallet_downloaded_at: number | null;
        wallet_private_key?: string;
      };
      expect(postDownloadBody.wallet_download_ready).toBe(false);
      expect(postDownloadBody.wallet_downloaded_at).not.toBeNull();
      expect(postDownloadBody.wallet_private_key).toBeUndefined();

      const replayDownloadRes = await fetch(`${baseUrl}/api/v1/agents/byo/onboarding/${createBody.session_id}/wallet-download`, {
        method: "POST",
      });
      expect(replayDownloadRes.status).toBe(410);

      const updateConfigRes = await fetch(`${baseUrl}/api/v1/agents/${claimBody.agent.id}/byo-config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint_url: "https://agent.example.com/openclaw-events",
          webhook_events: ["trade:executed"],
        }),
      });
      expect(updateConfigRes.status).toBe(200);
      const updateConfigBody = await updateConfigRes.json() as {
        success: boolean;
        data: {
          agent_url: string;
          endpoint_url: string;
          webhook_events: string[];
        };
      };
      expect(updateConfigBody.success).toBe(true);
      expect(updateConfigBody.data.agent_url).toBe("https://agent.example.com/");
      expect(updateConfigBody.data.endpoint_url).toBe("https://agent.example.com/openclaw-events");
      expect(updateConfigBody.data.webhook_events).toEqual(["trade:executed"]);

      const deployRes = await fetch(`${baseUrl}/api/v1/agents/${claimBody.agent.id}/deploy`, {
        method: "POST",
      });
      expect(deployRes.status).toBe(200);
      const deployBody = await deployRes.json() as { status: string };
      expect(deployBody.status).toBe("active");

      const replayRes = await fetch(createBody.onboarding_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(claimPayload),
      });
      expect(replayRes.status).toBe(409);
    } finally {
      await closeServer(server);
    }
  });

  test("BYO claim rejects requests without agent_url", async () => {
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      seedUser(getDb, currentUserId!);

      const createRes = await fetch(`${baseUrl}/api/v1/agents/byo/onboarding`, {
        method: "POST",
      });
      const createBody = await createRes.json() as { onboarding_url: string };

      const claimRes = await fetch(createBody.onboarding_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "OpenClaw Prime",
        }),
      });

      expect(claimRes.status).toBe(400);
      const claimBody = await claimRes.json() as { error: string };
      expect(claimBody.error).toBe("agent_url is required");
    } finally {
      await closeServer(server);
    }
  });

  test("PG lifecycle updates the primary store and the BYO sqlite mirror", async () => {
    pgEnabled = true;
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO agents (
          id, agent_code, status, name, avatar_emoji, personality, decision_style,
          trading_instinct, time_patience, profit_dream, money_approach,
          protection_mindset, leverage_vibe, market_sense, asset_love,
          system_prompt, wallet_address, user_id, agent_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "agent-pg-byo",
        "Q-AGENT-X999",
        "inactive",
        "Mirror Agent",
        "🤖",
        "balanced",
        "analyst",
        "value_hunter",
        "swing",
        "wealth_builder",
        "smart_scaling",
        "flexible",
        "none",
        "fixed_rules",
        "crypto",
        "BYO mirror",
        VALID_WALLET.address,
        currentUserId,
        "byo",
        Date.now(),
        Date.now(),
      );

      pgQueryOneMock.mockResolvedValueOnce({
        id: "agent-pg-byo",
        user_id: currentUserId,
        agent_type: "byo",
        status: "inactive",
        last_heartbeat: null,
        connection_status: "pending",
      });
      pgExecMock.mockResolvedValueOnce(undefined);

      const deployRes = await fetch(`${baseUrl}/api/v1/agents/agent-pg-byo/deploy`, {
        method: "POST",
      });

      expect(deployRes.status).toBe(200);
      expect(pgExecMock).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE agents SET status = $1, deployed_at = $2, updated_at = $3"),
        ["active", expect.any(Number), expect.any(Number), "agent-pg-byo"]
      );

      const sqliteMirror = db.prepare("SELECT status FROM agents WHERE id = ?").get("agent-pg-byo") as { status: string } | undefined;
      expect(sqliteMirror?.status).toBe("active");
    } finally {
      await closeServer(server);
    }
  });

  test("PG lifecycle rejects non-owner pause attempts", async () => {
    pgEnabled = true;
    const { server, baseUrl } = await startTestServer();

    try {
      pgQueryOneMock.mockResolvedValueOnce(null);

      const res = await fetch(`${baseUrl}/api/v1/agents/agent-pg-byo/pause`, {
        method: "POST",
      });

      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });
});
