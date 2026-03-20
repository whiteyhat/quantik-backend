import fs from "fs";
import os from "os";
import path from "path";

const loadAutopilotExecutionContextsMock = jest.fn();
const loadAgentWalletContextMock = jest.fn();
const getWalletFundingSnapshotMock = jest.fn();
const executeManagedTradeMock = jest.fn();
const getAutopilotPolicyEnvelopeMock = jest.fn();
const insertAutopilotDecisionMock = jest.fn();
const emitAgentAlertMock = jest.fn();
const sendSignalAlertMock = jest.fn();

jest.mock("../src/utils/linkedAgent", () => ({
  loadAutopilotExecutionContexts: (...args: unknown[]) =>
    loadAutopilotExecutionContextsMock(...args),
}));

jest.mock("../src/utils/agentKey", () => ({
  loadAgentWalletContext: (...args: unknown[]) =>
    loadAgentWalletContextMock(...args),
  loadAgentWalletContextWithDiag: async (...args: unknown[]) => {
    try {
      const context = await loadAgentWalletContextMock(...args);
      return { context, error: null };
    } catch (err: any) {
      return { context: null, error: err?.message ?? "Unknown wallet error" };
    }
  },
}));

jest.mock("../src/utils/balances", () => ({
  getWalletFundingSnapshot: (...args: unknown[]) =>
    getWalletFundingSnapshotMock(...args),
}));

jest.mock("../src/services/tradeExecution", () => ({
  executeManagedTrade: (...args: unknown[]) =>
    executeManagedTradeMock(...args),
}));

jest.mock("../src/services/autopilotPolicy", () => ({
  getAutopilotPolicyEnvelope: (...args: unknown[]) =>
    getAutopilotPolicyEnvelopeMock(...args),
  insertAutopilotDecision: (...args: unknown[]) =>
    insertAutopilotDecisionMock(...args),
}));

jest.mock("../src/infra/socket", () => ({
  emitAgentAlert: (...args: unknown[]) => emitAgentAlertMock(...args),
  emitAutopilotStatus: jest.fn(),
}));

jest.mock("../src/alerts/telegramAlert", () => ({
  sendSignalAlert: (...args: unknown[]) => sendSignalAlertMock(...args),
}));

async function initScannerTest() {
  if (!process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-market-scanner-"));
  }

  const { MarketScanner } = require("../src/scanner/marketScanner") as typeof import("../src/scanner/marketScanner");
  const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");
  const db = getDb();
  db.prepare("DELETE FROM executions").run();

  return {
    scanner: new MarketScanner(),
    db,
  };
}

function buildPolicy(useAuraSentiment = true) {
  return {
    derived: {
      cadenceMinutes: 15,
      cooldownMinutes: 60,
      maxTradesPerDay: 10,
      maxBetUsdc: 50,
      minSigma: 0.7,
      minKelly: 0.03,
      kellyMultiplier: 0.5,
      maxPositionFraction: 0.15,
      dailyLossLimitPct: 0.08,
      useAuraSentiment,
    },
    overrides: {
      cadenceMinutes: null,
      cooldownMinutes: null,
      maxTradesPerDay: null,
      maxBetUsdc: null,
      updatedAt: null,
    },
    effective: {
      cadenceMinutes: 15,
      cooldownMinutes: 60,
      maxTradesPerDay: 10,
      maxBetUsdc: 50,
      minSigma: 0.7,
      minKelly: 0.03,
      kellyMultiplier: 0.5,
      maxPositionFraction: 0.15,
      dailyLossLimitPct: 0.08,
      useAuraSentiment,
    },
  };
}

