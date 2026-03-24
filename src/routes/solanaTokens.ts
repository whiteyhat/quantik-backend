import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne, pgQuery, pgExec } from "../db/postgres";
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

// ── POST /api/solana/tokens/admin/retry-buyback/:distributionId ─────────────
// Triggers a manual re-run for a failed distribution. Requires authentication (per D-07).
// Admin validation: checks the distribution belongs to an agent owned by the requesting user.
// NOTE: Must be registered BEFORE /:mint/* routes to prevent "admin" being captured as :mint.
router.post("/admin/retry-buyback/:distributionId", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const distributionId = String(req.params.distributionId);

    // Validate distribution exists and belongs to user's agent
    const distSql = `
      SELECT td.id, td.agent_id, td.token_mint, td.status, td.retry_count,
             st.damm_pool_address, st.token_symbol
      FROM treasury_distributions td
      JOIN solana_tokens st ON st.token_mint = td.token_mint
      JOIN agents a ON a.id = td.agent_id
      WHERE td.id = ? AND a.user_id = ?
    `;
    let dist: { id: string; agent_id: string; token_mint: string; status: string; retry_count: number; damm_pool_address: string | null; token_symbol: string } | null = null;
    if (isPgEnabled()) {
      dist = await pgQueryOne(distSql.replace("?", "$1").replace("?", "$2"), [distributionId, userId]);
    } else {
      const db = getDb();
      dist = db.prepare(distSql).get(distributionId, userId) as typeof dist;
    }

    if (!dist) {
      res.status(404).json({ error: "Distribution not found or not authorized" });
      return;
    }

    if (!["buyback_failed", "audit_failed"].includes(dist.status)) {
      res.status(400).json({ error: `Cannot retry distribution in status '${dist.status}'` });
      return;
    }

    // Reset status to pending and increment retry_count so the next cron pick-up handles it
    // Full re-execution is triggered by the weekly cron — this endpoint just clears the failed status.
    // The airdropService.ts runWeeklyBuyback will re-attempt on next run.
    if (isPgEnabled()) {
      await pgExec(
        `UPDATE treasury_distributions SET status='pending', failure_reason=NULL, retry_count=retry_count+1 WHERE id=$1`,
        [distributionId]
      );
    } else {
      const db = getDb();
      db.prepare(
        `UPDATE treasury_distributions SET status='pending', failure_reason=NULL, retry_count=retry_count+1 WHERE id=?`
      ).run(distributionId);
    }

    // Dynamically import runWeeklyBuyback and trigger immediately for this specific distribution
    // (optional: in v1, just reset status and let weekly cron handle it)
    res.json({
      success: true,
      message: "Distribution reset to pending. The weekly buyback cycle will re-attempt execution.",
      distribution_id: distributionId,
    });
  } catch (err) {
    console.error("[solanaTokens] POST retry-buyback error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /api/solana/tokens/:mint/distributions/status ───────────────────────
// Returns the current week's distribution record (if any) + countdown to next distribution.
// Public endpoint — needed by frontend countdown timer (D-17).
// NOTE: Must be registered BEFORE /:mint/distributions to prevent "status" being captured as :id.
router.get("/:mint/distributions/status", async (req: Request, res: Response) => {
  try {
    const mint = String(req.params.mint);

    // Calculate current week window (Friday-to-Friday UTC)
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 5=Fri
    const daysUntilLastFriday = (dayOfWeek + 2) % 7; // days since last Friday
    const lastFriday = new Date(now);
    lastFriday.setUTCDate(lastFriday.getUTCDate() - daysUntilLastFriday);
    lastFriday.setUTCHours(0, 0, 0, 0);
    const nextFriday = new Date(lastFriday.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Fetch latest distribution record for this token
    const latestSql = `
      SELECT id, week_start, week_end, status, audit_status, failure_reason,
             weekly_pnl, buyback_amount_usdc, tokens_bought, created_at, completed_at
      FROM treasury_distributions
      WHERE token_mint = ?
      ORDER BY week_start DESC
      LIMIT 1
    `;
    let latest: unknown;
    if (isPgEnabled()) {
      const rows = await pgQuery(latestSql.replace("?", "$1"), [mint]);
      latest = rows[0] ?? null;
    } else {
      const db = getDb();
      latest = db.prepare(latestSql).get(mint) ?? null;
    }

    res.json({
      current_distribution: latest,
      next_distribution_at: nextFriday.getTime(),
      last_distribution_at: lastFriday.getTime(),
    });
  } catch (err) {
    console.error("[solanaTokens] GET distributions/status error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /api/solana/tokens/:mint/distributions ──────────────────────────────
// Returns distribution history for a token. Public (no auth required — transparency by design per D-19).
// Query params: limit (1-50, default 10), offset (default 0)
router.get("/:mint/distributions", async (req: Request, res: Response) => {
  try {
    const mint = String(req.params.mint);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "10"), 10)));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10));

    // Look up token to validate mint exists
    let token: { agent_id: string; token_symbol: string } | null = null;
    if (isPgEnabled()) {
      token = await pgQueryOne(
        "SELECT agent_id, token_symbol FROM solana_tokens WHERE token_mint = $1",
        [mint]
      );
    } else {
      const db = getDb();
      token = db.prepare(
        "SELECT agent_id, token_symbol FROM solana_tokens WHERE token_mint = ?"
      ).get(mint) as typeof token;
    }

    if (!token) {
      res.status(404).json({ error: "Token not found" });
      return;
    }

    // Fetch distribution history
    const sql = `
      SELECT id, week_start, week_end, weekly_pnl, buyback_amount_usdc,
             tokens_bought, holder_tokens, quantik_wallet_tokens,
             buyback_tx_signature, holder_distribution_tx_signature,
             status, audit_status, failure_reason, created_at, completed_at
      FROM treasury_distributions
      WHERE token_mint = ?
      ORDER BY week_start DESC
      LIMIT ? OFFSET ?
    `;
    const countSql = "SELECT COUNT(*) AS total FROM treasury_distributions WHERE token_mint = ?";

    let distributions: unknown[];
    let total: number;

    if (isPgEnabled()) {
      const pgSql = sql.replace("?", "$1").replace("?", "$2").replace("?", "$3");
      distributions = await pgQuery(pgSql, [mint, limit, offset]);
      const countRows = await pgQuery<{ total: number }>(
        countSql.replace("?", "$1"), [mint]
      );
      total = Number(countRows[0]?.total ?? 0);
    } else {
      const db = getDb();
      distributions = db.prepare(sql).all(mint, limit, offset);
      const countRow = db.prepare(countSql).get(mint) as { total: number };
      total = countRow?.total ?? 0;
    }

    res.json({ distributions, total, limit, offset });
  } catch (err) {
    console.error("[solanaTokens] GET distributions error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /api/solana/tokens/:mint/holders ──────────────────────────────────────
// Returns top 10 cached holders for a token. Reads from DB cache (not live RPC).
// Per D-06: cache updated hourly by solana:sync-holders cron job.
// Public endpoint — no auth required (leaderboard is public information).
router.get("/:mint/holders", async (req: Request, res: Response) => {
  try {
    const mint = String(req.params.mint);

    interface HolderRow {
      wallet: string;
      balance: number;
      percentage: number;
      rank: number;
      last_sync_time: number;
    }

    let holders: HolderRow[] = [];
    let lastSyncTime: number | null = null;

    if (isPgEnabled()) {
      holders = await pgQuery<HolderRow>(
        `SELECT wallet, balance, percentage, rank, last_sync_time
         FROM solana_token_holders
         WHERE mint = $1
         ORDER BY rank ASC
         LIMIT 10`,
        [mint]
      );
    } else {
      const db = getDb();
      holders = db.prepare(
        `SELECT wallet, balance, percentage, rank, last_sync_time
         FROM solana_token_holders
         WHERE mint = ?
         ORDER BY rank ASC
         LIMIT 10`
      ).all(mint) as HolderRow[];
    }

    if (holders.length > 0) {
      lastSyncTime = holders[0].last_sync_time;
    }

    res.json({
      holders,
      mint,
      lastSyncTime,
    });
  } catch (err) {
    console.error("[solanaTokens:holders] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to get holder leaderboard" });
  }
});

export default router;
