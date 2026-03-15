import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { getUserId } from "../middleware/auth";
import { generateApiKey } from "../middleware/apiKeyAuth";
import { isPgEnabled, pgQuery, pgQueryOne, pgExec } from "../db/postgres";

const router = Router();

// ── POST /api/v1/api-keys — Generate a new API key ──────────────────────
router.post("/api-keys", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let agent: { id: string } | undefined;
  let existingKey: { id: string } | undefined;

  if (isPgEnabled()) {
    // Find user's BYO agent
    const agentRow = await pgQueryOne<{ id: string }>(
      `SELECT id FROM agents WHERE user_id = $1 AND agent_type = 'byo' AND status != 'terminated' LIMIT 1`,
      [userId]
    );
    agent = agentRow ?? undefined;

    if (!agent) {
      res.status(404).json({ error: "No BYO agent found. Create one first." });
      return;
    }

    // Check if there's already an active key (limit 1 active key per agent)
    const existingRow = await pgQueryOne<{ id: string }>(
      `SELECT id FROM api_keys WHERE agent_id = $1 AND revoked_at IS NULL LIMIT 1`,
      [agent.id]
    );
    existingKey = existingRow ?? undefined;
  } else {
    const db = getDb();

    // Find user's BYO agent
    agent = db.prepare(
      `SELECT id FROM agents WHERE user_id = ? AND agent_type = 'byo' AND status != 'terminated' LIMIT 1`
    ).get(userId) as { id: string } | undefined;

    if (!agent) {
      res.status(404).json({ error: "No BYO agent found. Create one first." });
      return;
    }

    // Check if there's already an active key (limit 1 active key per agent)
    existingKey = db.prepare(
      `SELECT id FROM api_keys WHERE agent_id = ? AND revoked_at IS NULL LIMIT 1`
    ).get(agent.id) as { id: string } | undefined;
  }

  if (existingKey) {
    res.status(409).json({
      error: "Active API key already exists. Rotate or revoke the existing key first.",
    });
    return;
  }

  const { fullKey, keyHash, keyPrefix } = generateApiKey();
  const id = uuidv4();
  const now = Date.now();

  const scopes = (req.body as { scopes?: string[] }).scopes ?? ["read", "trade", "analysis", "config"];

  if (isPgEnabled()) {
    await pgExec(`
      INSERT INTO api_keys (id, agent_id, user_id, key_hash, key_prefix, scopes, rate_limit_tier, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'standard', $7)
    `, [id, agent.id, userId, keyHash, keyPrefix, JSON.stringify(scopes), now]);
  } else {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (id, agent_id, user_id, key_hash, key_prefix, scopes, rate_limit_tier, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'standard', ?)
    `).run(id, agent.id, userId, keyHash, keyPrefix, JSON.stringify(scopes), now);
  }

  res.status(201).json({
    id,
    api_key: fullKey,
    key_prefix: keyPrefix,
    scopes,
    created_at: now,
    warning: "Save this key now. It will never be shown again.",
  });
});

// ── GET /api/v1/api-keys — List user's API keys ─────────────────────────
router.get("/api-keys", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  type ApiKeyRow = {
    id: string;
    key_prefix: string;
    scopes: string;
    rate_limit_tier: string;
    created_at: number;
    revoked_at: number | null;
    last_used_at: number | null;
  };

  let keys: ApiKeyRow[];

  if (isPgEnabled()) {
    keys = await pgQuery<ApiKeyRow>(`
      SELECT id, key_prefix, scopes, rate_limit_tier, created_at, revoked_at, last_used_at
      FROM api_keys
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);
  } else {
    const db = getDb();
    keys = db.prepare(`
      SELECT id, key_prefix, scopes, rate_limit_tier, created_at, revoked_at, last_used_at
      FROM api_keys
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId) as ApiKeyRow[];
  }

  res.json({
    keys: keys.map(k => ({
      ...k,
      scopes: JSON.parse(k.scopes),
      active: !k.revoked_at,
    })),
  });
});

// ── DELETE /api/v1/api-keys/:id — Revoke an API key ─────────────────────
router.delete("/api-keys/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let key: { id: string } | undefined;

  if (isPgEnabled()) {
    const row = await pgQueryOne<{ id: string }>(
      `SELECT id FROM api_keys WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId]
    );
    key = row ?? undefined;
  } else {
    const db = getDb();
    key = db.prepare(
      `SELECT id FROM api_keys WHERE id = ? AND user_id = ?`
    ).get(req.params.id, userId) as { id: string } | undefined;
  }

  if (!key) {
    res.status(404).json({ error: "API key not found" });
    return;
  }

  if (isPgEnabled()) {
    await pgExec("UPDATE api_keys SET revoked_at = $1 WHERE id = $2", [Date.now(), key.id]);
  } else {
    const db = getDb();
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), key.id);
  }

  res.json({ ok: true, message: "API key revoked" });
});

// ── POST /api/v1/api-keys/:id/rotate — Revoke old + generate new ────────
router.post("/api-keys/:id/rotate", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let oldKey: { id: string; agent_id: string; scopes: string } | undefined;

  if (isPgEnabled()) {
    const row = await pgQueryOne<{ id: string; agent_id: string; scopes: string }>(
      `SELECT id, agent_id, scopes FROM api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [req.params.id, userId]
    );
    oldKey = row ?? undefined;
  } else {
    const db = getDb();
    oldKey = db.prepare(
      `SELECT id, agent_id, scopes FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    ).get(req.params.id, userId) as { id: string; agent_id: string; scopes: string } | undefined;
  }

  if (!oldKey) {
    res.status(404).json({ error: "Active API key not found" });
    return;
  }

  const now = Date.now();

  // Generate new key
  const { fullKey, keyHash, keyPrefix } = generateApiKey();
  const newId = uuidv4();

  if (isPgEnabled()) {
    // Revoke old key
    await pgExec("UPDATE api_keys SET revoked_at = $1 WHERE id = $2", [now, oldKey.id]);

    // Insert new key
    await pgExec(`
      INSERT INTO api_keys (id, agent_id, user_id, key_hash, key_prefix, scopes, rate_limit_tier, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'standard', $7)
    `, [newId, oldKey.agent_id, userId, keyHash, keyPrefix, oldKey.scopes, now]);
  } else {
    const db = getDb();

    // Revoke old key
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(now, oldKey.id);

    // Insert new key
    db.prepare(`
      INSERT INTO api_keys (id, agent_id, user_id, key_hash, key_prefix, scopes, rate_limit_tier, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'standard', ?)
    `).run(newId, oldKey.agent_id, userId, keyHash, keyPrefix, oldKey.scopes, now);
  }

  res.status(201).json({
    id: newId,
    api_key: fullKey,
    key_prefix: keyPrefix,
    scopes: JSON.parse(oldKey.scopes),
    created_at: now,
    revoked_key_id: oldKey.id,
    warning: "Save this key now. It will never be shown again.",
  });
});

export default router;
