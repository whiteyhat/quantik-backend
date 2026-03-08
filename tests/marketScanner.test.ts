import fs from "fs";
import os from "os";
import path from "path";

const loadSingleAutopilotExecutionContextMock = jest.fn();
const getWalletFundingSnapshotMock = jest.fn();
const insertExecutionRecordMock = jest.fn();
const sendSignalAlertMock = jest.fn();

jest.mock("../src/utils/linkedAgent", () => ({
  loadSingleAutopilotExecutionContext: (...args: unknown[]) =>
    loadSingleAutopilotExecutionContextMock(...args),
}));

jest.mock("../src/utils/balances", () => ({
  getWalletFundingSnapshot: (...args: unknown[]) =>
    getWalletFundingSnapshotMock(...args),
}));

jest.mock("../src/utils/executions", () => ({
  insertExecutionRecord: (...args: unknown[]) =>
    insertExecutionRecordMock(...args),
}));

jest.mock("../src/alerts/telegramAlert", () => ({
  sendSignalAlert: (...args: unknown[]) => sendSignalAlertMock(...args),
}));

jest.mock("../src/db/queries", () => {
  const actual = jest.requireActual("../src/db/queries");
  return {
    ...actual,
    getSettings: jest.fn(() => ({ id: 1, paper_mode: true })),
  };
});

async function initScannerTest() {
  jest.resetModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-market-scanner-"));
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;

  const { MarketScanner } = require("../src/scanner/marketScanner") as typeof import("../src/scanner/marketScanner");
  const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");

  return {
    scanner: new MarketScanner(),
    db: getDb(),
  };
}

function buildScanResult(): import("../src/scanner/marketScanner").ScanResult {
  return {
    slug: "will-btc-hit-100k",
    tokenId: "yes-token",
    noTokenId: "no-token",
    yesPrice: 0.58,
    scannedAt: Date.now(),
    sigmaConfidence: 0.82,
    kellyFraction: 0.15,
    recommendation: "BET_YES",
    probability: 0.61,
    alertSent: false,
    shouldAlert: true,
    pipelineResult: {
      sigma: { thesis: "Consensus favors YES" },
      clause: { risk_level: "LOW" },
    },
  };
}

beforeEach(() => {
  loadSingleAutopilotExecutionContextMock.mockReset();
  getWalletFundingSnapshotMock.mockReset();
  insertExecutionRecordMock.mockReset();
  sendSignalAlertMock.mockReset();
  insertExecutionRecordMock.mockResolvedValue(undefined);
  sendSignalAlertMock.mockResolvedValue(undefined);
  getWalletFundingSnapshotMock.mockResolvedValue({
    address: "0x1111111111111111111111111111111111111111",
    onChainUsdc: 25,
    pol: 1,
    usdcStatus: "live",
    polStatus: "live",
    fundingStatus: "ready",
    fundingMessage: "Wallet funded",
    ready: true,
  });
});

describe("MarketScanner autopilot execution", () => {
  test("fails closed when autopilot is disabled", async () => {
    const { scanner } = await initScannerTest();

    loadSingleAutopilotExecutionContextMock.mockResolvedValue({
      userId: "user-1",
      agentId: "agent-1",
      status: "active",
      agentType: "created",
      walletAddress: "0x1111111111111111111111111111111111111111",
      autopilotEnabled: false,
    });

    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");

    expect(getWalletFundingSnapshotMock).not.toHaveBeenCalled();
    expect(insertExecutionRecordMock).not.toHaveBeenCalled();
    expect(sendSignalAlertMock).not.toHaveBeenCalled();
  });

  test("paper-mode execution writes the linked owner and agent when autopilot is enabled", async () => {
    const { scanner } = await initScannerTest();

    loadSingleAutopilotExecutionContextMock.mockResolvedValue({
      userId: "user-1",
      agentId: "agent-1",
      status: "active",
      agentType: "byo",
      walletAddress: "0x1111111111111111111111111111111111111111",
      autopilotEnabled: true,
    });

    await scanner.autoExecute(buildScanResult(), "Will BTC hit 100k?");

    expect(getWalletFundingSnapshotMock).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111");
    expect(insertExecutionRecordMock).toHaveBeenCalledTimes(1);
    expect(insertExecutionRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        agentId: "agent-1",
        slug: "will-btc-hit-100k",
        status: "paper",
      })
    );
    expect(sendSignalAlertMock).toHaveBeenCalledTimes(1);
  });
});
