import "dotenv/config";
import * as Sentry from "@sentry/node";
Sentry.init({
  dsn: "https://3452bb639c2bd626cc575d5936d234b3@o4506259886833664.ingest.us.sentry.io/4510949180047360",
  environment: process.env.NODE_ENV ?? "production",
  tracesSampleRate: 0.1,
  integrations: [
    Sentry.httpIntegration(),
    Sentry.expressIntegration(),
  ],
});

import express from "express";
import cors from "cors";
import { getDb } from "./db/schema";
import { isPgEnabled, migratePg } from "./db/postgres";
import { clerkAuth, ensureUser } from "./middleware/auth";
import marketsRouter from "./routes/markets";
import walletRouter from "./routes/wallet";
import pipelineRouter from "./routes/pipeline";
import tradeRouter from "./routes/trade";
import streamRouter from "./routes/stream";
import riskRouter from "./routes/risk";
import settingsRouter from "./routes/settings";
import chatRouter from "./routes/chat";
import agentStatusRouter from "./routes/agentStatus";
import { sentryWebhookRouter } from "./routes/sentryWebhook";
import orchestratorRouter from "./routes/orchestrator";
import { auraRouter } from "./routes/aura";
import oracleRouter from "./routes/oracle";
import edgeRouter from "./routes/edge";
import sigmaRouter from "./routes/sigma";
import clauseRouter from "./routes/clause";
import luciferRouter from "./routes/lucifer";
import fluxRouter from "./routes/flux";
import signalsRouter from "./routes/signals";
import riskL3Router from "./routes/riskL3";
import executionRouter from "./routes/execution";
import monitoringRouter from "./routes/monitoring";
import relayRouter, { warmGemini } from "./routes/relay";
import performanceRouter from "./routes/performance";
import scannerRouter from "./routes/scanner";
import versionsRouter from "./routes/versions";
import agentHealthRouter from "./routes/agentHealth";
import agentsRouter from "./routes/agents";
import agentChatRouter from "./routes/agentChat";
import { ensureCircuitBreakerTable } from "./risk";
import alertsRouter from "./routes/alerts";
import { initScheduler } from "./infra/scheduler";
import { apiRateLimit } from "./infra/rateLimit";
import { isRedisEnabled } from "./infra/redis";
import { createServer } from "http";
import { initSocketIO } from "./infra/socket";

const PORT = parseInt(process.env.PORT || "3001", 10);

const app = express();

// Middleware
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
    // Allow any vercel.app subdomain
    if (origin.endsWith(".vercel.app")) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json());

// Clerk auth — attaches auth info to all requests (does NOT block unauthenticated)
app.use(clerkAuth);
app.use(ensureUser);

// Redis-backed rate limiting (no-op when REDIS_URL is not set)
app.use(apiRateLimit);

// Initialize databases on startup
getDb();
ensureCircuitBreakerTable();
if (isPgEnabled()) {
  migratePg().then(() => console.log("[startup] PostgreSQL ready"))
    .catch((err) => console.error("[startup] PostgreSQL migration failed:", err.message));
}

// Root route
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "quantik-backend", message: "Quantik Backend Online" });
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Routes
app.use("/api/markets", marketsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/pipeline", pipelineRouter);
app.use("/api/trade", tradeRouter);
app.use("/api/stream", streamRouter);
app.use("/api/v1", riskRouter);
app.use("/api/v1", settingsRouter);
app.use("/api/v1", chatRouter);
app.use("/api/v1", agentStatusRouter);
app.use("/api/webhooks/sentry", sentryWebhookRouter);
app.use("/api/orchestrator", orchestratorRouter);
app.use("/api/aura", auraRouter);
app.use("/api/oracle", oracleRouter);
app.use("/api/edge", edgeRouter);
app.use("/api/sigma", sigmaRouter);
app.use("/api/clause", clauseRouter);
app.use("/api/lucifer", luciferRouter);
app.use("/api/flux", fluxRouter);
app.use("/api/signals", signalsRouter);
app.use("/api/risk", riskL3Router);
app.use("/api/execution", executionRouter);
app.use("/api/monitoring", monitoringRouter);
app.use("/api/relay", relayRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/scanner", scannerRouter);
app.use("/api/performance", performanceRouter);
app.use("/api/versions", versionsRouter);
app.use("/api/agents", agentHealthRouter);
app.use("/api/v1", agentsRouter);
app.use("/api/v1", agentChatRouter);

// CLOB balance health endpoint — verify allowances without SSHing in
app.get("/api/clob/balance", async (_req, res) => {
  try {
    const { runCli } = await import("./cli");
    const result = await runCli(["clob", "balance", "--asset-type", "collateral"]);
    res.json({ ok: true, data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// Sentry error handler (must be before generic error handler)
app.use(Sentry.expressErrorHandler());

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
);

const httpServer = createServer(app);
initSocketIO(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[quantik-backend] Running on http://localhost:${PORT}`);
  console.log(`[quantik-backend] Health: http://localhost:${PORT}/api/health`);
  console.log(`[quantik-backend] Redis: ${isRedisEnabled() ? "enabled (BullMQ)" : "disabled (setInterval fallback)"}`);
  console.log(`[quantik-backend] WebSocket: enabled (Socket.IO)`);

  // Pre-warm Gemini
  warmGemini().catch(() => {});

  // Start all scheduled jobs — BullMQ when Redis available, setInterval fallback otherwise
  initScheduler().catch((err) => {
    console.error("[startup] Scheduler init failed:", err.message);
  });
});

// Set CLOB allowances at startup (EOA mode — approve CLOB contracts to spend USDC)
async function ensureClobAllowances(): Promise<void> {
  if (process.env.PAPER_TRADING !== "false") return; // default: skip in paper mode
  try {
    const { runCli } = await import("./cli");
    const result = await runCli(["clob", "update-balance", "--asset-type", "collateral", "--signature-type", process.env.POLYMARKET_SIGNATURE_TYPE ?? "eoa"]);
    console.log("[startup] CLOB allowances set:", JSON.stringify(result).slice(0, 200));
  } catch (err) {
    console.error("[startup] CLOB allowance setup failed:", err);
  }
}
ensureClobAllowances().catch(() => {});
