import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

let currentUserId: string | null = "user-chat";
const getWalletFundingSnapshotMock = jest.fn();

jest.mock("../src/middleware/auth", () => ({
  getUserId: jest.fn(() => currentUserId),
  getUserIdAsync: jest.fn(async () => currentUserId),
}));

jest.mock("../src/utils/balances", () => ({
  getWalletFundingSnapshot: (...args: unknown[]) => getWalletFundingSnapshotMock(...args),
}));

async function startServer() {
  jest.resetModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-agent-chat-"));
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;

  const express = require("express") as typeof import("express");
  const { default: agentChatRouter } = require("../src/routes/agentChat") as typeof import("../src/routes/agentChat");
  const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");

  const app = express();
  app.use(express.json());
  app.use("/api/v1", agentChatRouter);

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, getDb };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function seedUser(getDb: typeof import("../src/db/schema").getDb, userId: string) {
  const db = getDb();
  db.prepare("INSERT INTO users (id, clerk_id, created_at) VALUES (?, ?, ?)").run(userId, `clerk-${userId}`, Date.now());
  return db;
}

function seedAgent(
  db: ReturnType<typeof import("../src/db/schema").getDb>,
  userId: string,
  overrides: Partial<{
    id: string;
    name: string;
    agent_type: string;
    connection_status: string | null;
    status: string;
    wallet_address: string | null;
    autopilot_enabled: number;
  }> = {},
) {
  const now = Date.now();
  const agent = {
    id: overrides.id ?? `agent-${Math.random().toString(16).slice(2, 10)}`,
    agent_code: `Q-AGENT-${Math.floor(Math.random() * 900 + 100)}`,
    status: overrides.status ?? "active",
    name: overrides.name ?? "Scoped Agent",
    avatar_emoji: "🦊",
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
    wallet_address: overrides.wallet_address ?? "0x1111111111111111111111111111111111111111",
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
      autopilot_enabled, autopilot_updated_at, created_at, updated_at
    ) VALUES (
      @id, @agent_code, @status, @name, @avatar_emoji,
      @personality, @decision_style, @trading_instinct, @time_patience, @profit_dream,
      @money_approach, @protection_mindset, @leverage_vibe, @market_sense, @asset_love,
      @system_prompt, @wallet_address, @user_id, @agent_type, @endpoint_url, @agent_url,
      @connection_status, @last_heartbeat, @description, @webhook_secret, @webhook_events,
      @autopilot_enabled, @autopilot_updated_at, @created_at, @updated_at
    )
  `).run(agent);

  db.prepare("UPDATE users SET agent_id = ? WHERE id = ?").run(agent.id, userId);
  return agent.id;
}

function seedExecution(
  db: ReturnType<typeof import("../src/db/schema").getDb>,
  agentId: string,
  slug: string,
  amount: number,
  executedAt: number,
  overrides: Partial<{ side: string; status: string; fill_price: number | null; pnl: number | null }> = {},
) {
  db.prepare(
    `INSERT INTO executions (user_id, agent_id, slug, side, amount, executed_at, status, order_id, fill_price, pnl)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    currentUserId,
    agentId,
    slug,
    overrides.side ?? "buy",
    amount,
    executedAt,
    overrides.status ?? "placed",
    null,
    overrides.fill_price ?? 0.45,
    overrides.pnl ?? null,
  );
}