function buildScanResult(
  overrides: Partial<import("../src/scanner/marketScanner").ScanResult> = {}
): import("../src/scanner/marketScanner").ScanResult {
  return {
    slug: "will-btc-hit-100k",
    tokenId: "yes-token",
    noTokenId: "no-token",
    yesPrice: 0.58,
    scannedAt: Date.now(),
    sigmaConfidence: 0.82,
    kellyFraction: 0.2,
    recommendation: "BET_YES",
    probability: 0.61,
    alertSent: false,
    shouldAlert: true,
    pipelineResult: {
      edge_agent: { direction: "YES" },
      aura: { sentimentDelta: 0, confidence: 0.5, dataSufficiency: 0.5 },
      sigma: { thesis: "Consensus favors YES" },
      clause: { risk_level: "LOW" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: false,
  } as Response);
  loadAutopilotExecutionContextsMock.mockReset();
  loadAgentWalletContextMock.mockReset();
  getWalletFundingSnapshotMock.mockReset();
  executeManagedTradeMock.mockReset();
  getAutopilotPolicyEnvelopeMock.mockReset();
  insertAutopilotDecisionMock.mockReset();
  emitAgentAlertMock.mockReset();
  sendSignalAlertMock.mockReset();

  loadAutopilotExecutionContextsMock.mockResolvedValue([]);
  loadAgentWalletContextMock.mockImplementation(async (agentId: string) => ({
    agentId,
    walletAddress: `0x${agentId.padEnd(40, "1").slice(0, 40)}`,
    privateKey: `pk-${agentId}`,
  }));
  getWalletFundingSnapshotMock.mockResolvedValue({
    address: "0x1111111111111111111111111111111111111111",
    onChainUsdc: 200,
    pol: 1,
    clobBalance: 200,
    usdcStatus: "live",
    polStatus: "live",
    fundingStatus: "ready",
    fundingMessage: "Wallet funded",
    ready: true,
  });
  executeManagedTradeMock.mockResolvedValue({
    ok: true,
    orderId: "paper-1",
    paper: true,
    status: "paper",
    tokenId: "yes-token",
    direction: "YES",
    size: 20,
    price: 0.58,
    slug: "will-btc-hit-100k",
    rawData: { orderId: "paper-1" },
  });
  getAutopilotPolicyEnvelopeMock.mockImplementation(async (attrs: { market_sense?: string | null }) =>
    buildPolicy(attrs.market_sense === "mood_reader")
  );
  insertAutopilotDecisionMock.mockResolvedValue(undefined);
  sendSignalAlertMock.mockResolvedValue(undefined);
});

