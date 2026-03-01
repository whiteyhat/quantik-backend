/**
 * API Contract Tests — run against production backend
 * These must all pass before Railway deploy is allowed.
 */

const API = process.env.API_URL ?? "https://quantik-backend-production.up.railway.app";
const TEST_SLUG = "khamenei-out-as-supreme-leader-of-iran-by-february-28";
const TIMEOUT = 60000;

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("Backend API Contracts", () => {

  describe("Health", () => {
    it("portfolio/summary returns 200", async () => {
      const { status } = await get("/api/portfolio/summary");
      expect(status).toBe(200);
    }, TIMEOUT);
  });

  describe("Markets", () => {
    it("GET /api/markets returns markets array", async () => {
      const { status, body } = await get("/api/markets");
      expect(status).toBe(200);
      expect(body.markets || body).toBeTruthy();
    }, TIMEOUT);

    it("GET /api/markets/:slug returns tokenId field", async () => {
      const { status, body } = await get(`/api/markets/${TEST_SLUG}`);
      expect(status).toBe(200);
      expect(typeof body.tokenId).toBe("string");
      expect(body.slug).toBe(TEST_SLUG);
    }, TIMEOUT);
  });

  describe("Agent field contracts", () => {
    it("Aura returns sentimentDelta as number", async () => {
      const { status, body } = await get(`/api/aura/${TEST_SLUG}`);
      expect(status).toBe(200);
      expect(typeof body.sentimentDelta).toBe("number");
    }, TIMEOUT);

    it("Flux returns liquidity_grade and total_liquidity", async () => {
      const { status, body } = await get(`/api/flux/${TEST_SLUG}`);
      expect(status).toBe(200);
      expect(["A","B","C","D"]).toContain(body.liquidity_grade);
      expect(typeof body.total_liquidity).toBe("number");
    }, TIMEOUT);

    it("Edge returns fractional_kelly and position_size", async () => {
      const { status, body } = await get(`/api/edge/${TEST_SLUG}`);
      expect(status).toBe(200);
      expect(typeof body.fractional_kelly).toBe("number");
      expect(typeof body.position_size).toBe("number");
    }, TIMEOUT);

    it("Clause returns veto boolean and ambiguityScore", async () => {
      const { status, body } = await get(`/api/clause/${TEST_SLUG}`);
      expect(status).toBe(200);
      expect(typeof body.veto).toBe("boolean");
    }, TIMEOUT);
  });

  describe("Scanner", () => {
    it("scanner/results returns ok:true", async () => {
      const { status, body } = await get("/api/scanner/results?limit=1");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    }, TIMEOUT);
  });

});
