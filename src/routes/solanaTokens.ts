import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { createToken } from "../solana/tokenService";
import { getSwapQuote, buildSwapTransaction } from "../solana/swapService";
import { checkAndUpdateMigrationStatus } from "../solana/migrationMonitor";
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
// Returns swap quote for buy or sell side. Called by frontend TradingPanel.
// Query params: amount (number, USDC for buy / tokens for sell), side ("buy"|"sell")
router.get("/:poolAddress/quote", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const poolAddress = String(req.params.poolAddress);
    const amount = parseFloat(req.query.amount as string);
    const side = String(req.query.side ?? "");

    if (!amount || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }
    if (side !== "buy" && side !== "sell") {
      res.status(400).json({ error: "side must be 'buy' or 'sell'" });
      return;
    }

    const quote = await getSwapQuote(poolAddress, amount, side as "buy" | "sell");
    res.json(quote);
  } catch (err) {
    console.error("[solanaTokens:quote] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to get swap quote" });
  }
});

// ── POST /api/solana/tokens/:poolAddress/swap-tx ───────────────────────────
// Returns base64-serialized swap transaction for user wallet to sign.
// Body: { amountIn, minimumAmountOut, side, ownerPublicKey }
// Per D-10: User wallet signs. Non-custodial.
router.post("/:poolAddress/swap-tx", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const poolAddress = String(req.params.poolAddress);
    const { amountIn, minimumAmountOut, side, ownerPublicKey } = req.body as {
      amountIn?: string;
      minimumAmountOut?: string;
      side?: string;
      ownerPublicKey?: string;
    };

    if (!amountIn || !minimumAmountOut || !side || !ownerPublicKey) {
      res.status(400).json({
        error: "amountIn, minimumAmountOut, side, and ownerPublicKey are required",
      });
      return;
    }
    if (side !== "buy" && side !== "sell") {
      res.status(400).json({ error: "side must be 'buy' or 'sell'" });
      return;
    }

    const transactionBase64 = await buildSwapTransaction({
      poolAddress,
      amountIn,
      minimumAmountOut,
      side: side as "buy" | "sell",
      ownerPublicKey,
    });

    res.json({ transaction: transactionBase64 });
  } catch (err) {
    console.error("[solanaTokens:swap-tx] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to build swap transaction" });
  }
});

// ── GET /api/solana/tokens/by-mint/:mint ───────────────────────────────────
// Returns token status by mint address (used by /token/[mint] detail page).
// Auth required — returns 401 without auth.
router.get("/by-mint/:mint", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const { mint } = req.params;

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
         FROM solana_tokens WHERE token_mint = $1`,
        [mint]
      );
    } else {
      const db = getDb();
      token = db.prepare(
        `SELECT token_mint, dbc_pool_address, dbc_config_address, damm_pool_address, status,
                token_name, token_symbol, metadata_uri, created_at, migrated_at
         FROM solana_tokens WHERE token_mint = ?`
      ).get(mint) as typeof token;
    }

    res.json({ tokenized: !!token, token: token ?? null });
  } catch (err) {
    console.error("[solanaTokens:by-mint] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to get token" });
  }
});

// ── POST /api/solana/tokens/:poolAddress/check-migration ───────────────────
// Checks if a pool has migrated to DAMM and updates DB. Called post-trade or on-demand.
router.post("/:poolAddress/check-migration", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const poolAddress = String(req.params.poolAddress);
    const result = await checkAndUpdateMigrationStatus(poolAddress);
    res.json(result);
  } catch (err) {
    console.error("[solanaTokens:check-migration] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to check migration status" });
  }
});

export default router;
