describe("health route payload builders", () => {
  test("buildHealthSnapshot returns structured mission-control telemetry", async () => {
    const now = Date.now();
    const { buildHealthSnapshot } = await import("../src/routes/health");

    const body = buildHealthSnapshot({
      now,
      relay: {
        status: "healthy",
        detail: "Relay online",
        checkedAt: now,
        agent: "relay",
        llm: "gemini-flash",
        models: ["gemini-3.1-flash-lite-preview"],
        activeSessions: 2,
      },
      scanner: {
        running: false,
        lastScan: now - 60_000,
        scannedToday: 12,
        alertsTriggered: 2,
      },
      orchestrator: {
        lastScanAt: now - 120_000,
        nextScanAt: now + 180_000,
        marketsScanned: 1800,
        candidatesFound: 4,
        scanIntervalMs: 300_000,
        status: "idle",
        scanCycle: 3,
      },
      systemHealth: {
        overall: "degraded",
        checkedAt: now,
        agents: [
          { name: "aura", status: "live", lastActiveAt: now - 20_000, latencyMs: 120, errorRate: 0.01 },
          { name: "flux", status: "live", lastActiveAt: now - 18_000, latencyMs: 130, errorRate: 0.01 },
          { name: "oracle", status: "degraded", lastActiveAt: now - 22_000, latencyMs: 31_500, errorRate: 0.08 },
          { name: "edge", status: "live", lastActiveAt: now - 17_000, latencyMs: 95, errorRate: 0.01 },
          { name: "sigma", status: "live", lastActiveAt: now - 15_000, latencyMs: 110, errorRate: 0.02 },
          { name: "clause", status: "live", lastActiveAt: now - 16_000, latencyMs: 125, errorRate: 0.01 },
          { name: "lucifer", status: "live", lastActiveAt: now - 19_000, latencyMs: 150, errorRate: 0.03 },
        ],
      },
    });

    expect(body.status).toBe("degraded");
    expect(typeof body.checkedAt).toBe("number");
    expect(typeof body.message).toBe("string");
    expect(body.services).toMatchObject({
      backend: expect.objectContaining({ status: "healthy", detail: expect.any(String) }),
      relay: expect.objectContaining({ status: "healthy", detail: "Relay online" }),
      scanner: expect.objectContaining({ status: "healthy", detail: expect.stringContaining("Last scan") }),
      orchestrator: expect.objectContaining({ status: "healthy", detail: expect.stringContaining("candidates") }),
      pipeline_agents: expect.objectContaining({ status: "degraded", detail: expect.stringContaining("degraded") }),
    });
  });

  test("buildAgentHealthSnapshot preserves no-traffic idle states", async () => {
    jest.resetModules();
    jest.doMock("../src/monitoring/agentHealth", () => ({
      getSystemHealth: () => ({
        overall: "degraded",
        checkedAt: Date.now(),
        agents: [
          { name: "aura", status: "idle", lastActiveAt: 0, latencyMs: 0, errorRate: 0 },
          { name: "flux", status: "idle", lastActiveAt: 0, latencyMs: 0, errorRate: 0 },
          { name: "oracle", status: "idle", lastActiveAt: 0, latencyMs: 0, errorRate: 0 },
          { name: "edge", status: "idle", lastActiveAt: 0, latencyMs: 0, errorRate: 0 },
          { name: "sigma", status: "idle", lastActiveAt: 0, latencyMs: 0, errorRate: 0 },
          { name: "clause", status: "idle", lastActiveAt: 0, latencyMs: 0, errorRate: 0 },
          { name: "lucifer", status: "idle", lastActiveAt: 0, latencyMs: 0, errorRate: 0 },
        ],
      }),
    }));

    const { buildAgentHealthSnapshot } = await import("../src/routes/agentHealth");
    const body = buildAgentHealthSnapshot();

    expect(body.overall).toBe("degraded");
    expect(body.agents).toHaveLength(7);
    expect(body.agents.every((agent) => agent.status === "idle")).toBe(true);
  });

  test("buildAgentHealthSnapshot preserves degraded runtime telemetry", async () => {
    jest.resetModules();
    jest.doMock("../src/monitoring/agentHealth", () => ({
      getSystemHealth: () => ({
        overall: "degraded",
        checkedAt: Date.now(),
        agents: [
          { name: "aura", status: "live", lastActiveAt: Date.now() - 12_000, latencyMs: 180, errorRate: 0.01 },
          { name: "flux", status: "live", lastActiveAt: Date.now() - 11_000, latencyMs: 165, errorRate: 0.01 },
          { name: "oracle", status: "degraded", lastActiveAt: Date.now() - 10_000, latencyMs: 35_500, errorRate: 0.08 },
          { name: "edge", status: "live", lastActiveAt: Date.now() - 9_000, latencyMs: 140, errorRate: 0.01 },
          { name: "sigma", status: "live", lastActiveAt: Date.now() - 8_000, latencyMs: 155, errorRate: 0.02 },
          { name: "clause", status: "live", lastActiveAt: Date.now() - 7_000, latencyMs: 170, errorRate: 0.01 },
          { name: "lucifer", status: "live", lastActiveAt: Date.now() - 6_000, latencyMs: 190, errorRate: 0.02 },
        ],
      }),
    }));

    const { buildAgentHealthSnapshot } = await import("../src/routes/agentHealth");
    const body = buildAgentHealthSnapshot();

    expect(body.overall).toBe("degraded");
    expect(body.agents.find((agent) => agent.name === "oracle")).toMatchObject({
      status: "degraded",
      latencyMs: 35_500,
    });
  });
});
