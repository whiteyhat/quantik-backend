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
});
