import type { AddressInfo } from "net";
import type { Server } from "http";

async function startServer() {
  jest.resetModules();

  const express = require("express") as typeof import("express");
  const { default: skillRouter } = require("../src/routes/skill") as typeof import("../src/routes/skill");

  const app = express();
  app.use("/api", skillRouter);

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("skill manifest routes", () => {
  test("skill.json is generated from the canonical public tool manifest", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/api/skill.json`);
      expect(response.status).toBe(200);

      const body = await response.json() as {
        tools: Array<{
          name: string;
          path: string;
          rate_limit_bucket: string;
          deprecated?: boolean;
          successor_path?: string;
        }>;
        rate_limits: Record<string, { max: number; window_ms: number }>;
        scopes: string[];
        error_codes: string[];
      };

      const toolNames = body.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(expect.arrayContaining([
        "get_polymarket_status",
        "run_polymarket_approvals",
        "usage",
        "agent_chat",
        "relay_stream_legacy",
      ]));

      const chatTool = body.tools.find((tool) => tool.name === "agent_chat");
      expect(chatTool).toMatchObject({
        path: "/api/v1/agent/chat",
        rate_limit_bucket: "chat",
      });

      const legacyRelayTool = body.tools.find((tool) => tool.name === "relay_stream_legacy");
      expect(legacyRelayTool).toMatchObject({
        path: "/api/relay/stream",
        rate_limit_bucket: "chat",
        deprecated: true,
        successor_path: "/api/v1/agent/chat",
      });

      expect(body.rate_limits.chat).toEqual({ max: 30, window_ms: 60_000 });
      expect(body.scopes).toEqual(expect.arrayContaining(["read", "trade", "analysis", "config"]));
      expect(body.error_codes).toEqual(expect.arrayContaining(["INVALID_PARAMS", "TIMEOUT"]));
    } finally {
      await closeServer(server);
    }
  });

  test("skill.md includes live Polymarket tools and the legacy relay compatibility section", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/api/skill.md`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("### get_polymarket_status");
      expect(body).toContain("### run_polymarket_approvals");
      expect(body).toContain("## Legacy Compatibility");
      expect(body).toContain("/api/relay/stream");
      expect(body).toContain("/api/v1/agent/chat");
    } finally {
      await closeServer(server);
    }
  });
});
