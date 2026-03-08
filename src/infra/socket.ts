// ── Socket.IO Server — real-time event bus ───────────────────────────────────
//
// Attached to the Express HTTP server. Provides real-time push for:
//   - trade:executed — when a trade is placed
//   - agent:alert — proactive agent insights
//   - autopilot:status — scanner/autopilot state changes
//   - position:update — position P&L changes
//
// Each authenticated user joins a private room `user:{userId}`.
// Falls back gracefully — if no clients are connected, emit is a no-op.

import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import crypto from "crypto";
import { getDb } from "../db/schema";

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
    const apiKey = socket.handshake.auth?.apiKey as string | undefined;

    // BYO agent auth via API key
    if (apiKey?.startsWith("qk_live_")) {
      const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
      const db = getDb();
      const row = db.prepare(`
        SELECT ak.agent_id, ak.user_id, ak.revoked_at, a.status AS agent_status
        FROM api_keys ak JOIN agents a ON a.id = ak.agent_id
        WHERE ak.key_hash = ?
      `).get(keyHash) as { agent_id: string; user_id: string; revoked_at: number | null; agent_status: string } | undefined;

      if (!row || row.revoked_at || row.agent_status === "terminated") {
        console.log(`[socket.io] BYO agent rejected — invalid key (${socket.id})`);
        socket.emit("error", { code: "UNAUTHORIZED", message: "Invalid or revoked API key" });
        socket.disconnect(true);
        return;
      }

      // Join the owner's room so BYO agents receive the same events as the dashboard
      socket.join(`user:${row.user_id}`);
      socket.join(`agent:${row.agent_id}`);
      socket.data.agentId = row.agent_id;
      socket.data.userId = row.user_id;
      socket.data.isByo = true;
      console.log(`[socket.io] BYO agent ${row.agent_id} connected (${socket.id})`);

      // Update heartbeat on connect
      db.prepare("UPDATE agents SET last_heartbeat = ?, connection_status = 'connected' WHERE id = ?")
        .run(Date.now(), row.agent_id);
    } else if (userId) {
      socket.join(`user:${userId}`);
      console.log(`[socket.io] User ${userId} connected (${socket.id})`);
    } else {
      console.log(`[socket.io] Anonymous connection (${socket.id})`);
    }

    socket.on("disconnect", (reason) => {
      if (socket.data.isByo) {
        console.log(`[socket.io] BYO agent ${socket.data.agentId} disconnected: ${reason}`);
      } else if (userId) {
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

/** Emit to a specific user's room (+ bridge to BYO webhooks) */
export function emitToUser(userId: string, event: string, data: unknown): void {
  io?.to(`user:${userId}`).emit(event, data);
  // Lazy import to avoid circular dependency at module load time
  import("./eventBridge").then(m => m.bridgeEmit(event, data, userId)).catch(() => {});
}

/** Emit to all connected clients (+ bridge to BYO webhooks) */
export function emitToAll(event: string, data: unknown): void {
  io?.emit(event, data);
  import("./eventBridge").then(m => m.bridgeEmit(event, data)).catch(() => {});
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
    emitToUser(userId, "position:update", update);
  } else {
    emitToAll("position:update", update);
  }
}