describe("MarketScanner autopilot execution", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    delete process.env.PORTFOLIO_USDC;
  });

  test("does nothing when no active autopilot contexts exist", async () => {
    const { scanner } = await initScannerTest();

    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");

    expect(getWalletFundingSnapshotMock).not.toHaveBeenCalled();
    expect(executeManagedTradeMock).not.toHaveBeenCalled();
    expect(insertAutopilotDecisionMock).not.toHaveBeenCalled();
  });

  test("enabled agents that are not execution-ready still emit funding and prep skip decisions", async () => {
    const { scanner } = await initScannerTest();

    loadAutopilotExecutionContextsMock.mockResolvedValue([
      {
        userId: "user-funding",
        agentId: "agent-funding",
        status: "active",
        agentType: "created",
        walletAddress: "0x1111111111111111111111111111111111111111",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "smart_scaling",
        protectionMindset: "flexible",
        marketSense: "mood_reader",
        polymarketReady: false,
      },
      {
        userId: "user-prep",
        agentId: "agent-prep",
        status: "active",
        agentType: "created",
        walletAddress: "0x2222222222222222222222222222222222222222",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "smart_scaling",
        protectionMindset: "flexible",
        marketSense: "mood_reader",
        polymarketReady: false,
      },
    ]);

    getWalletFundingSnapshotMock
      .mockResolvedValueOnce({
        address: "0x1111111111111111111111111111111111111111",
        onChainUsdc: 2,
        pol: 0.5,
        clobBalance: 0,
        usdcStatus: "live",
        polStatus: "live",
        fundingStatus: "funding_required",
        fundingMessage: "Deposit >= 3 POL for Polygon fees and >= 10 USDC.e for Polymarket trades before enabling autopilot.",
        ready: false,
      })
      .mockResolvedValueOnce({
        address: "0x2222222222222222222222222222222222222222",
        onChainUsdc: 25,
        pol: 4,
        clobBalance: 25,
        usdcStatus: "live",
        polStatus: "live",
        fundingStatus: "ready",
        fundingMessage: "Wallet meets the >= 3 POL and >= 10 USDC.e autopilot requirements.",
        ready: true,
      });

    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");

    expect(executeManagedTradeMock).not.toHaveBeenCalled();
    expect(insertAutopilotDecisionMock).toHaveBeenCalledTimes(2);
    expect(insertAutopilotDecisionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: "agent-funding",
        decision: "skipped",
        reasonCode: "funding",
      })
    );
    expect(insertAutopilotDecisionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: "agent-prep",
        decision: "skipped",
        reasonCode: "polymarket_prep",
      })
    );
  });

  test("recent manual trades do not trip autopilot cadence gates", async () => {
    const { scanner, db } = await initScannerTest();

    loadAutopilotExecutionContextsMock.mockResolvedValue([
      {
        userId: "user-1",
        agentId: "agent-1",
        status: "active",
        agentType: "created",
        walletAddress: "0x1111111111111111111111111111111111111111",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "smart_scaling",
        protectionMindset: "flexible",
        marketSense: "mood_reader",
        polymarketReady: true,
      },
    ]);

    db.prepare(
      `INSERT INTO executions (user_id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("user-1", "agent-1", "manual-primer", "buy", "YES", "manual", 15, Date.now() - 5 * 60_000, "placed", 0.52);

    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");

    expect(executeManagedTradeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        source: "autopilot",
      })
    );
    expect(insertAutopilotDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", decision: "executed", reasonCode: "executed" })
    );
  });

  test("uses separate wallet contexts per enabled agent and sizes from wallet balance instead of env bankroll", async () => {
    const { scanner } = await initScannerTest();
    process.env.PORTFOLIO_USDC = "999999";

    loadAutopilotExecutionContextsMock.mockResolvedValue([
      {
        userId: "user-1",
        agentId: "agent-1",
        status: "active",
        agentType: "created",
        walletAddress: "0x1111111111111111111111111111111111111111",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "smart_scaling",
        protectionMindset: "flexible",
        marketSense: "mood_reader",
        polymarketReady: true,
      },
      {
        userId: "user-2",
        agentId: "agent-2",
        status: "active",
        agentType: "created",
        walletAddress: "0x2222222222222222222222222222222222222222",
        autopilotEnabled: true,
        personality: "guardian",
        decisionStyle: "observer",
        tradingInstinct: "value_hunter",
        timePatience: "swing",
        moneyApproach: "fixed_safe",
        protectionMindset: "tight",
        marketSense: "fixed_rules",
        polymarketReady: true,
      },
    ]);
    getWalletFundingSnapshotMock
      .mockResolvedValueOnce({
        address: "0x1111111111111111111111111111111111111111",
        onChainUsdc: 200,
        pol: 1,
        clobBalance: 200,
        usdcStatus: "live",
        polStatus: "live",
        fundingStatus: "ready",
        fundingMessage: "Wallet funded",
        ready: true,
      })
      .mockResolvedValueOnce({
        address: "0x2222222222222222222222222222222222222222",
        onChainUsdc: 80,
        pol: 1,
        clobBalance: 80,
        usdcStatus: "live",
        polStatus: "live",
        fundingStatus: "ready",
        fundingMessage: "Wallet funded",
        ready: true,
      });

    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");

    expect(loadAgentWalletContextMock).toHaveBeenNthCalledWith(1, "agent-1");
    expect(loadAgentWalletContextMock).toHaveBeenNthCalledWith(2, "agent-2");
    expect(executeManagedTradeMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: "user-1",
        agentId: "agent-1",
        walletPrivateKey: "pk-agent-1",
        source: "autopilot",
        sizeUsdc: 20,
      })
    );
    expect(executeManagedTradeMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: "user-2",
        agentId: "agent-2",
        walletPrivateKey: "pk-agent-2",
        source: "autopilot",
        sizeUsdc: 8,
      })
    );
    expect(insertAutopilotDecisionMock).toHaveBeenCalledTimes(2);
    expect(insertAutopilotDecisionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId: "agent-1", decision: "executed", reasonCode: "executed" })
    );
    expect(insertAutopilotDecisionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ agentId: "agent-2", decision: "executed", reasonCode: "executed" })
    );
  });

  test("funded wallets below the old five-dollar floor still execute autopilot trades", async () => {
    const { scanner } = await initScannerTest();

    loadAutopilotExecutionContextsMock.mockResolvedValue([
      {
        userId: "user-1",
        agentId: "agent-1",
        status: "active",
        agentType: "created",
        walletAddress: "0x1111111111111111111111111111111111111111",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "aggressive",
        protectionMindset: "flexible",
        marketSense: "mood_reader",
        polymarketReady: true,
      },
    ]);
    getWalletFundingSnapshotMock.mockResolvedValue({
      address: "0x1111111111111111111111111111111111111111",
      onChainUsdc: 16,
      pol: 1,
      clobBalance: 16,
      usdcStatus: "live",
      polStatus: "live",
      fundingStatus: "ready",
      fundingMessage: "Wallet funded",
      ready: true,
    });
    getAutopilotPolicyEnvelopeMock.mockResolvedValue({
      derived: {
        cadenceMinutes: 60,
        cooldownMinutes: 360,
        maxTradesPerDay: 6,
        maxBetUsdc: 5,
        minSigma: 0.72,
        minKelly: 0.03,
        kellyMultiplier: 0.25,
        maxPositionFraction: 0.15,
        dailyLossLimitPct: 0.08,
        useAuraSentiment: true,
      },
      overrides: {
        cadenceMinutes: null,
        cooldownMinutes: null,
        maxTradesPerDay: 7,
        maxBetUsdc: 5,
        updatedAt: Date.now(),
      },
      effective: {
        cadenceMinutes: 60,
        cooldownMinutes: 360,
        maxTradesPerDay: 7,
        maxBetUsdc: 5,
        minSigma: 0.72,
        minKelly: 0.03,
        kellyMultiplier: 0.25,
        maxPositionFraction: 0.15,
        dailyLossLimitPct: 0.08,
        useAuraSentiment: true,
      },
    });

    await scanner.autoExecute(
      buildScanResult({
        sigmaConfidence: 0.79,
        kellyFraction: 0.084,
      }),
      "Will BTC hit 100k?"
    );

    expect(executeManagedTradeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        source: "autopilot",
        sizeUsdc: 1,
      })
    );
    expect(insertAutopilotDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", decision: "executed", reasonCode: "executed", sizeUsdc: 1 })
    );
  });

  test("fixed_rules ignores aura direction override while mood_reader uses it", async () => {
    const { scanner } = await initScannerTest();

    loadAutopilotExecutionContextsMock.mockResolvedValue([
      {
        userId: "user-fixed",
        agentId: "agent-fixed",
        status: "active",
        agentType: "created",
        walletAddress: "0x3333333333333333333333333333333333333333",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "smart_scaling",
        protectionMindset: "flexible",
        marketSense: "fixed_rules",
        polymarketReady: true,
      },
      {
        userId: "user-aura",
        agentId: "agent-aura",
        status: "active",
        agentType: "created",
        walletAddress: "0x4444444444444444444444444444444444444444",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "smart_scaling",
        protectionMindset: "flexible",
        marketSense: "mood_reader",
        polymarketReady: true,
      },
    ]);

    await scanner.autoExecute(
      buildScanResult({
        recommendation: "BET_NO",
        pipelineResult: {
          edge_agent: { direction: "YES" },
          aura: { sentimentDelta: -0.4, confidence: 0.8, dataSufficiency: 0.9 },
          sigma: { thesis: "Aura pushes this to NO" },
          clause: { risk_level: "LOW" },
        },
      }),
      "Will BTC hit 100k?"
    );

    expect(executeManagedTradeMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId: "agent-fixed", direction: "YES", source: "autopilot" })
    );
    expect(executeManagedTradeMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ agentId: "agent-aura", direction: "NO", source: "autopilot" })
    );
  });

  test("same-day trades are allowed again once cooldown has passed", async () => {
    const { scanner, db } = await initScannerTest();

    loadAutopilotExecutionContextsMock.mockResolvedValue([
      {
        userId: "user-1",
        agentId: "agent-1",
        status: "active",
        agentType: "created",
        walletAddress: "0x1111111111111111111111111111111111111111",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "smart_scaling",
        protectionMindset: "flexible",
        marketSense: "mood_reader",
        polymarketReady: true,
      },
    ]);

    db.prepare(
      `INSERT INTO executions (user_id, agent_id, slug, side, direction, source, amount, executed_at, status, fill_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("user-1", "agent-1", "will-btc-hit-100k", "buy", "YES", "autopilot", 12, Date.now() - 61 * 60_000, "placed", 0.58);

    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");

    expect(executeManagedTradeMock).toHaveBeenCalledTimes(1);
    expect(insertAutopilotDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", decision: "executed", reasonCode: "executed" })
    );
  });

  test("failed executions are audited and a later retry is still allowed", async () => {
    const { scanner } = await initScannerTest();

    loadAutopilotExecutionContextsMock.mockResolvedValue([
      {
        userId: "user-1",
        agentId: "agent-1",
        status: "active",
        agentType: "created",
        walletAddress: "0x1111111111111111111111111111111111111111",
        autopilotEnabled: true,
        personality: "balanced",
        decisionStyle: "analyst",
        tradingInstinct: "trend_chaser",
        timePatience: "swing",
        moneyApproach: "smart_scaling",
        protectionMindset: "flexible",
        marketSense: "mood_reader",
        polymarketReady: true,
      },
    ]);
    executeManagedTradeMock
      .mockResolvedValueOnce({
        ok: false,
        orderId: null,
        paper: false,
        status: "failed",
        tokenId: "yes-token",
        direction: "YES",
        size: 20,
        price: 0.58,
        slug: "will-btc-hit-100k",
        rawData: { error: "cli boom" },
        error: "cli boom",
      })
      .mockResolvedValueOnce({
        ok: true,
        orderId: "order-retry",
        paper: false,
        status: "placed",
        tokenId: "yes-token",
        direction: "YES",
        size: 20,
        price: 0.58,
        slug: "will-btc-hit-100k",
        rawData: { id: "order-retry" },
      });

    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");
    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");

    expect(executeManagedTradeMock).toHaveBeenCalledTimes(2);
    expect(insertAutopilotDecisionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ decision: "failed", reasonCode: "cli_error", error: "cli boom" })
    );
    expect(insertAutopilotDecisionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ decision: "executed", reasonCode: "executed" })
    );
  });
});
