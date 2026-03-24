// ── Socket.IO Server — real-time event bus ───────────────────────────────────
//
// Attached to the Express HTTP server. Provides real-time push for:
//   - trade:executed — when a trade is placed
//   - agent:alert — proactive agent insights
//   - autopilot:status — scanner/autopilot state changes
//   - position:update — position P&L changes
//   - prices:update — batched live price changes
//   - notification:new — operator-facing system notifications
//   - panic:cooldown — panic mode cooldown / re-arm status
//
// Each authenticated user joins a private room `user:{userId}`.
// Falls back gracefully — if no clients are connected, emit is a no-op.

import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import crypto from "crypto";
import { getDb } from "../db/schema";
import { persistNotification } from "../services/notificationInbox";

let io: Server | null = null;

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://quantik.fun",
  "https://www.quantik.fun",
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

export function initSocketIO(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
        if (origin.endsWith(".vercel.app") || origin.endsWith(".quantik.fun")) return cb(null, true);
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

export interface PriceUpdateEventItem {
  slug: string;
  yes: number;
  no: number;
  timestamp: number;
}

export interface NotificationEvent {
  id: string;
  level: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  category?: string;
  timestamp: number;
  action?: {
    label: string;
    href: string;
  };
}

export interface PanicCooldownEvent {
  active: boolean;
  cooldownEndsAt: number | null;
  canRearm: boolean;
  reportId?: string | null;
  reason?: string | null;
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
  const isSwap = trade.direction.toUpperCase() === "SWAP";
  emitNotification(userId, {
    id: `trade-${trade.orderId}-${trade.timestamp}`,
    level: "success",
    title: trade.paper
      ? isSwap ? "Paper swap recorded" : "Paper trade executed"
      : isSwap ? "Swap submitted" : "Trade executed",
    message: isSwap
      ? `Swap submitted on ${trade.slug} for $${trade.size.toFixed(2)}.`
      : `${trade.direction} on ${trade.slug} for $${trade.size.toFixed(2)} at ${Math.round(trade.price * 100)}¢.`,
    category: "trade",
    timestamp: trade.timestamp,
    action: {
      label: "Open market",
      href: `/market/${trade.slug}`,
    },
  });
  if (userId) {
    emitToUser(userId, "trade:executed", trade);
  } else {
    emitToAll("trade:executed", trade);
  }
}

/** Emit a proactive agent alert */
export function emitAgentAlert(userId: string | null, alert: AgentAlertEvent): void {
  emitNotification(userId, {
    id: `agent-alert-${alert.type}-${alert.timestamp}-${alert.slug ?? "global"}`,
    level: alert.type === "risk" ? "warning" : "info",
    title: alert.title,
    message: alert.message,
    category: alert.type,
    timestamp: alert.timestamp,
    action: alert.slug
      ? {
          label: "Open market",
          href: `/market/${alert.slug}`,
        }
      : undefined,
  });
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

/** Emit batched live price updates */
export function emitPriceUpdate(update: PriceUpdateEventItem[]): void {
  emitToAll("prices:update", update);
}

/** Emit a system notification */
export function emitNotification(userId: string | null, notification: NotificationEvent): void {
  void persistNotification({
    id: notification.id,
    userId,
    level: notification.level,
    title: notification.title,
    message: notification.message,
    category: notification.category ?? null,
    timestamp: notification.timestamp,
    action: notification.action ?? null,
  }).catch((err) => {
    console.error("[notifications] persist failed:", err);
  });
  if (userId) {
    emitToUser(userId, "notification:new", notification);
  } else {
    emitToAll("notification:new", notification);
  }
}

/** Emit panic cooldown / re-arm status */
export function emitPanicCooldown(status: PanicCooldownEvent): void {
  const dedupeId = status.active
    ? `panic-cooldown-${status.reportId ?? status.cooldownEndsAt ?? status.timestamp}`
    : `panic-ready-${status.reportId ?? status.cooldownEndsAt ?? status.timestamp}`;
  emitNotification(null, {
    id: dedupeId,
    level: status.active ? "warning" : "success",
    title: status.active ? "Panic cooldown active" : "Panic control re-armed",
    message: status.active
      ? `Emergency controls cooling down${status.reason ? `: ${status.reason}` : ""}.`
      : "Panic controls can be used again.",
    category: "panic",
    timestamp: status.timestamp,
    action: status.reportId
      ? {
          label: "Open report",
          href: `/reports/liquidation/${status.reportId}`,
        }
      : undefined,
  });
  emitToAll("panic:cooldown", status);
}

// ── Distribution Event Emitters ───────────────────────────────────────────────

export interface DistributionStartEvent {
  agentId: string;
  tokenSymbol: string;
  tokenMint: string;
  buybackAmountUsdc: number;
  timestamp: number;
}

export interface DistributionCompleteEvent {
  agentId: string;
  tokenSymbol: string;
  tokenMint: string;
  tokensBought: number;
  holderCount: number;
  txSignature: string;
  timestamp: number;
}

export interface DistributionFailedEvent {
  agentId: string;
  tokenSymbol: string;
  tokenMint: string;
  reason: string;
  stage: "audit" | "buyback" | "airdrop";
  timestamp: number;
}

/** Emit distribution start — buyback about to execute */
export function emitDistributionStart(event: DistributionStartEvent): void {
  emitNotification(null, {
    id: `distribution-start-${event.agentId}-${event.timestamp}`,
    level: "info",
    title: `Buyback started for $${event.tokenSymbol}`,
    message: `${event.buybackAmountUsdc.toFixed(2)} USDC buyback initiated`,
    category: "distribution",
    timestamp: event.timestamp,
  });
  emitToAll("distribution:start", event);
}

/** Emit distribution complete — tokens bought and distributed to holders */
export function emitDistributionComplete(event: DistributionCompleteEvent): void {
  emitNotification(null, {
    id: `distribution-complete-${event.agentId}-${event.timestamp}`,
    level: "success",
    title: `Distribution sent to top ${event.holderCount} holders`,
    message: `${event.tokensBought.toLocaleString()} $${event.tokenSymbol} tokens distributed`,
    category: "distribution",
    timestamp: event.timestamp,
    action: {
      label: "View token",
      href: `/token/${event.tokenMint}`,
    },
  });
  emitToAll("distribution:complete", event);
}

/** Emit distribution failed — buyback or airdrop failed after retries */
export function emitDistributionFailed(event: DistributionFailedEvent): void {
  emitNotification(null, {
    id: `distribution-failed-${event.agentId}-${event.timestamp}`,
    level: "error",
    title: `Distribution failed for $${event.tokenSymbol}`,
    message: `${event.stage} stage failed: ${event.reason}`,
    category: "distribution",
    timestamp: event.timestamp,
  });
  emitToAll("distribution:failed", event);
}

// ── Holder Leaderboard Event Emitter ─────────────────────────────────────────

export interface HolderSnapshot {
  rank: number;
  wallet: string;
  balance: number;
  percentage: number;
}

export interface HoldersUpdatedEvent {
  mint: string;
  holders: HolderSnapshot[];
  updatedAt: number;
}

/** Emit holders:updated to mint-specific room after hourly sync */
export function emitHolderUpdate(event: HoldersUpdatedEvent): void {
  const io = getIO();
  if (!io) return;
  io.to(`mint:${event.mint}`).emit("holders:updated", event);
}

// ── Token Price Update Event Emitter ─────────────────────────────────────────

export interface TokenPriceUpdateEvent {
  mint: string;
  price: number;         // USDC decimal, e.g. 0.001234
  source: "dbc" | "damm_v2";
  timestamp: number;     // ms epoch
}

/** Emit price:token-update to mint-specific room after each 30s poll cycle */
export function emitTokenPriceUpdate(event: TokenPriceUpdateEvent): void {
  const io = getIO();
  if (!io) return;
  io.to(`mint:${event.mint}`).emit("price:token-update", event);
}