function seedScanner(
  db: ReturnType<typeof import("../src/db/schema").getDb>,
  slug: string,
  scannedAt: number,
  overrides: Partial<{ sigma: number; kelly: number; recommendation: string; probability: number }> = {},
) {
  db.prepare(
    `INSERT INTO scanner_results (slug, scanned_at, sigma_confidence, kelly_fraction, recommendation, probability, alert_sent, pipeline_result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    slug,
    scannedAt,
    overrides.sigma ?? 0.81,
    overrides.kelly ?? 0.52,
    overrides.recommendation ?? "BET_YES",
    overrides.probability ?? 0.61,
    1,
    JSON.stringify({ market_question: `Question for ${slug}` }),
  );
}

function seedRiskConfig(db: ReturnType<typeof import("../src/db/schema").getDb>) {
  const now = Date.now();
  db.prepare(
    "INSERT OR REPLACE INTO risk_configurations (id, user_id, version, is_active, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)"
  ).run("risk-config-1", currentUserId, now, now);
  db.prepare(
    "INSERT OR REPLACE INTO global_circuit_breakers (id, risk_configuration_id, panic_mode_enabled, drawdown_limit_pct, max_position_size_pct, kelly_fraction_multiplier, created_at, updated_at) VALUES (?, ?, 0, 0.15, 0.10, 0.25, ?, ?)"
  ).run("gcb-1", "risk-config-1", now, now);
  db.prepare(
    "INSERT OR REPLACE INTO agent_thresholds (id, risk_configuration_id, agent_name, agent_status, var_threshold, auto_exec_enabled, created_at, updated_at) VALUES (?, ?, 'lucifer', 'active', 0.03, 1, ?, ?)"
  ).run("threshold-1", "risk-config-1", now, now);
  db.prepare(
    "INSERT OR REPLACE INTO circuit_breaker_state (id, state, drawdown_pct, triggered_at, last_checked_at) VALUES (1, 'ARMED', 0.02, NULL, ?)"
  ).run(now);
}

function parseSseBody(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

beforeEach(() => {
  currentUserId = "user-chat";
  process.env.GEMINI_API_KEY = "";
  getWalletFundingSnapshotMock.mockReset();
  getWalletFundingSnapshotMock.mockResolvedValue({
    address: "0x1111111111111111111111111111111111111111",
    onChainUsdc: 125,
    pol: 2,
    usdcStatus: "live",
    polStatus: "live",
    fundingStatus: "ready",
    fundingMessage: "Wallet is funded.",
    ready: true,
  });
  jest.restoreAllMocks();
});

describe("agent chat route", () => {
  test("portfolio status uses linked-agent scoped data and avoids generic access denial", async () => {
    const { server, baseUrl, getDb } = await startServer();

    try {
      const db = seedUser(getDb, currentUserId!);
      seedRiskConfig(db);
      const linkedAgentId = seedAgent(db, currentUserId!, { id: "agent-linked" });
      const otherAgentId = seedAgent(db, currentUserId!, { id: "agent-other", name: "Other Agent" });
      db.prepare("UPDATE users SET agent_id = ? WHERE id = ?").run(linkedAgentId, currentUserId!);

      seedExecution(db, linkedAgentId, "linked-market", 25, Date.now() - 60_000);
      seedExecution(db, otherAgentId, "other-market", 80, Date.now() - 60_000);
      seedScanner(db, "linked-market", Date.now() - 30_000, { probability: 0.7 });
      seedScanner(db, "other-market", Date.now() - 30_000, { probability: 0.2 });

      const response = await fetch(`${baseUrl}/api/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "What's my portfolio status?" }),
      });

      expect(response.status).toBe(200);
      const events = parseSseBody(await response.text());
      const done = events.find((event) => event.type === "done");
      const portfolioContext = events.find((event) => event.type === "context" && event.kind === "portfolio")
        ?? ((done?.contexts as Record<string, unknown> | undefined)?.portfolio as Record<string, unknown> | undefined);

      expect(portfolioContext).toBeDefined();
      const scopedPortfolio = ("data" in (portfolioContext as Record<string, unknown>)
        ? (portfolioContext as { data?: { positions?: Array<{ slug: string }> } }).data
        : portfolioContext) as { positions?: Array<{ slug: string }> };
      expect(scopedPortfolio.positions?.map((position) => position.slug)).toEqual(["linked-market"]);
      expect(String(done?.reply ?? "")).not.toMatch(/do not have access/i);
    } finally {
      await closeServer(server);
    }
  });

  test("scanner signals report freshness and new items without triggering a live scan", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const { server, baseUrl, getDb } = await startServer();

    try {
      const db = seedUser(getDb, currentUserId!);
      seedRiskConfig(db);
      seedAgent(db, currentUserId!, { id: "agent-scanner" });

      seedScanner(db, "old-signal", Date.now() - 12 * 60_000, { sigma: 0.74 });
      seedScanner(db, "new-signal", Date.now() - 60_000, { sigma: 0.87 });

      const response = await fetch(`${baseUrl}/api/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Any new scanner signals?",
          clientContext: { lastSeenSignalAt: Date.now() - 10 * 60_000 },
        }),
      });

      const events = parseSseBody(await response.text());
      const scannerContext = events.find((event) => event.type === "context" && event.kind === "scanner");
      const scannerData = scannerContext?.data as { newSignalCount?: number; stale?: boolean; action?: { message?: string } };
      const done = events.find((event) => event.type === "done");
      const suggestions = (done?.suggestions as string[] | undefined) ?? [];

      expect(scannerData.newSignalCount).toBe(1);
      expect(scannerData.action?.message).toBe("Refresh scanner signals now.");
      expect(suggestions).toContain("Why is Question for new-signal the top setup right now?");
      expect(suggestions).toContain("Does Question for new-signal fit my current risk limits?");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });

  test("BYO chat resolves ops context without leaking global agent state", async () => {
    const { server, baseUrl, getDb } = await startServer();

    try {
      const db = seedUser(getDb, currentUserId!);
      seedRiskConfig(db);
      const byoAgentId = seedAgent(db, currentUserId!, {
        id: "agent-byo",
        agent_type: "byo",
        connection_status: "connected",
      });
      db.prepare("INSERT INTO byo_request_log (agent_id, user_id, tool_name, method, status_code, latency_ms, error, created_at) VALUES (?, ?, 'heartbeat', 'POST', 200, 50, NULL, ?)").run(byoAgentId, currentUserId!, Date.now() - 120_000);
      db.prepare("INSERT INTO byo_request_log (agent_id, user_id, tool_name, method, status_code, latency_ms, error, created_at) VALUES (?, ?, 'get_portfolio', 'GET', 200, 40, NULL, ?)").run(byoAgentId, currentUserId!, Date.now() - 60_000);

      const response = await fetch(`${baseUrl}/api/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "What's my agent health?" }),
      });

      const events = parseSseBody(await response.text());
      const opsContext = events.find((event) => event.type === "context" && event.kind === "ops");
      const opsData = opsContext?.data as { agentType?: string; connectionStatus?: string; health?: { status?: string } };

      expect(opsData.agentType).toBe("byo");
      expect(opsData.connectionStatus).toBe("connected");
      expect(opsData.health?.status).toBeDefined();
    } finally {
      await closeServer(server);
    }
  });

  test("agent chat humanizes replies and caps them at 60 words", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) {
        return nativeFetch(input, init);
      }
      if (url.includes(":generateContent")) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: "Great question. This setup showcases a transformative edge across the broader market landscape, and it serves as a pivotal signal for what could potentially unfold next — especially if momentum keeps building. I hope this helps. Let me know if you'd like me to break down the full scenario, the likely pathways, and the supporting context in more detail.",
              }],
            },
          }],
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });

    const { server, baseUrl, getDb } = await startServer();

    try {
      const db = seedUser(getDb, currentUserId!);
      seedAgent(db, currentUserId!, { id: "agent-humanizer" });

      const response = await fetch(`${baseUrl}/api/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Give me a quick read." }),
      });

      const events = parseSseBody(await response.text());
      const done = events.find((event) => event.type === "done");
      const reply = String(done?.reply ?? "");
      const wordCount = reply.split(/\s+/).filter(Boolean).length;

      expect(wordCount).toBeLessThanOrEqual(60);
      expect(reply).not.toMatch(/great question/i);
      expect(reply).not.toMatch(/I hope this helps/i);
      expect(reply).not.toMatch(/let me know/i);
      expect(reply).not.toMatch(/[—–]/);
      expect(reply).not.toContain("...");
    } finally {
      fetchMock.mockRestore();
      await closeServer(server);
    }
  });

  test("relay chat pushes funding and autopilot onboarding when the wallet is not ready", async () => {
    getWalletFundingSnapshotMock.mockResolvedValue({
      address: "0x1111111111111111111111111111111111111111",
      onChainUsdc: 0,
      pol: 0,
      usdcStatus: "live",
      polStatus: "live",
      fundingStatus: "needs_funding",
      fundingMessage: "Fund the wallet with USDC.e and POL before trading.",
      ready: false,
    });

    const { server, baseUrl, getDb } = await startServer();

    try {
      const db = seedUser(getDb, currentUserId!);
      seedRiskConfig(db);
      seedAgent(db, currentUserId!, { id: "agent-onboarding", autopilot_enabled: 0 });

      const response = await fetch(`${baseUrl}/api/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "What's my portfolio status?" }),
      });

      const events = parseSseBody(await response.text());
      const done = events.find((event) => event.type === "done");
      const reply = String(done?.reply ?? "");
      const suggestions = (done?.suggestions as string[] | undefined) ?? [];

      expect(reply).toMatch(/USDC\.e and POL/i);
      expect(suggestions[0]).toBe("How do I fund this wallet with USDC.e and POL?");
      expect(suggestions).toContain("Show me exactly what this wallet is missing for Polymarket.");
    } finally {
      await closeServer(server);
    }
  });

  test("session id preserves chat history and generic turns can chain multiple tools", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const capturedBodies: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) {
        return nativeFetch(input, init);
      }
      if (url.includes(":generateContent")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        capturedBodies.push(body);
        const contents = body.contents as Array<{ parts?: Array<{ functionResponse?: unknown; text?: string }> }>;
        const hasToolResponse = (toolName: string) =>
          contents.some((item) =>
            item.parts?.some((part) =>
              part.functionResponse && JSON.stringify(part.functionResponse).includes(toolName),
            ),
          );

        if (hasToolResponse("get_trade_history")) {
          return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Combined status ready with portfolio, risk, and recent trades." }] } }],
          }), { status: 200 });
        }
        if (hasToolResponse("get_risk_status")) {
          return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: { name: "get_trade_history", args: { limit: 3 } } }] } }],
          }), { status: 200 });
        }
        if (hasToolResponse("get_portfolio")) {
          return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: { name: "get_risk_status", args: {} } }] } }],
          }), { status: 200 });
        }
        const lastText = contents.flatMap((item) => item.parts ?? []).map((part) => part.text).filter((text): text is string => Boolean(text)).at(-1) ?? "";
        if (lastText.includes("Give me the full picture")) {
          return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: { name: "get_portfolio", args: {} } }] } }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Combined status ready with portfolio, risk, and recent trades." }] } }],
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });

    const { server, baseUrl, getDb } = await startServer();

    try {
      const db = seedUser(getDb, currentUserId!);
      seedRiskConfig(db);
      const agentId = seedAgent(db, currentUserId!, { id: "agent-generic" });
      seedExecution(db, agentId, "macro-signal", 30, Date.now() - 90_000);
      seedScanner(db, "macro-signal", Date.now() - 45_000, { probability: 0.68 });

      const first = await fetch(`${baseUrl}/api/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": "session-123" },
        body: JSON.stringify({ message: "Give me the full picture.", sessionId: "session-123" }),
      });
      const firstEvents = parseSseBody(await first.text());
      const firstDone = firstEvents.find((event) => event.type === "done");
      const firstReply = firstDone?.reply
        ?? firstEvents.filter((event) => event.type === "token").map((event) => String(event.token ?? "")).join("");

      expect(String(firstReply ?? "")).toContain("Combined status ready");
      expect(firstEvents.filter((event) => event.type === "context").length).toBeGreaterThanOrEqual(2);

      await fetch(`${baseUrl}/api/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": "session-123" },
        body: JSON.stringify({ message: "Continue from that.", sessionId: "session-123" }),
      });

      const secondBody = capturedBodies[capturedBodies.length - 1];
      expect(JSON.stringify(secondBody.contents ?? [])).toContain("Give me the full picture.");
    } finally {
      fetchMock.mockRestore();
      await closeServer(server);
    }
  });
});
