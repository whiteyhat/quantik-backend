// TDD RED PHASE for tokenService curve config building
// Run: npx jest tests/tokenService.test.ts --bail
// NOTE: These tests will fail until tokenService.ts is created in Plan 02
describe("tokenService — curve config", () => {
  it("buildCurveConfig sets MET_DAMM_V2 migration option", async () => {
    const { buildCurveConfig } = await import("../src/solana/tokenService");
    const { MigrationOption } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    const config = buildCurveConfig();
    expect(config.migration.migrationOption).toBe(MigrationOption.MET_DAMM_V2);
  });

  it("buildCurveConfig sets 2% fee (200 bps) and 100% creator fee share", async () => {
    const { buildCurveConfig } = await import("../src/solana/tokenService");
    const config = buildCurveConfig();
    expect(config.fee.baseFeeParams.feeSchedulerParam.startingFeeBps).toBe(200);
    expect(config.fee.creatorTradingFeePercentage).toBe(100);
  });

  it("generateTokenSymbol passes through default agent codes unchanged", async () => {
    const { generateTokenSymbol } = await import("../src/solana/tokenService");
    const DEFAULT_AGENTS = ["AURA", "FLUX", "CLAUSE", "ORACLE", "EDGE", "LUCIFER", "SIGMA"];
    for (const code of DEFAULT_AGENTS) {
      expect(generateTokenSymbol(code, code)).toBe(code);
    }
  });

  it("generateTokenSymbol auto-generates symbol from first 5 chars for BYO agents", async () => {
    const { generateTokenSymbol } = await import("../src/solana/tokenService");
    expect(generateTokenSymbol("AlphaTrader", null)).toBe("ALPHA");
    expect(generateTokenSymbol("bot", null)).toBe("BOT");
    expect(generateTokenSymbol("MyAgent123", null)).toBe("MYAGE");
  });
});
