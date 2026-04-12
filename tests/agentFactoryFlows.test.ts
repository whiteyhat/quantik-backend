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
const getWalletFundingSnapshotMock = jest.fn();
const loadAgentWalletContextWithDiagMock = jest.fn();

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

jest.mock("../src/utils/balances", () => ({
  getWalletFundingSnapshot: (...args: unknown[]) => getWalletFundingSnapshotMock(...args),
}));

jest.mock("../src/utils/agentKey", () => ({
  ...jest.requireActual("../src/utils/agentKey"),
  loadAgentWalletContextWithDiag: (...args: unknown[]) => loadAgentWalletContextWithDiagMock(...args),
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

function seedAgent(
  getDb: typeof import("../src/db/schema").getDb,
  userId: string,
  overrides: Partial<{
    id: string;
    agent_code: string;
    status: string;
    name: string;
    avatar_emoji: string;
    wallet_address: string | null;
    agent_type: string;
    endpoint_url: string | null;
    agent_url: string | null;
    connection_status: string | null;
    last_heartbeat: number | null;
    description: string | null;
    webhook_secret: string | null;
    webhook_events: string[];
    autopilot_enabled: number;
    autopilot_updated_at: number | null;
    polymarket_ready: number;
    polymarket_status: string | null;
  }> = {}
) {
  const db = getDb();
  const now = Date.now();
  const record = {
    id: overrides.id ?? `agent-${Math.random().toString(16).slice(2, 10)}`,
    agent_code: overrides.agent_code ?? `Q-AGENT-${Math.floor(Math.random() * 900 + 100)}`,
    status: overrides.status ?? "inactive",
    name: overrides.name ?? "Managed Agent",
    avatar_emoji: overrides.avatar_emoji ?? "🦞",
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
    system_prompt: "Test system prompt",
    wallet_address: overrides.wallet_address ?? VALID_WALLET.address,
    user_id: userId,
    agent_type: overrides.agent_type ?? "created",
    endpoint_url: overrides.endpoint_url ?? null,
    agent_url: overrides.agent_url ?? null,
    connection_status: overrides.connection_status ?? "pending",
    last_heartbeat: overrides.last_heartbeat ?? null,
    description: overrides.description ?? null,
    webhook_secret: overrides.webhook_secret ?? null,
    webhook_events: JSON.stringify(overrides.webhook_events ?? ["*"]),
    autopilot_enabled: overrides.autopilot_enabled ?? 0,
    autopilot_updated_at: overrides.autopilot_updated_at ?? null,
    polymarket_ready: overrides.polymarket_ready ?? 0,
    polymarket_status: overrides.polymarket_status ?? "pending_funding",
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
      autopilot_enabled, autopilot_updated_at, polymarket_ready, polymarket_status, created_at, updated_at
    ) VALUES (
      @id, @agent_code, @status, @name, @avatar_emoji,
      @personality, @decision_style, @trading_instinct, @time_patience, @profit_dream,
      @money_approach, @protection_mindset, @leverage_vibe, @market_sense, @asset_love,
      @system_prompt, @wallet_address, @user_id, @agent_type, @endpoint_url, @agent_url,
      @connection_status, @last_heartbeat, @description, @webhook_secret, @webhook_events,
      @autopilot_enabled, @autopilot_updated_at, @polymarket_ready, @polymarket_status, @created_at, @updated_at
    )
  `).run(record);

  db.prepare("UPDATE users SET agent_id = ? WHERE id = ?").run(record.id, userId);
  return { db, agentId: record.id };
}

beforeEach(() => {
  currentUserId = "user-test";
  pgEnabled = false;
  process.env.CHAIN_MODE = "polymarket";
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  pgQueryMock.mockReset();
  pgQueryOneMock.mockReset();
  pgExecMock.mockReset();
  generateWalletMock.mockReset();
  getWalletFundingSnapshotMock.mockReset();
  loadAgentWalletContextWithDiagMock.mockReset();
  generateWalletMock.mockResolvedValue(VALID_WALLET);
  loadAgentWalletContextWithDiagMock.mockResolvedValue({
    context: {
      agentId: "mock-agent",
      walletAddress: VALID_WALLET.address,
      privateKey: VALID_WALLET.privateKey,
    },
    error: null,
  });
  getWalletFundingSnapshotMock.mockResolvedValue({
    address: VALID_WALLET.address,
    onChainUsdc: 25,
    pol: 3.5,
    clobBalance: 25,
    usdcStatus: "live",
    polStatus: "live",
    fundingStatus: "ready",
    fundingMessage: "Wallet meets the >= 3 POL and >= 10 USDC.e autopilot requirements.",
    ready: true,
  });
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

  test("autopilot enable blocks underfunded wallets and persists enable/disable state for owners", async () => {
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      seedUser(getDb, currentUserId!);
      const { db, agentId: createdAgentId } = seedAgent(getDb, currentUserId!, {
        id: "agent-created-autopilot",
        agent_type: "created",
        avatar_emoji: "🦊",
        polymarket_ready: 1,
        polymarket_status: "ready",
      });
      const { agentId: byoAgentId } = seedAgent(getDb, currentUserId!, {
        id: "agent-byo-autopilot",
        agent_type: "byo",
        avatar_emoji: "🦞",
        agent_url: "https://openclaw.example/agents/lobster",
        endpoint_url: "https://openclaw.example/webhook",
        polymarket_ready: 1,
        polymarket_status: "ready",
      });
      const { agentId: prepBlockedAgentId } = seedAgent(getDb, currentUserId!, {
        id: "agent-prep-blocked",
        agent_type: "created",
        avatar_emoji: "🛑",
        polymarket_ready: 0,
        polymarket_status: "funding_detected",
      });

      getWalletFundingSnapshotMock.mockResolvedValueOnce({
        address: VALID_WALLET.address,
        onChainUsdc: 0,
        pol: 0,
        clobBalance: 0,
        usdcStatus: "live",
        polStatus: "live",
        fundingStatus: "funding_required",
        fundingMessage: "Deposit >= 3 POL for Polygon fees and >= 10 USDC.e for Polymarket trades before enabling autopilot.",
        ready: false,
      });

      const blockedRes = await fetch(`${baseUrl}/api/v1/agents/${createdAgentId}/autopilot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      expect(blockedRes.status).toBe(409);
      const blockedBody = await blockedRes.json() as {
        error: string;
        wallet_address: string;
        pol: number;
        on_chain_usdc: number;
        missing_items: string[];
      };
      expect(blockedBody.error).toBe("AUTOPILOT_FUNDING_REQUIRED");
      expect(blockedBody.wallet_address).toBe(VALID_WALLET.address);
      expect(blockedBody.pol).toBe(0);
      expect(blockedBody.on_chain_usdc).toBe(0);
      expect(blockedBody.missing_items).toEqual([
        "POL balance 0.0000 is below >= 3 POL",
        "USDC.e balance 0.00 is below >= 10 USDC.e",
      ]);

      const blockedRow = db.prepare("SELECT autopilot_enabled FROM agents WHERE id = ?").get(createdAgentId) as {
        autopilot_enabled: number;
      };
      expect(blockedRow.autopilot_enabled).toBe(0);

      getWalletFundingSnapshotMock.mockResolvedValueOnce({
        address: VALID_WALLET.address,
        onChainUsdc: 25,
        pol: 4,
        clobBalance: 25,
        usdcStatus: "live",
        polStatus: "live",
        fundingStatus: "ready",
        fundingMessage: "Wallet meets the >= 3 POL and >= 10 USDC.e autopilot requirements.",
        ready: true,
      });

      const prepBlockedRes = await fetch(`${baseUrl}/api/v1/agents/${prepBlockedAgentId}/autopilot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      expect(prepBlockedRes.status).toBe(409);
      const prepBlockedBody = await prepBlockedRes.json() as {
        error: string;
        polymarket_status: string;
        missing_items: string[];
      };
      expect(prepBlockedBody.error).toBe("AUTOPILOT_POLYMARKET_PREP_REQUIRED");
      expect(prepBlockedBody.polymarket_status).toBe("funding_detected");
      expect(prepBlockedBody.missing_items).toEqual(["Run the Polymarket approval flow for this wallet."]);

      const enableCreatedRes = await fetch(`${baseUrl}/api/v1/agents/${createdAgentId}/autopilot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(enableCreatedRes.status).toBe(200);
      const enableCreatedBody = await enableCreatedRes.json() as {
        autopilot_enabled: boolean;
        autopilot_updated_at: number;
      };
      expect(enableCreatedBody.autopilot_enabled).toBe(true);
      expect(enableCreatedBody.autopilot_updated_at).toBeGreaterThan(0);

      const createdRow = db.prepare(
        "SELECT autopilot_enabled, autopilot_updated_at FROM agents WHERE id = ?"
      ).get(createdAgentId) as { autopilot_enabled: number; autopilot_updated_at: number | null };
      expect(createdRow.autopilot_enabled).toBe(1);
      expect(createdRow.autopilot_updated_at).not.toBeNull();

      const disableCreatedRes = await fetch(`${baseUrl}/api/v1/agents/${createdAgentId}/autopilot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(disableCreatedRes.status).toBe(200);

      const disabledRow = db.prepare("SELECT autopilot_enabled FROM agents WHERE id = ?").get(createdAgentId) as {
        autopilot_enabled: number;
      };
      expect(disabledRow.autopilot_enabled).toBe(0);

      const enableByoRes = await fetch(`${baseUrl}/api/v1/agents/${byoAgentId}/autopilot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(enableByoRes.status).toBe(200);
      const byoRow = db.prepare("SELECT autopilot_enabled FROM agents WHERE id = ?").get(byoAgentId) as {
        autopilot_enabled: number;
      };
      expect(byoRow.autopilot_enabled).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  test("agent-scoped autopilot status and executions routes return only owned data", async () => {
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      const db = seedUser(getDb, currentUserId!);
      const { agentId } = seedAgent(getDb, currentUserId!, {
        id: "agent-owned-status",
        autopilot_enabled: 1,
        polymarket_ready: 1,
        polymarket_status: "ready",
      });

      db.prepare("INSERT INTO users (id, clerk_id, created_at) VALUES (?, ?, ?)").run(
        "user-other",
        "clerk-user-other",
        Date.now()
      );
      const { agentId: foreignAgentId } = seedAgent(getDb, "user-other", {
        id: "agent-foreign-status",
        autopilot_enabled: 1,
        polymarket_ready: 1,
        polymarket_status: "ready",
      });

      const now = Date.now();
      db.prepare(`
        INSERT INTO autopilot_decisions (
          id, agent_id, user_id, slug, direction, decision, reason_code, size_usdc,
          scanned_at, policy_snapshot, signal_snapshot, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "decision-owned-1",
        agentId,
        currentUserId,
        "btc-100k",
        "YES",
        "skipped",
        "cadence",
        null,
        now - 60_000,
        JSON.stringify({
          derived: { cadenceMinutes: 15, cooldownMinutes: 60, maxTradesPerDay: 10, maxBetUsdc: 25, minSigma: 0.7, minKelly: 0.03, kellyMultiplier: 0.25, maxPositionFraction: 0.08, dailyLossLimitPct: 0.08, useAuraSentiment: false },
          overrides: { cadenceMinutes: null, cooldownMinutes: null, maxTradesPerDay: null, maxBetUsdc: null, updatedAt: null },
          effective: { cadenceMinutes: 15, cooldownMinutes: 60, maxTradesPerDay: 10, maxBetUsdc: 25, minSigma: 0.7, minKelly: 0.03, kellyMultiplier: 0.25, maxPositionFraction: 0.08, dailyLossLimitPct: 0.08, useAuraSentiment: false },
        }),
        JSON.stringify({ question: "Will BTC hit 100k?", sigmaConfidence: 0.8, kellyFraction: 0.12 }),
        null
      );

      db.prepare(`
        INSERT INTO executions (
          user_id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price, pnl
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(currentUserId, agentId, "btc-100k", "buy", "YES", "autopilot", 25, now - 120_000, "paper", 0.62, 1.5);
      db.prepare(`
        INSERT INTO executions (
          user_id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price, pnl
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("user-other", foreignAgentId, "eth-5k", "buy", "NO", "autopilot", 15, now - 90_000, "paper", 0.38, -0.5);

      const statusRes = await fetch(`${baseUrl}/api/v1/agents/${agentId}/autopilot-status`);
      expect(statusRes.status).toBe(200);
      const statusBody = await statusRes.json() as {
        agentId: string;
        wallet: { fundingStatus: string };
        activity: { lastReasonCode: string | null };
        blocker: string;
      };
      expect(statusBody.agentId).toBe(agentId);
      expect(statusBody.wallet.fundingStatus).toBe("ready");
      expect(statusBody.activity.lastReasonCode).toBe("cadence");
      expect(statusBody.blocker).toBe("scanner_idle");

      const executionsRes = await fetch(`${baseUrl}/api/v1/agents/${agentId}/executions?limit=10`);
      expect(executionsRes.status).toBe(200);
      const executionsBody = await executionsRes.json() as {
        executions: Array<{ slug: string; source: string }>;
      };
      expect(executionsBody.executions).toHaveLength(1);
      expect(executionsBody.executions[0]).toMatchObject({
        slug: "btc-100k",
        source: "autopilot",
      });

      const foreignRes = await fetch(`${baseUrl}/api/v1/agents/${foreignAgentId}/executions?limit=10`);
      expect(foreignRes.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  test("owner BYO usage endpoint aggregates session-scoped API usage", async () => {
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      const db = seedUser(getDb, currentUserId!);
      const { agentId } = seedAgent(getDb, currentUserId!, {
        id: "agent-byo-usage",
        agent_type: "byo",
        avatar_emoji: "🦞",
      });
      const now = Date.now();
      db.prepare(`
        INSERT INTO byo_request_log (
          agent_id, user_id, tool_name, method, status_code, latency_ms, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(agentId, currentUserId, "get_markets", "GET", 200, 120, null, now - 5_000);
      db.prepare(`
        INSERT INTO byo_request_log (
          agent_id, user_id, tool_name, method, status_code, latency_ms, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(agentId, currentUserId, "get_markets", "GET", 502, 350, "upstream timeout", now - 4_000);

      const res = await fetch(`${baseUrl}/api/v1/agents/${agentId}/usage`);

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        data: {
          total_requests_24h: number;
          requests_last_hour: number;
          error_count_24h: number;
          error_rate_24h: string;
          by_tool: { tool: string; requests: number; avg_latency_ms: number | null; errors: number }[];
          recent_errors: { error: string | null }[];
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.total_requests_24h).toBe(2);
      expect(body.data.requests_last_hour).toBe(2);
      expect(body.data.error_count_24h).toBe(1);
      expect(body.data.error_rate_24h).toBe("50.0%");
      expect(body.data.by_tool).toEqual([
        { tool: "get_markets", requests: 2, avg_latency_ms: 235, errors: 1 },
      ]);
      expect(body.data.recent_errors[0]?.error).toBe("upstream timeout");
    } finally {
      await closeServer(server);
    }
  });

  test("fresh BYO agents report insufficient health telemetry instead of a fake healthy score", async () => {
    const { server, baseUrl, getDb } = await startTestServer();

    try {
      seedUser(getDb, currentUserId!);
      const { agentId } = seedAgent(getDb, currentUserId!, {
        id: "agent-byo-health",
        agent_type: "byo",
        avatar_emoji: "🦞",
        connection_status: "connected",
      });

      const res = await fetch(`${baseUrl}/api/v1/agents/${agentId}/health-score`);

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        data: {
          status: string;
          score: number | null;
          grade: string | null;
          request_samples_24h: number;
          heartbeat_samples_24h: number;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("insufficient_data");
      expect(body.data.score).toBeNull();
      expect(body.data.grade).toBeNull();
      expect(body.data.request_samples_24h).toBe(0);
      expect(body.data.heartbeat_samples_24h).toBe(0);
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
