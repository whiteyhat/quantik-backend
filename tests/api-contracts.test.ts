/**
 * API Contract Tests — run against production backend
 */

const API = process.env.API_URL ?? "https://api.quantik.fun";
const TIMEOUT = 60000;
// Polymarket markets close over time, so use one that is listed right now.
let TEST_SLUG = "";

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  const { body } = await get("/api/markets");
  TEST_SLUG = (body.markets ?? body)?.[0]?.slug ?? "";
  if (!TEST_SLUG) throw new Error("GET /api/markets returned no live markets to test against");
}, TIMEOUT);

describe("Backend API Contracts", () => {

  describe("Health", () => {
    it("performance/summary returns 200", async () => {
      const { status } = await get("/api/performance/summary");
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

  // Each sub-agent GET re-runs a paid LLM call, so they require sign-in.
  // CI checks the lock instead of spending model credits on every push.
  describe("Agent endpoints require sign-in", () => {
    it.each(["aura", "flux", "edge", "clause"])("GET /api/%s/:slug without auth → 401", async (agent) => {
      const { status } = await get(`/api/${agent}/${TEST_SLUG}`);
      expect(status).toBe(401);
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
