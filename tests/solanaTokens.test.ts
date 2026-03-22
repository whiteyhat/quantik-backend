// TDD RED PHASE for solanaTokens route
// Run: npx jest tests/solanaTokens.test.ts --bail
// NOTE: These tests will fail until solanaTokens route is created in Plan 02
import request from "supertest";

describe("solanaTokens routes", () => {
  it("POST /api/solana/tokens/:agentId/tokenize returns 401 without auth", async () => {
    // Import app after env setup
    const { default: app } = await import("../src/index");
    const res = await request(app)
      .post("/api/solana/tokens/test-agent-id/tokenize")
      .send({});
    expect(res.status).toBe(401);
  });

  it("GET /api/solana/tokens/:agentId/status returns 401 without auth", async () => {
    const { default: app } = await import("../src/index");
    const res = await request(app).get("/api/solana/tokens/test-agent-id/status");
    expect(res.status).toBe(401);
  });

  it("GET /api/solana/tokens/:poolAddress/quote returns 401 without auth", async () => {
    const { default: app } = await import("../src/index");
    const res = await request(app).get("/api/solana/tokens/SomePoolAddress/quote?amount=100&side=buy");
    expect(res.status).toBe(401);
  });
});
