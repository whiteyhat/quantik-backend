import type { AddressInfo } from "net";
import type { Server } from "http";

jest.mock("../src/middleware/auth", () => ({
  getUserId: jest.fn(() => "user-1"),
  getUserIdAsync: jest.fn(async () => "user-1"),
}));

jest.mock("../src/utils/linkedAgent", () => ({
  loadLinkedAgentForUser: jest.fn(async () => {
    throw new Error("database unavailable");
  }),
}));

describe("GET /api/v1/me/access when the lookup fails", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const express = require("express") as typeof import("express");
    const { default: meAccessRouter } = require("../src/routes/meAccess") as typeof import("../src/routes/meAccess");
    const app = express();
    app.use("/api/v1", meAccessRouter);
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers 503 instead of hanging or guessing", async () => {
    const res = await fetch(`${baseUrl}/api/v1/me/access`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(503);
  });
});
