import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { createToken } from "../solana/tokenService";
import { getIO } from "../infra/socket";
import { Server as SocketIOServer } from "socket.io";

const router = Router();

async function getRequiredUserId(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdAsync(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return userId;
}

// ── POST /api/solana/tokens/:agentId/tokenize ──────────────────────────────
// Creates SPL token + Meteora DBC pool for the given agent.
// Per D-03: Treasury wallet signs everything. User does NOT sign.
// Emits Socket.IO token:progress events to userId room during processing.
router.post("/:agentId/tokenize", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const agentId = String(req.params.agentId);

    // Validate agent belongs to user
    let agent: { id: string; name: string; agent_code: string | null; avatar_emoji: string | null; agent_type?: string | null } | null = null;
    if (isPgEnabled()) {
      agent = await pgQueryOne(
        "SELECT id, name, agent_code, avatar_emoji, agent_type FROM agents WHERE id = $1 AND user_id = $2",
        [agentId, userId]
      );
    } else {
      const db = getDb();
      agent = db.prepare(
        "SELECT id, name, agent_code, avatar_emoji, agent_type FROM agents WHERE id = ? AND user_id = ?"
      ).get(agentId, userId) as typeof agent;
    }

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Check if already tokenized — return 409 Conflict if so (idempotency guard per TKN-01)
    let existing: { token_mint: string } | null = null;
    if (isPgEnabled()) {
      existing = await pgQueryOne<{ token_mint: string }>(
        "SELECT token_mint FROM solana_tokens WHERE agent_id = $1",
        [agentId]
      );
    } else {
      const db = getDb();
      existing = db.prepare("SELECT token_mint FROM solana_tokens WHERE agent_id = ?").get(agentId) as { token_mint: string } | null;
    }

    if (existing) {
      res.status(409).json({
        error: "Agent already tokenized",
        tokenMint: existing.token_mint,
      });
      return;
    }

    // Immediately return 202 Accepted — actual work emits via Socket.IO
    res.status(202).json({ status: "processing", message: "Tokenization started — watch token:progress events" });

    // Async tokenization (non-blocking after 202 response)
    // userId is narrowed to string at this point (null was returned above)
    const confirmedUserId: string = userId;
    const io = getIO() as SocketIOServer;
    const agentCode = agent.agent_type === "byo" ? null : (agent.agent_code ?? null);
    const emoji = typeof agent.avatar_emoji === "string" ? agent.avatar_emoji : "🤖";
    createToken(agentId, confirmedUserId, io, agent.name, agentCode, emoji)
      .catch((err) => {
        console.error(`[solanaTokens:tokenize] error for agent ${agentId}:`, err instanceof Error ? err.message : err);
        io.to(confirmedUserId).emit("token:error", {
          agentId,
          error: err instanceof Error ? err.message : "Tokenization failed",
        });
      });
  } catch (err) {
    console.error("[solanaTokens:tokenize] unexpected error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Tokenization failed" });
  }
});

// ── GET /api/solana/tokens/:agentId/status ─────────────────────────────────
// Returns token status for a given agent. Returns null if not tokenized.
router.get("/:agentId/status", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const agentId = String(req.params.agentId);

    let token: {
      token_mint: string;
      dbc_pool_address: string;
      dbc_config_address: string;
      damm_pool_address: string | null;
      status: string;
      token_name: string;
      token_symbol: string;
      metadata_uri: string;
      created_at: number;
      migrated_at: number | null;
    } | null = null;

    if (isPgEnabled()) {
      token = await pgQueryOne(
        `SELECT token_mint, dbc_pool_address, dbc_config_address, damm_pool_address, status,
                token_name, token_symbol, metadata_uri, created_at, migrated_at
         FROM solana_tokens WHERE agent_id = $1`,
        [agentId]
      );
    } else {
      const db = getDb();
      token = db.prepare(
        `SELECT token_mint, dbc_pool_address, dbc_config_address, damm_pool_address, status,
                token_name, token_symbol, metadata_uri, created_at, migrated_at
         FROM solana_tokens WHERE agent_id = ?`
      ).get(agentId) as typeof token;
    }

    res.json({ tokenized: !!token, token: token ?? null });
  } catch (err) {
    console.error("[solanaTokens:status] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to get token status" });
  }
});

// ── GET /api/solana/tokens/:poolAddress/quote ──────────────────────────────
// Returns a swap quote for a given DBC pool (buy or sell direction).
// Query params: amount (USDC), side (buy|sell)
// Auth required — returns 401 without auth.
router.get("/:poolAddress/quote", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const poolAddress = String(req.params.poolAddress);
    const { amount, side } = req.query as { amount?: string; side?: string };

    if (!amount || !side) {
      res.status(400).json({ error: "amount and side (buy|sell) query params are required" });
      return;
    }

    if (side !== "buy" && side !== "sell") {
      res.status(400).json({ error: "side must be 'buy' or 'sell'" });
      return;
    }

    // Stub: real-time quote calculation will use DBC SDK in a later plan
    // For now, return a placeholder to keep the route active
    res.json({
      poolAddress,
      amount: parseFloat(amount),
      side,
      estimatedOutput: null,
      priceImpactPct: null,
      message: "Quote calculation not yet implemented — coming in Phase 3",
    });
  } catch (err) {
    console.error("[solanaTokens:quote] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to get quote" });
  }
});

export default router;
