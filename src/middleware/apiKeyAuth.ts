import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { getUserIdAsync } from "./auth";

// ── API Key Authentication Middleware ──────────────────────────────────────
// Authenticates BYO agents via `Authorization: Bearer qk_live_...` header.
// Works alongside Clerk auth — if no Bearer token is present, passes through.

export interface ApiKeyContext {
  agentId: string;
  userId: string;
  scopes: string[];
  rateLimitTier: string;
}

declare global {
  namespace Express {
    interface Request {
      apiKeyAgent?: ApiKeyContext;
    }
  }
}

const API_KEY_PREFIX = "qk_live_";

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
    next();
    return;
  }

  const apiKey = authHeader.slice(7); // Remove "Bearer "
  const keyHash = hashKey(apiKey);

  const db = getDb();
  const row = db.prepare(`
    SELECT ak.id, ak.agent_id, ak.user_id, ak.scopes, ak.rate_limit_tier, ak.revoked_at,
           a.status AS agent_status
    FROM api_keys ak
    JOIN agents a ON a.id = ak.agent_id
    WHERE ak.key_hash = ?
  `).get(keyHash) as {
    id: string;
    agent_id: string;
    user_id: string;
    scopes: string;
    rate_limit_tier: string;
    revoked_at: number | null;
    agent_status: string;
  } | undefined;

  if (!row || row.revoked_at) {
    next();
    return;
  }

  // Update last_used_at asynchronously (fire-and-forget)
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);

  let scopes: string[];
  try {
    scopes = JSON.parse(row.scopes);
  } catch {
    scopes = ["read"];
  }

  req.apiKeyAgent = {
    agentId: row.agent_id,
    userId: row.user_id,
    scopes,
    rateLimitTier: row.rate_limit_tier,
  };

  next();
}

// Middleware that requires a valid API key (returns 401 if missing/invalid)
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!req.apiKeyAgent) {
    res.status(401).json({ success: false, error: "Valid API key required", code: "UNAUTHORIZED" });
    return;
  }

  // Check if agent is paused or terminated
  const db = getDb();
  const agent = db.prepare("SELECT status FROM agents WHERE id = ?").get(req.apiKeyAgent.agentId) as { status: string } | undefined;

  if (agent?.status === "paused") {
    res.status(403).json({ success: false, error: "Agent is paused by owner", code: "AGENT_PAUSED" });
    return;
  }

  if (agent?.status === "terminated") {
    res.status(403).json({ success: false, error: "Agent has been terminated", code: "AGENT_TERMINATED" });
    return;
  }

  next();
}

// Scope-checking middleware factory
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.apiKeyAgent) {
      res.status(401).json({ success: false, error: "Valid API key required", code: "UNAUTHORIZED" });
      return;
    }

    if (!req.apiKeyAgent.scopes.includes(scope)) {
      res.status(403).json({
        success: false,
        error: `API key missing required scope: ${scope}`,
        code: "SCOPE_DENIED",
      });
      return;
    }

    next();
  };
}

// Dual-auth middleware: accepts either API key or Clerk auth
// Resolves agentId from either auth method and attaches to req
export function requireEitherAuth(req: Request, res: Response, next: NextFunction): void {
  // Path 1: API key auth — already resolved by apiKeyAuth middleware
  if (req.apiKeyAgent) {
    next();
    return;
  }

  getUserIdAsync(req)
    .then(async (userId) => {
      if (!userId) {
        res.status(401).json({ success: false, error: "Authentication required (API key or session)", code: "UNAUTHORIZED" });
        return;
      }

      let agent: { id: string } | undefined;
      if (isPgEnabled()) {
        agent = await pgQueryOne<{ id: string }>(
          "SELECT id FROM agents WHERE user_id = $1 AND status != 'terminated' LIMIT 1",
          [userId]
        ) ?? undefined;
      } else {
        const db = getDb();
        agent = db.prepare(
          "SELECT id FROM agents WHERE user_id = ? AND status != 'terminated' LIMIT 1"
        ).get(userId) as { id: string } | undefined;
      }

      if (!agent) {
        res.status(404).json({ success: false, error: "No agent found for this user", code: "NOT_FOUND" });
        return;
      }

      req.apiKeyAgent = {
        agentId: agent.id,
        userId,
        scopes: ["read", "trade", "analysis", "config"],
        rateLimitTier: "standard",
      };

      next();
    })
    .catch((err) => {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : "Authentication lookup failed",
        code: "AUTH_LOOKUP_FAILED",
      });
    });
}

// Helper to generate a new API key
export function generateApiKey(): { fullKey: string; keyHash: string; keyPrefix: string } {
  const randomPart = crypto.randomBytes(32).toString("hex");
  const fullKey = `${API_KEY_PREFIX}${randomPart}`;
  const keyHash = hashKey(fullKey);
  const keyPrefix = `${API_KEY_PREFIX}${randomPart.slice(0, 8)}`;
  return { fullKey, keyHash, keyPrefix };
}
