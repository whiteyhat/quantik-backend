import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

let currentUserId: string | null = "user-trade";

const runCliWithWalletMock = jest.fn();
const fetchMarketBySlugMock = jest.fn();
const loadAgentWalletContextMock = jest.fn();
const loadLinkedAgentForUserMock = jest.fn();
const emitTradeExecutedMock = jest.fn();

class MockCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
    public readonly stderr = ""
  ) {
    super(message);
    this.name = "CliError";
  }
}

function buildMarketData(overrides: Partial<{
  slug: string;
  yes_price: number;
  no_price: number;
  yes_token_id: string;
  no_token_id: string;
  token_id: string;
  resolution_date: string;
}> = {}) {
  return {
    slug: overrides.slug ?? "will-btc-hit-100k",
    question: "Will BTC hit 100k?",
    description: "Test market",
    yes_price: overrides.yes_price ?? 0.61,
    no_price: overrides.no_price ?? 0.39,
    resolution_date: overrides.resolution_date ?? "2026-06-30T00:00:00.000Z",
    days_to_resolution: 100,
    yes_token_id: overrides.yes_token_id ?? "yes-token",
    no_token_id: overrides.no_token_id ?? "no-token",
    token_id: overrides.token_id ?? overrides.no_token_id ?? "no-token",
  };
}

