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
import marketsRouter from "./routes/markets";
import walletRouter from "./routes/wallet";
import pipelineRouter from "./routes/pipeline";
import tradeRouter from "./routes/trade";
import streamRouter from "./routes/stream";
import portfolioRouter from "./routes/portfolio";
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
import fluxRouter from "./routes/flux";
import { startScheduler } from "./orchestrator/index";
import { startHotScanner } from "./oracle/hot-scanner";

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

// Initialize database on startup
getDb();

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
app.use("/api/portfolio", portfolioRouter);
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
app.use("/api/flux", fluxRouter);

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

app.listen(PORT, () => {
  console.log(`[quantik-backend] Running on http://localhost:${PORT}`);
  console.log(`[quantik-backend] Health: http://localhost:${PORT}/api/health`);

  // Start orchestrator scheduler (10-minute scan cycle)
  startScheduler();
  // Start 60s hot markets scanner
  startHotScanner();
});
