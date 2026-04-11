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
import stellarRouter from "./routes/stellar";
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
import healthRouter from "./routes/health";
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
import byoOnboardingRouter from "./routes/byoOnboarding";
import agentChatRouter from "./routes/agentChat";
import apiKeysRouter from "./routes/apiKeys";
import skillRouter from "./routes/skill";
import toolApiRouter from "./routes/toolApi";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { ensureCircuitBreakerTable } from "./risk";
import alertsRouter from "./routes/alerts";
import notificationsRouter from "./routes/notifications";
import discoveryRouter from "./routes/discovery";
import solanaWalletRouter from "./routes/solanaWallet";
import solanaTokensRouter from "./routes/solanaTokens";
import bridgeRouter from "./routes/bridge";
import krakenRouter from "./routes/kraken";
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
  "http://localhost:3002",
  "http://127.0.0.1:3002",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://mission.adflix.now",
  "https://quantik.fun",
  "https://www.quantik.fun",
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
    // Allow any vercel.app subdomain
    if (origin.endsWith(".vercel.app") || origin.endsWith(".adflix.now") || origin.endsWith(".quantik.fun")) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json({ limit: "100kb" }));

// Clerk auth — attaches auth info to all requests (does NOT block unauthenticated)
app.use(clerkAuth);
app.use(ensureUser);

// API key auth — attaches BYO agent context when Bearer qk_live_... is present
app.use(apiKeyAuth);

// Redis-backed rate limiting (no-op when REDIS_URL is not set)
app.use(apiRateLimit);

// Initialize databases on startup
async function initializeDatastores(): Promise<void> {
  getDb();
  ensureCircuitBreakerTable();
  if (isPgEnabled()) {
    await migratePg();
    console.log("[startup] PostgreSQL ready");
  }
}

// Root route
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "quantik-backend", message: "Quantik Backend Online" });
});

// Routes
app.use("/api/health", healthRouter);
app.use("/api/markets", marketsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/solana/tokens", solanaTokensRouter);
app.use("/api/solana", solanaWalletRouter);
app.use("/api/stellar", stellarRouter);
app.use("/api/bridge", bridgeRouter);
app.use("/api/kraken", krakenRouter);
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
app.use("/api", notificationsRouter);
app.use("/api/scanner", scannerRouter);
app.use("/api/performance", performanceRouter);
app.use("/api/versions", versionsRouter);
app.use("/api/agents", agentHealthRouter);
app.use("/api/v1", byoOnboardingRouter);
app.use("/api/v1", agentsRouter);
app.use("/api/v1", discoveryRouter);
app.use("/api/v1", agentChatRouter);
app.use("/api/v1", apiKeysRouter);
app.use("/api/v1/tools", toolApiRouter);
app.use("/api", skillRouter);

// CLOB balance health endpoint — verify allowances without SSHing in
app.get("/api/clob/balance", async (_req, res) => {
  try {
    const { runCliWithWallet } = await import("./cli");
    const { tryLoadActiveAgentContext } = await import("./utils/agentKey");
    const agentCtx = await tryLoadActiveAgentContext();
    if (!agentCtx) {
      res.status(503).json({ ok: false, error: "No Polymarket-ready agent found" });
      return;
    }
    const result = await runCliWithWallet(["clob", "balance", "--asset-type", "collateral"], agentCtx.privateKey);
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

async function bootstrap(): Promise<void> {
  await initializeDatastores();

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

  ensureClobAllowances().catch(() => {});
}

// Set CLOB allowances at startup (EOA mode — approve CLOB contracts to spend USDC)
async function ensureClobAllowances(): Promise<void> {
  if (process.env.PAPER_TRADING !== "false") return; // default: skip in paper mode
  try {
    const { runCliWithWallet } = await import("./cli");
    const { tryLoadActiveAgentContext } = await import("./utils/agentKey");
    const agentCtx = await tryLoadActiveAgentContext();
    if (!agentCtx) {
      console.warn("[startup] CLOB allowance setup skipped — no Polymarket-ready agent found");
      return;
    }
    const result = await runCliWithWallet(
      ["clob", "update-balance", "--asset-type", "collateral", "--signature-type", process.env.POLYMARKET_SIGNATURE_TYPE ?? "eoa"],
      agentCtx.privateKey
    );
    console.log("[startup] CLOB allowances set:", JSON.stringify(result).slice(0, 200));
  } catch (err) {
    console.error("[startup] CLOB allowance setup failed:", err);
  }
}
// Only start server when running directly, not when imported in tests
if (process.env.NODE_ENV !== "test") {
  bootstrap().catch((err) => {
    console.error("[startup] Initialization failed:", err);
    process.exit(1);
  });
}

// Export app for testing (supertest integration tests)
export default app;
