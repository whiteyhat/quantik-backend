const runCliMock = jest.fn();
const runCliWithWalletMock = jest.fn();
const tryLoadActiveAgentContextMock = jest.fn();

jest.mock("../src/cli", () => ({
  runCli: (...args: unknown[]) => runCliMock(...args),
  runCliWithWallet: (...args: unknown[]) => runCliWithWalletMock(...args),
}));

jest.mock("../src/utils/agentKey", () => ({
  tryLoadActiveAgentContext: (...args: unknown[]) => tryLoadActiveAgentContextMock(...args),
}));

describe("getWalletFundingSnapshot", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    runCliMock.mockReset();
    runCliWithWalletMock.mockReset();
    tryLoadActiveAgentContextMock.mockReset();
    tryLoadActiveAgentContextMock.mockResolvedValue(null);
  });

  test("treats an explicit wallet with live clob collateral as ready when Polygon RPC checks fail", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("rpc down"));
    runCliWithWalletMock.mockResolvedValue({ balance: 3.25 });

    const { getWalletFundingSnapshot } = await import("../src/utils/balances");
    const snapshot = await getWalletFundingSnapshot(
      "0x1111111111111111111111111111111111111111",
      "pk-test"
    );

    expect(snapshot.ready).toBe(true);
    expect(snapshot.fundingStatus).toBe("ready");
    expect(snapshot.clobBalance).toBe(3.25);
    expect(snapshot.fundingMessage).toContain("live Polymarket collateral balance");
  });

  test("keeps funding unavailable when RPC checks fail and no explicit wallet collateral is available", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("rpc down"));
    runCliMock.mockResolvedValue({ balance: 0 });

    const { getWalletFundingSnapshot } = await import("../src/utils/balances");
    const snapshot = await getWalletFundingSnapshot(
      "0x1111111111111111111111111111111111111111"
    );

    expect(snapshot.ready).toBe(false);
    expect(snapshot.fundingStatus).toBe("unavailable");
  });
});