async function startTradeServer(paperMode: boolean) {
  jest.resetModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-trade-route-"));
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;
  process.env.POLYMARKET_SIGNATURE_TYPE = "eoa";

  jest.doMock("../src/middleware/auth", () => ({
    getUserId: jest.fn(() => currentUserId),
    getUserIdAsync: jest.fn(async () => currentUserId),
  }));

  jest.doMock("../src/cli", () => ({
    CliError: MockCliError,
    runCliWithWallet: (...args: unknown[]) => runCliWithWalletMock(...args),
  }));

  jest.doMock("../src/utils/market-fetch", () => ({
    fetchMarketBySlug: (...args: unknown[]) => fetchMarketBySlugMock(...args),
  }));

  jest.doMock("../src/utils/agentKey", () => ({
    loadAgentWalletContext: (...args: unknown[]) => loadAgentWalletContextMock(...args),
    loadAgentWalletContextWithDiag: async (...args: unknown[]) => {
      try {
        const context = await loadAgentWalletContextMock(...args);
        return { context, error: null };
      } catch (err: any) {
        return { context: null, error: err?.message ?? "Unknown wallet error" };
      }
    },
  }));

  jest.doMock("../src/utils/linkedAgent", () => ({
    loadLinkedAgentForUser: (...args: unknown[]) => loadLinkedAgentForUserMock(...args),
  }));

  jest.doMock("../src/infra/socket", () => ({
    emitTradeExecuted: (...args: unknown[]) => emitTradeExecutedMock(...args),
  }));

  jest.doMock("../src/infra/rateLimit", () => ({
    tradeRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  }));

  const express = require("express") as typeof import("express");
  const { default: tradeRouter } = require("../src/routes/trade") as typeof import("../src/routes/trade");
  const { getDb } = require("../src/db/schema") as typeof import("../src/db/schema");

  const app = express();
  app.use(express.json());
  app.use("/api/trade", tradeRouter);

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const db = getDb();
  db.prepare("UPDATE settings SET paper_mode = ? WHERE id = 1").run(paperMode ? 1 : 0);

  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    db,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("trade route manual execution", () => {
  beforeEach(() => {
    currentUserId = "user-trade";
    runCliWithWalletMock.mockReset();
    fetchMarketBySlugMock.mockReset();
    loadAgentWalletContextMock.mockReset();
    loadLinkedAgentForUserMock.mockReset();
    emitTradeExecutedMock.mockReset();
    loadLinkedAgentForUserMock.mockResolvedValue({
      userId: "user-trade",
      agentId: "agent-trade",
      status: "active",
      agentType: "created",
      walletAddress: "0x1111111111111111111111111111111111111111",
      autopilotEnabled: false,
    });
    loadAgentWalletContextMock.mockResolvedValue({ privateKey: "test-private-key" });
    fetchMarketBySlugMock.mockResolvedValue(buildMarketData());
  });

  afterEach(() => {
    jest.resetModules();
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  });

  test("paper-mode allows two same-day manual trades on the same slug", async () => {
    const { server, baseUrl, db } = await startTradeServer(true);

    try {
      const requestBody = {
        marketSlug: "will-btc-hit-100k",
        direction: "YES",
        size: 25,
      };

      const first = await fetch(`${baseUrl}/api/trade/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const second = await fetch(`${baseUrl}/api/trade/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const row = db
        .prepare(`
          SELECT COUNT(*) AS count,
                 COUNT(CASE WHEN source = 'manual' THEN 1 END) AS manual_count
          FROM executions
          WHERE slug = ? AND status = 'paper'
        `)
        .get("will-btc-hit-100k") as { count: number; manual_count: number };

      expect(row.count).toBe(2);
      expect(row.manual_count).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  test("live trades use market-order with the resolved YES/NO token and amount semantics", async () => {
    const { server, baseUrl, db } = await startTradeServer(false);
    runCliWithWalletMock
      .mockResolvedValueOnce({ orderID: "order-yes", avgPrice: 0.62 })
      .mockResolvedValueOnce({ id: "order-no", avgPrice: 0.38 });

    try {
      const yesResponse = await fetch(`${baseUrl}/api/trade/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketSlug: "will-btc-hit-100k",
          direction: "YES",
          size: 12.5,
        }),
      });

      const noResponse = await fetch(`${baseUrl}/api/trade/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketSlug: "will-btc-hit-100k",
          direction: "NO",
          tokenId: "stale-token",
          size: 17,
        }),
      });

      expect(yesResponse.status).toBe(200);
      expect(noResponse.status).toBe(200);
      expect(runCliWithWalletMock).toHaveBeenNthCalledWith(
        1,
        [
          "clob",
          "market-order",
          "--token",
          "yes-token",
          "--side",
          "buy",
          "--amount",
          "12.50",
          "--signature-type",
          "eoa",
        ],
        "test-private-key"
      );
      expect(runCliWithWalletMock).toHaveBeenNthCalledWith(
        2,
        [
          "clob",
          "market-order",
          "--token",
          "no-token",
          "--side",
          "buy",
          "--amount",
          "17.00",
          "--signature-type",
          "eoa",
        ],
        "test-private-key"
      );

      const rows = db
        .prepare(`
          SELECT direction, side, fill_price, source
          FROM executions
          WHERE slug = ?
        `)
        .all("will-btc-hit-100k") as Array<{ direction: string; side: string; fill_price: number; source: string }>;

      expect(rows).toHaveLength(2);
      const byDirection = new Map(rows.map((row) => [row.direction, row]));
      expect(byDirection.get("YES")).toMatchObject({ direction: "YES", side: "buy", fill_price: 0.62, source: "manual" });
      expect(byDirection.get("NO")).toMatchObject({ direction: "NO", side: "buy", fill_price: 0.38, source: "manual" });
    } finally {
      await closeServer(server);
    }
  });

  test("failed manual-trade logging does not block a same-day retry", async () => {
    const { server, baseUrl, db } = await startTradeServer(false);
    runCliWithWalletMock
      .mockResolvedValueOnce({ error: "Insufficient allowance" })
      .mockResolvedValueOnce({ order_id: "order-retry", avgPrice: 0.59 });

    try {
      const requestBody = {
        marketSlug: "will-btc-hit-100k",
        direction: "YES",
        size: 15,
      };

      const failed = await fetch(`${baseUrl}/api/trade/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const retried = await fetch(`${baseUrl}/api/trade/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      expect(failed.status).toBe(400);
      expect(retried.status).toBe(200);

      const rows = db
        .prepare(`
          SELECT status
          FROM executions
          WHERE slug = ?
          ORDER BY executed_at ASC
        `)
        .all("will-btc-hit-100k") as Array<{ status: string }>;

      expect(rows.map((row) => row.status)).toEqual(["failed", "placed"]);
    } finally {
      await closeServer(server);
    }
  });

  test("trade history labels NO positions correctly and uses NO-token pricing", async () => {
    const { server, baseUrl, db } = await startTradeServer(true);

    try {
      db.prepare(`
        INSERT INTO executions (
          user_id, agent_id, slug, side, direction, amount, executed_at, status, order_id, fill_price, pnl, resolution_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        currentUserId,
        "agent-trade",
        "will-btc-hit-100k",
        "buy",
        "NO",
        100,
        Date.UTC(2026, 2, 14, 12, 0, 0),
        "placed",
        "order-no-history",
        0.4,
        null,
        "2026-06-30T00:00:00.000Z"
      );

      db.prepare(`
        INSERT INTO scanner_results (
          slug, scanned_at, sigma_confidence, kelly_fraction, recommendation, probability, alert_sent, pipeline_result
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "will-btc-hit-100k",
        Date.UTC(2026, 2, 14, 12, 5, 0),
        0.8,
        0.15,
        "BET_NO",
        0.35,
        0,
        "{}"
      );

      const response = await fetch(`${baseUrl}/api/trade`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        trades: Array<{ direction: string; price: number; pnl: number }>;
      };

      expect(body.trades[0]).toMatchObject({
        direction: "NO",
      });
      expect(body.trades[0]?.price).toBeCloseTo(0.6, 5);
      expect(body.trades[0]?.pnl).toBeCloseTo(62.5, 5);
    } finally {
      await closeServer(server);
    }
  });
});
