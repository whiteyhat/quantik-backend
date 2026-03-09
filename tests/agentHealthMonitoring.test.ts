describe("agent health monitoring", () => {
  beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    const { resetAgentHealth } = await import("../src/monitoring/agentHealth");
    resetAgentHealth();
  });

  afterEach(async () => {
    const { resetAgentHealth } = await import("../src/monitoring/agentHealth");
    resetAgentHealth();
    jest.useRealTimers();
  });

  test("marks every agent idle before the first pipeline run", async () => {
    const { getSystemHealth } = await import("../src/monitoring/agentHealth");

    const snapshot = getSystemHealth();

    expect(snapshot.overall).toBe("degraded");
    expect(snapshot.agents).toHaveLength(7);
    expect(snapshot.agents.every((agent) => agent.status === "idle")).toBe(true);
    expect(snapshot.agents.every((agent) => agent.errorRate === 0)).toBe(true);
  });

  test("marks stale agents idle instead of down", async () => {
    const { AGENT_NAMES, getSystemHealth, recordInvocation } = await import("../src/monitoring/agentHealth");

    for (const agent of AGENT_NAMES) {
      recordInvocation(agent, true, 120);
    }

    jest.advanceTimersByTime(11 * 60 * 1_000);

    const snapshot = getSystemHealth();

    expect(snapshot.overall).toBe("degraded");
    expect(snapshot.agents.every((agent) => agent.status === "idle")).toBe(true);
    expect(snapshot.agents.every((agent) => agent.lastActiveAt > 0)).toBe(true);
  });

  test("keeps recent failure-heavy agents marked down", async () => {
    const { getSystemHealth, recordInvocation } = await import("../src/monitoring/agentHealth");

    recordInvocation("oracle", false, 2_000);
    recordInvocation("oracle", false, 2_200);
    recordInvocation("oracle", false, 1_900);
    recordInvocation("oracle", true, 1_400);

    const snapshot = getSystemHealth();
    const oracle = snapshot.agents.find((agent) => agent.name === "oracle");

    expect(snapshot.overall).toBe("down");
    expect(oracle).toMatchObject({
      status: "down",
      errorRate: 0.75,
    });
  });
});
