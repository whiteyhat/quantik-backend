// ── Socket.IO Server — real-time event bus ───────────────────────────────────
//
// Attached to the Express HTTP server. Provides real-time push for:
//   - trade:executed — when a trade is placed
//   - agent:alert — proactive agent insights
//   - autopilot:status — scanner/autopilot state changes
//   - position:updated — position P&L changes
//
// Each authenticated user joins a private room `user:{userId}`.
// Falls back gracefully — if no clients are connected, emit is a no-op.

import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";

let io: Server | null = null;

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

export function initSocketIO(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
        if (origin.endsWith(".vercel.app")) return cb(null, true);
        cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.handshake.auth?.userId as string | undefined;

    if (userId) {
      socket.join(`user:${userId}`);
      console.log(`[socket.io] User ${userId} connected (${socket.id})`);
    } else {
      console.log(`[socket.io] Anonymous connection (${socket.id})`);
    }

    socket.on("disconnect", (reason) => {
      if (userId) {
        console.log(`[socket.io] User ${userId} disconnected: ${reason}`);
      }
    });
  });

  console.log("[socket.io] WebSocket server initialized");
  return io;
}

export function getIO(): Server | null {
  return io;
}

// ── Typed Emitters ───────────────────────────────────────────────────────────

export interface TradeEvent {
  orderId: string;
  slug: string;
  direction: string;
  size: number;
  price: number;
  status: string;
  paper: boolean;
  timestamp: number;
}

export interface AgentAlertEvent {
  type: "signal" | "risk" | "insight";
  title: string;
  message: string;
  slug?: string;
  confidence?: number;
  timestamp: number;
}

export interface AutopilotStatusEvent {
  isRunning: boolean;
  lastScan: string | null;
  tradesToday: number;
  circuitBreakerTriggered: boolean;
  timestamp: number;
}

export interface PositionUpdateEvent {
  slug: string;
  currentPrice: number;
  pnl: number;
  pnlPct: number;
  timestamp: number;
}

/** Emit to a specific user's room */
export function emitToUser(userId: string, event: string, data: unknown): void {
  io?.to(`user:${userId}`).emit(event, data);
}

/** Emit to all connected clients */
export function emitToAll(event: string, data: unknown): void {
  io?.emit(event, data);
}

/** Emit a trade execution event */
export function emitTradeExecuted(userId: string | null, trade: TradeEvent): void {
  if (userId) {
    emitToUser(userId, "trade:executed", trade);
  } else {
    emitToAll("trade:executed", trade);
  }
}

/** Emit a proactive agent alert */
export function emitAgentAlert(userId: string | null, alert: AgentAlertEvent): void {
  if (userId) {
    emitToUser(userId, "agent:alert", alert);
  } else {
    emitToAll("agent:alert", alert);
  }
}

/** Emit autopilot status change */
export function emitAutopilotStatus(status: AutopilotStatusEvent): void {
  emitToAll("autopilot:status", status);
}

/** Emit position update */
export function emitPositionUpdate(userId: string | null, update: PositionUpdateEvent): void {
  if (userId) {
    emitToUser(userId, "position:updated", update);
  } else {
    emitToAll("position:updated", update);
  }
}
