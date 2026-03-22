// Tests for migrationMonitor — turned GREEN in Plan 03
// Run: npx jest tests/migrationMonitor.test.ts --bail
describe("migrationMonitor", () => {
  it("checkAndUpdateMigrationStatus is a function", async () => {
    const { checkAndUpdateMigrationStatus } = await import("../src/solana/migrationMonitor");
    expect(typeof checkAndUpdateMigrationStatus).toBe("function");
  });

  it("claimAccumulatedFees is a function", async () => {
    const { claimAccumulatedFees } = await import("../src/solana/migrationMonitor");
    expect(typeof claimAccumulatedFees).toBe("function");
  });

  it("pollAllPoolMigrations is a function", async () => {
    const { pollAllPoolMigrations } = await import("../src/solana/migrationMonitor");
    expect(typeof pollAllPoolMigrations).toBe("function");
  });
});
