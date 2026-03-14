import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

const EMPTY_RSS = `<?xml version="1.0" encoding="UTF-8"?><rss><channel></channel></rss>`;

function makeTempDbDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildGammaResponse() {
  return [
    {
      outcomePrices: JSON.stringify(["0.64", "0.36"]),
      volume24hr: 12345,
    },
  ];
}

function buildCoinDeskResponse(title = "CoinDesk breaks the market") {
  return {
    Data: [
      {
        TITLE: title,
        BODY: "CoinDesk body copy.",
        URL: "https://www.coindesk.com/test-article",
        PUBLISHED_ON: Math.floor(Date.now() / 1000),
        SOURCE_DATA: {
          NAME: "CoinDesk",
        },
      },
    ],
    Err: {},
  };
}

function mockAuraFetch(overrides: {
  coindeskStatus?: number;
  coindeskBody?: Record<string, unknown>;
  coindeskError?: Error;
} = {}) {
  const {
    coindeskStatus = 200,
    coindeskBody = buildCoinDeskResponse(),
    coindeskError,
  } = overrides;

  return jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);

    if (url.startsWith("https://data-api.coindesk.com/news/v1/search")) {
      if (coindeskError) throw coindeskError;
      return new Response(JSON.stringify(coindeskBody), {
        status: coindeskStatus,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.startsWith("https://news.google.com/rss/search")) {
      return new Response(EMPTY_RSS, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      });
    }

    if (url.startsWith("https://hn.algolia.com/api/v1/search")) {
      return new Response(JSON.stringify({ hits: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.startsWith("https://gamma-api.polymarket.com/markets")) {
      return new Response(JSON.stringify(buildGammaResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  });
}

async function loadAuraModule(tempDir: string) {
  jest.resetModules();
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;
  return import("../src/aura/index");
}

async function startAuraStatusServer(tempDir: string) {
  jest.resetModules();
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;

  const express = require("express") as typeof import("express");
  const { auraRouter } = require("../src/routes/aura") as typeof import("../src/routes/aura");

  const app = express();
  app.use("/api/aura", auraRouter);

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function closeAuraDb(): Promise<void> {
  try {
    const { getDb } = await import("../src/db/schema");
    getDb().close();
  } catch {
    // No DB was opened in this test run.
  }
}

describe("AURA CoinDesk integration", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.GUARDIAN_API_KEY;
    delete process.env.NYT_API_KEY;
    delete process.env.CRYPTOPANIC_API_KEY;
    delete process.env.ALGOLIA_HN_API_KEY;
    delete process.env.AURA_MOCK;
  });

  afterEach(async () => {
    await closeAuraDb();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("runAura includes CoinDesk articles and marks the source as ok", async () => {
    process.env.COINDESK_API_KEY = "test-coindesk-key";
    const fetchMock = mockAuraFetch();
    const { runAura } = await loadAuraModule(makeTempDbDir("quantik-aura-coindesk-ok-"));

    const result = await runAura({
      slug: "btc-momentum",
      question: "Will Bitcoin continue higher?",
      category: "political",
    });

    expect(result.newsArticles).toEqual([
      {
        title: "CoinDesk breaks the market",
        url: "https://www.coindesk.com/test-article",
        source: "CoinDesk",
      },
    ]);
    expect(result.newsHeadlines).toContain("CoinDesk breaks the market");
    expect(result.sourceStatus.coindesk).toBe("ok");
    expect(result.sourcesUsed).toContain("coindesk");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("data-api.coindesk.com/news/v1/search"))).toBe(true);
  });

  test("runAura marks CoinDesk unavailable when COINDESK_API_KEY is missing", async () => {
    const fetchMock = mockAuraFetch();
    const { runAura } = await loadAuraModule(makeTempDbDir("quantik-aura-coindesk-missing-"));

    const result = await runAura({
      slug: "eth-momentum",
      question: "Will Ethereum rally?",
      category: "sports",
    });

    expect(result.sourceStatus.coindesk).toBe("unavailable");
    expect(result.sourcesUsed).not.toContain("coindesk");
    expect(result.newsArticles).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("data-api.coindesk.com/news/v1/search"))).toBe(false);
  });

  test("runAura degrades gracefully when CoinDesk returns a non-200 response", async () => {
    process.env.COINDESK_API_KEY = "test-coindesk-key";
    mockAuraFetch({ coindeskStatus: 500, coindeskBody: { Data: [], Err: { message: "boom" } } });
    const { runAura } = await loadAuraModule(makeTempDbDir("quantik-aura-coindesk-error-"));

    const result = await runAura({
      slug: "sol-momentum",
      question: "Will Solana flip Ethereum?",
      category: "crypto",
    });

    expect(result.sourceStatus.coindesk).toBe("unavailable");
    expect(result.sourcesUsed).not.toContain("coindesk");
    expect(result.marketSlug).toBe("sol-momentum");
    expect(typeof result.sentimentDelta).toBe("number");
  });

  test("GET /api/aura/status reports CoinDesk source availability", async () => {
    process.env.COINDESK_API_KEY = "test-coindesk-key";
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const { server, baseUrl } = await startAuraStatusServer(makeTempDbDir("quantik-aura-status-"));

    try {
      const response = await nativeFetch(`${baseUrl}/api/aura/status`);
      const body = await response.json() as {
        sources: Record<string, boolean>;
        lastRunAt: number | null;
        totalRuns: number;
      };

      expect(response.status).toBe(200);
      expect(body.sources.coindesk).toBe(true);
      expect(typeof body.totalRuns).toBe("number");
      expect(body.lastRunAt).toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});
