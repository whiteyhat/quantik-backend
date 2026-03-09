import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { getDb } from "../db/schema";
import { getBaseUrl } from "../utils/baseUrl";
import { getUserId, getUserIdAsync } from "../middleware/auth";
import { generateApiKey } from "../middleware/apiKeyAuth";
import { getPgPool, isPgEnabled, pgQueryOne } from "../db/postgres";
import { decrypt, encrypt } from "../infra/encryption";
import { generateWalletCredentials } from "../wallet/generate";
import { normalizeClaimedByoIdentity, validateExternalHttpsUrl } from "./byoIdentity";

const router = Router();

const ONBOARDING_TTL_MS = 15 * 60 * 1000;
const DEFAULT_WEBHOOK_EVENTS = ["*"];
const BYO_SCOPES = JSON.stringify(["read", "trade", "analysis", "config"]);
const BYO_SYSTEM_PROMPT = "BYO agent - externally managed";

type SessionStatus = "pending_claim" | "claimed" | "expired" | "failed" | "cancelled";

interface ByoSessionRecord {
  id: string;
  user_id: string;
  status: SessionStatus;
  token_hash: string;
  expires_at: number;
  claimed_at: number | null;
  agent_id: string | null;
  identity_name: string | null;
  identity_description: string | null;
  identity_avatar: string | null;
  agent_url: string | null;
  endpoint_url: string | null;
  webhook_events: string | null;
  encrypted_wallet_bundle: string | null;
  wallet_downloaded_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface AgentSummary {
  id: string;
  name: string;
  avatar_emoji: string;
  description: string | null;
  agent_url: string | null;
  endpoint_url: string | null;
  webhook_events: string[];
  wallet_address: string | null;
  api_key_prefix: string | null;
  connection_status: string | null;
}

interface ProvisionedByoAgent {
  agent: AgentSummary;
  walletEscrowCiphertext: string;
  credentials: {
    api_key: string;
    api_base_url: string;
    skill_manifest_url: string;
    skill_json_url: string;
    heartbeat_url: string;
    wallet_address: string;
    wallet_private_key: string;
    wallet_seed_phrase: string;
    webhook_secret: string;
  };
}

interface WalletEscrowBundle {
  address: string;
  privateKey: string;
  seedPhrase: string;
}

type SessionUpdateFields = Pick<ByoSessionRecord,
  "status" |
  "claimed_at" |
  "agent_id" |
  "identity_name" |
  "identity_description" |
  "identity_avatar" |
  "agent_url" |
  "endpoint_url" |
  "webhook_events" |
  "encrypted_wallet_bundle" |
  "wallet_downloaded_at" |
  "last_error" |
  "updated_at"
>;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateAgentCode(): string {
  const num = Math.floor(Math.random() * 900 + 100);
  return `Q-AGENT-X${num}`;
}

function parseWebhookEvents(value: unknown): string[] {
  if (Array.isArray(value)) {
    const cleaned = Array.from(
      new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))
    );
    return cleaned.length > 0 ? cleaned : DEFAULT_WEBHOOK_EVENTS;
  }

  if (typeof value === "string" && value.trim()) {
    try {
      return parseWebhookEvents(JSON.parse(value));
    } catch {
      return DEFAULT_WEBHOOK_EVENTS;
    }
  }

  return DEFAULT_WEBHOOK_EVENTS;
}

function normalizeWebhookEvents(value: unknown):
  | { ok: true; events: string[] }
  | { ok: false; error: string } {
  if (value == null) {
    return { ok: true, events: DEFAULT_WEBHOOK_EVENTS };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: "webhook_events must be an array of strings" };
  }

  const events = Array.from(
    new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))
  );

  if (events.length === 0) {
    return { ok: true, events: DEFAULT_WEBHOOK_EVENTS };
  }

  if (events.includes("*")) {
    return { ok: true, events: DEFAULT_WEBHOOK_EVENTS };
  }

  return { ok: true, events };
}

function optionalExternalUrl(value: unknown, fieldName: "endpoint_url" | "agent_url"):
  | { ok: true; normalizedUrl: string | null }
  | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: true, normalizedUrl: null };
  }

  const validated = validateExternalHttpsUrl(value, fieldName);
  if (!validated.ok) return validated;
  return { ok: true, normalizedUrl: validated.normalizedUrl };
}

function requiredExternalUrl(value: unknown, fieldName: "endpoint_url" | "agent_url"):
  | { ok: true; normalizedUrl: string }
  | { ok: false; error: string } {
  return validateExternalHttpsUrl(value, fieldName);
}

function normalizeSessionExpiry(record: ByoSessionRecord): ByoSessionRecord {
  if (record.status === "pending_claim" && record.expires_at <= Date.now()) {
    return { ...record, status: "expired", updated_at: Date.now() };
  }
  return record;
}

function serializeEvents(events: string[]): string {
  return JSON.stringify(events);
}

function serializeWalletBundle(bundle: WalletEscrowBundle): string {
  return encrypt(JSON.stringify(bundle));
}

function deserializeWalletBundle(encryptedBundle: string): WalletEscrowBundle {
  const raw = JSON.parse(decrypt(encryptedBundle)) as Partial<WalletEscrowBundle>;
  if (
    typeof raw.address !== "string" ||
    typeof raw.privateKey !== "string" ||
    typeof raw.seedPhrase !== "string"
  ) {
    throw new Error("Invalid wallet escrow payload");
  }

  return {
    address: raw.address,
    privateKey: raw.privateKey,
    seedPhrase: raw.seedPhrase,
  };
}

function buildClaimUrl(req: Request, token: string): string {
  return `${getBaseUrl(req)}/api/v1/agents/byo/claim/${token}`;
}

async function getUserIdOrReject(req: Request, res: Response): Promise<string | null> {
  const userId = isPgEnabled() ? await getUserIdAsync(req) : getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return userId;
}

async function terminateExistingAgents(userId: string): Promise<void> {
  const db = getDb();

  const sqliteAgents = db.prepare(
    "SELECT id FROM agents WHERE user_id = ? AND status != 'terminated'"
  ).all(userId) as { id: string }[];

  for (const agent of sqliteAgents) {
    db.prepare("DELETE FROM webhook_delivery_log WHERE agent_id = ?").run(agent.id);
    db.prepare("DELETE FROM byo_request_log WHERE agent_id = ?").run(agent.id);
    db.prepare("DELETE FROM api_keys WHERE agent_id = ?").run(agent.id);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
  }
  db.prepare("UPDATE users SET agent_id = NULL WHERE id = ?").run(userId);

  if (isPgEnabled()) {
    const pool = getPgPool();
    const { rows: pgAgents } = await pool.query<{ id: string }>(
      "SELECT id FROM agents WHERE user_id = $1 AND status != 'terminated'",
      [userId]
    );
    for (const agent of pgAgents) {
      await pool.query("DELETE FROM webhook_delivery_log WHERE agent_id = $1", [agent.id]);
      await pool.query("DELETE FROM byo_request_log WHERE agent_id = $1", [agent.id]);
      await pool.query("DELETE FROM api_keys WHERE agent_id = $1", [agent.id]);
      await pool.query("DELETE FROM agents WHERE id = $1", [agent.id]);
    }
    await pool.query("UPDATE users SET agent_id = NULL WHERE id = $1", [userId]);
  }
}

function writeSqliteSession(record: ByoSessionRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO byo_onboarding_sessions (
      id, user_id, status, token_hash, expires_at, claimed_at, agent_id,
      identity_name, identity_description, identity_avatar, agent_url, endpoint_url,
      webhook_events, encrypted_wallet_bundle, wallet_downloaded_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.user_id,
    record.status,
    record.token_hash,
    record.expires_at,
    record.claimed_at,
    record.agent_id,
    record.identity_name,
    record.identity_description,
    record.identity_avatar,
    record.agent_url,
    record.endpoint_url,
    record.webhook_events,
    record.encrypted_wallet_bundle,
    record.wallet_downloaded_at,
    record.last_error,
    record.created_at,
    record.updated_at,
  );
}

async function writePgSession(record: ByoSessionRecord): Promise<void> {
  if (!isPgEnabled()) return;
  await getPgPool().query(`
    INSERT INTO byo_onboarding_sessions (
      id, user_id, status, token_hash, expires_at, claimed_at, agent_id,
      identity_name, identity_description, identity_avatar, agent_url, endpoint_url,
      webhook_events, encrypted_wallet_bundle, wallet_downloaded_at, last_error, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
  `, [
    record.id,
    record.user_id,
    record.status,
    record.token_hash,
    record.expires_at,
    record.claimed_at,
    record.agent_id,
    record.identity_name,
    record.identity_description,
    record.identity_avatar,
    record.agent_url,
    record.endpoint_url,
    record.webhook_events,
    record.encrypted_wallet_bundle,
    record.wallet_downloaded_at,
    record.last_error,
    record.created_at,
    record.updated_at,
  ]);
}

function updateSqliteSession(
  id: string,
  updates: Partial<SessionUpdateFields>
): void {
  const db = getDb();
  const fields = Object.keys(updates);
  if (fields.length === 0) return;
  const assignments = fields.map((field) => `${field} = ?`).join(", ");
  const values = fields.map((field) => (updates as Record<string, unknown>)[field]);
  db.prepare(`UPDATE byo_onboarding_sessions SET ${assignments} WHERE id = ?`).run(...values, id);
}

async function updatePgSession(
  id: string,
  updates: Partial<SessionUpdateFields>
): Promise<void> {
  if (!isPgEnabled()) return;
  const fields = Object.keys(updates);
  if (fields.length === 0) return;
  const assignments = fields.map((field, index) => `${field} = $${index + 1}`).join(", ");
  const values = fields.map((field) => (updates as Record<string, unknown>)[field]);
  await getPgPool().query(`UPDATE byo_onboarding_sessions SET ${assignments} WHERE id = $${fields.length + 1}`, [...values, id]);
}

function readSqliteSessionById(userId: string, sessionId: string): ByoSessionRecord | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM byo_onboarding_sessions WHERE id = ? AND user_id = ?"
  ).get(sessionId, userId) as ByoSessionRecord | undefined;
  return row ?? null;
}

async function readPgSessionById(userId: string, sessionId: string): Promise<ByoSessionRecord | null> {
  if (!isPgEnabled()) return null;
  return await pgQueryOne<ByoSessionRecord>(
    "SELECT * FROM byo_onboarding_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId]
  );
}

function readSqliteSessionByToken(tokenHash: string): ByoSessionRecord | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM byo_onboarding_sessions WHERE token_hash = ?"
  ).get(tokenHash) as ByoSessionRecord | undefined;
  return row ?? null;
}

async function readPgSessionByToken(tokenHash: string): Promise<ByoSessionRecord | null> {
  if (!isPgEnabled()) return null;
  return await pgQueryOne<ByoSessionRecord>(
    "SELECT * FROM byo_onboarding_sessions WHERE token_hash = $1",
    [tokenHash]
  );
}

async function loadSessionById(userId: string, sessionId: string): Promise<ByoSessionRecord | null> {
  const row = isPgEnabled()
    ? await readPgSessionById(userId, sessionId)
    : readSqliteSessionById(userId, sessionId);
  if (!row) return null;
  const normalized = normalizeSessionExpiry(row);
  if (normalized.status !== row.status) {
    updateSqliteSession(row.id, { status: normalized.status, updated_at: normalized.updated_at });
    await updatePgSession(row.id, { status: normalized.status, updated_at: normalized.updated_at });
  }
  return normalized;
}

async function loadSessionByToken(tokenHash: string): Promise<ByoSessionRecord | null> {
  const row = isPgEnabled()
    ? await readPgSessionByToken(tokenHash)
    : readSqliteSessionByToken(tokenHash);
  if (!row) return null;
  const normalized = normalizeSessionExpiry(row);
  if (normalized.status !== row.status) {
    updateSqliteSession(row.id, { status: normalized.status, updated_at: normalized.updated_at });
    await updatePgSession(row.id, { status: normalized.status, updated_at: normalized.updated_at });
  }
  return normalized;
}

function buildSqliteAgentSummary(agentId: string): AgentSummary | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, name, avatar_emoji, description, agent_url, endpoint_url, webhook_events, wallet_address, connection_status
    FROM agents
    WHERE id = ?
  `).get(agentId) as {
    id: string;
    name: string;
    avatar_emoji: string;
    description: string | null;
    agent_url: string | null;
    endpoint_url: string | null;
    webhook_events: string | null;
    wallet_address: string | null;
    connection_status: string | null;
  } | undefined;

  if (!row) return null;

  const apiKey = db.prepare(
    "SELECT key_prefix FROM api_keys WHERE agent_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1"
  ).get(agentId) as { key_prefix: string } | undefined;

  return {
    ...row,
    webhook_events: parseWebhookEvents(row.webhook_events),
    api_key_prefix: apiKey?.key_prefix ?? null,
  };
}

async function buildPgAgentSummary(agentId: string): Promise<AgentSummary | null> {
  if (!isPgEnabled()) return null;
  const row = await pgQueryOne<{
    id: string;
    name: string;
    avatar_emoji: string;
    description: string | null;
    agent_url: string | null;
    endpoint_url: string | null;
    webhook_events: string | null;
    wallet_address: string | null;
    connection_status: string | null;
  }>(`
    SELECT id, name, avatar_emoji, description, agent_url, endpoint_url, webhook_events, wallet_address, connection_status
    FROM agents
    WHERE id = $1
  `, [agentId]);

  if (!row) return null;

  const apiKey = await pgQueryOne<{ key_prefix: string }>(
    "SELECT key_prefix FROM api_keys WHERE agent_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [agentId]
  );

  return {
    ...row,
    webhook_events: parseWebhookEvents(row.webhook_events),
    api_key_prefix: apiKey?.key_prefix ?? null,
  };
}

async function buildAgentSummary(agentId: string): Promise<AgentSummary | null> {
  if (isPgEnabled()) {
    return (await buildPgAgentSummary(agentId)) ?? buildSqliteAgentSummary(agentId);
  }
  return buildSqliteAgentSummary(agentId);
}

function insertSqliteProvision(args: {
  userId: string;
  agentId: string;
  agentCode: string;
  name: string;
  avatar: string;
  description: string | null;
  endpointUrl: string | null;
  agentUrl: string | null;
  webhookEvents: string[];
  webhookSecret: string;
  walletAddress: string;
  keyId: string;
  keyHash: string;
  keyPrefix: string;
  now: number;
}): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO agents (
        id, agent_code, status, name, avatar_emoji, agent_type, description, endpoint_url, agent_url,
        connection_status, webhook_secret, webhook_events, personality, decision_style, trading_instinct,
        time_patience, profit_dream, money_approach, protection_mindset, leverage_vibe,
        market_sense, asset_love, system_prompt, wallet_address, user_id, created_at, updated_at
      ) VALUES (?, ?, 'inactive', ?, ?, 'byo', ?, ?, ?, 'pending', ?, ?,
        'balanced', 'analyst', 'value_hunter', 'swing', 'wealth_builder',
        'smart_scaling', 'flexible', 'none', 'mood_reader', 'crypto',
        ?, ?, ?, ?, ?)
    `).run(
      args.agentId,
      args.agentCode,
      args.name,
      args.avatar,
      args.description,
      args.endpointUrl,
      args.agentUrl,
      args.webhookSecret,
      serializeEvents(args.webhookEvents),
      BYO_SYSTEM_PROMPT,
      args.walletAddress,
      args.userId,
      args.now,
      args.now,
    );

    db.prepare(`
      INSERT INTO api_keys (id, agent_id, user_id, key_hash, key_prefix, scopes, rate_limit_tier, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'standard', ?)
    `).run(args.keyId, args.agentId, args.userId, args.keyHash, args.keyPrefix, BYO_SCOPES, args.now);

    db.prepare("UPDATE users SET agent_id = ? WHERE id = ?").run(args.agentId, args.userId);
  });

  tx();
}

function rollbackSqliteProvision(agentId: string, keyId: string, userId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM api_keys WHERE id = ?").run(keyId);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    db.prepare("UPDATE users SET agent_id = NULL WHERE id = ? AND agent_id = ?").run(userId, agentId);
  });
  tx();
}

async function insertPgProvision(args: {
  userId: string;
  agentId: string;
  agentCode: string;
  name: string;
  avatar: string;
  description: string | null;
  endpointUrl: string | null;
  agentUrl: string | null;
  webhookEvents: string[];
  webhookSecret: string;
  walletAddress: string;
  keyId: string;
  keyHash: string;
  keyPrefix: string;
  now: number;
}): Promise<void> {
  if (!isPgEnabled()) return;

  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO agents (
        id, agent_code, status, name, avatar_emoji, agent_type, description, endpoint_url, agent_url,
        connection_status, webhook_secret, webhook_events, personality, decision_style, trading_instinct,
        time_patience, profit_dream, money_approach, protection_mindset, leverage_vibe,
        market_sense, asset_love, system_prompt, wallet_address, user_id, created_at, updated_at
      ) VALUES ($1, $2, 'inactive', $3, $4, 'byo', $5, $6, $7, 'pending', $8, $9,
        'balanced', 'analyst', 'value_hunter', 'swing', 'wealth_builder',
        'smart_scaling', 'flexible', 'none', 'mood_reader', 'crypto',
        $10, $11, $12, $13, $14)
    `, [
      args.agentId,
      args.agentCode,
      args.name,
      args.avatar,
      args.description,
      args.endpointUrl,
      args.agentUrl,
      args.webhookSecret,
      serializeEvents(args.webhookEvents),
      BYO_SYSTEM_PROMPT,
      args.walletAddress,
      args.userId,
      args.now,
      args.now,
    ]);

    await client.query(`
      INSERT INTO api_keys (id, agent_id, user_id, key_hash, key_prefix, scopes, rate_limit_tier, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'standard', $7)
    `, [args.keyId, args.agentId, args.userId, args.keyHash, args.keyPrefix, BYO_SCOPES, args.now]);

    await client.query("UPDATE users SET agent_id = $1 WHERE id = $2", [args.agentId, args.userId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function provisionByoAgent(
  req: Request,
  input: {
    userId: string;
    name: string;
    avatar: string;
    description: string | null;
    agentUrl: string;
    endpointUrl: string | null;
    webhookEvents: string[];
  }
): Promise<ProvisionedByoAgent> {
  const id = uuidv4();
  const agentCode = generateAgentCode();
  const now = Date.now();
  const keyId = uuidv4();
  const { fullKey, keyHash, keyPrefix } = generateApiKey();
  const webhookSecret = crypto.randomBytes(32).toString("hex");
  const wallet = await generateWalletCredentials();
  const walletEscrowCiphertext = serializeWalletBundle({
    address: wallet.address,
    privateKey: wallet.privateKey,
    seedPhrase: wallet.seedPhrase,
  });

  insertSqliteProvision({
    userId: input.userId,
    agentId: id,
    agentCode,
    name: input.name,
    avatar: input.avatar,
    description: input.description,
    endpointUrl: input.endpointUrl,
    agentUrl: input.agentUrl,
    webhookEvents: input.webhookEvents,
    webhookSecret,
    walletAddress: wallet.address,
    keyId,
    keyHash,
    keyPrefix,
    now,
  });

  try {
    await insertPgProvision({
      userId: input.userId,
      agentId: id,
      agentCode,
      name: input.name,
      avatar: input.avatar,
      description: input.description,
      endpointUrl: input.endpointUrl,
      agentUrl: input.agentUrl,
      webhookEvents: input.webhookEvents,
      webhookSecret,
      walletAddress: wallet.address,
      keyId,
      keyHash,
      keyPrefix,
      now,
    });
  } catch (err) {
    rollbackSqliteProvision(id, keyId, input.userId);
    throw err;
  }

  return {
    agent: {
      id,
      name: input.name,
      avatar_emoji: input.avatar,
      description: input.description,
      agent_url: input.agentUrl,
      endpoint_url: input.endpointUrl,
      webhook_events: input.webhookEvents,
      wallet_address: wallet.address,
      api_key_prefix: keyPrefix,
      connection_status: "pending",
    },
    walletEscrowCiphertext,
    credentials: {
      api_key: fullKey,
      api_base_url: `${getBaseUrl(req)}/api/v1/tools`,
      skill_manifest_url: `${getBaseUrl(req)}/api/skill.md`,
      skill_json_url: `${getBaseUrl(req)}/api/skill.json`,
      heartbeat_url: `${getBaseUrl(req)}/api/v1/tools/heartbeat`,
      wallet_address: wallet.address,
      wallet_private_key: wallet.privateKey,
      wallet_seed_phrase: wallet.seedPhrase,
      webhook_secret: webhookSecret,
    },
  };
}

async function updateSqliteByoConfig(args: {
  agentId: string;
  endpointUrl: string | null;
  agentUrl: string | null;
  webhookEvents: string[];
}): Promise<void> {
  const db = getDb();
  db.prepare(`
    UPDATE agents
    SET endpoint_url = ?, agent_url = ?, webhook_events = ?, updated_at = ?
    WHERE id = ? AND agent_type = 'byo'
  `).run(args.endpointUrl, args.agentUrl, serializeEvents(args.webhookEvents), Date.now(), args.agentId);
}

async function updatePgByoConfig(args: {
  agentId: string;
  endpointUrl: string | null;
  agentUrl: string | null;
  webhookEvents: string[];
}): Promise<void> {
  if (!isPgEnabled()) return;
  await getPgPool().query(`
    UPDATE agents
    SET endpoint_url = $1, agent_url = $2, webhook_events = $3, updated_at = $4
    WHERE id = $5 AND agent_type = 'byo'
  `, [args.endpointUrl, args.agentUrl, serializeEvents(args.webhookEvents), Date.now(), args.agentId]);
}

async function syncSessionConfigForAgent(args: {
  agentId: string;
  endpointUrl: string | null;
  agentUrl: string | null;
  webhookEvents: string[];
}): Promise<void> {
  const updates = {
    endpoint_url: args.endpointUrl,
    agent_url: args.agentUrl,
    webhook_events: serializeEvents(args.webhookEvents),
    updated_at: Date.now(),
  };

  const db = getDb();
  db.prepare(`
    UPDATE byo_onboarding_sessions
    SET endpoint_url = ?, agent_url = ?, webhook_events = ?, updated_at = ?
    WHERE agent_id = ?
  `).run(args.endpointUrl, args.agentUrl, serializeEvents(args.webhookEvents), updates.updated_at, args.agentId);

  if (isPgEnabled()) {
    await getPgPool().query(`
      UPDATE byo_onboarding_sessions
      SET endpoint_url = $1, agent_url = $2, webhook_events = $3, updated_at = $4
      WHERE agent_id = $5
    `, [args.endpointUrl, args.agentUrl, updates.webhook_events, updates.updated_at, args.agentId]);
  }
}

async function ensureOwnerOwnsByoAgent(agentId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const sqliteAgent = db.prepare(
    "SELECT id FROM agents WHERE id = ? AND user_id = ? AND agent_type = 'byo'"
  ).get(agentId, userId) as { id: string } | undefined;
  if (sqliteAgent) return true;

  if (!isPgEnabled()) return false;
  const pgAgent = await pgQueryOne<{ id: string }>(
    "SELECT id FROM agents WHERE id = $1 AND user_id = $2 AND agent_type = 'byo'",
    [agentId, userId]
  );
  return Boolean(pgAgent);
}

router.post("/agents/byo/onboarding", async (req: Request, res: Response) => {
  const userId = await getUserIdOrReject(req, res);
  if (!userId) return;

  try {
    await terminateExistingAgents(userId);
  } catch (err) {
    console.error("[byo-onboarding] auto-replace error:", err);
    res.status(500).json({ error: "Failed to replace existing agent" });
    return;
  }

  const now = Date.now();
  const token = crypto.randomBytes(32).toString("hex");
  const session: ByoSessionRecord = {
    id: uuidv4(),
    user_id: userId,
    status: "pending_claim",
    token_hash: hashToken(token),
    expires_at: now + ONBOARDING_TTL_MS,
    claimed_at: null,
    agent_id: null,
    identity_name: null,
    identity_description: null,
    identity_avatar: null,
    agent_url: null,
    endpoint_url: null,
    webhook_events: serializeEvents(DEFAULT_WEBHOOK_EVENTS),
    encrypted_wallet_bundle: null,
    wallet_downloaded_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };

  writeSqliteSession(session);
  await writePgSession(session);

  res.status(201).json({
    session_id: session.id,
    onboarding_url: buildClaimUrl(req, token),
    expires_at: session.expires_at,
  });
});

router.get("/agents/byo/onboarding/:sessionId", async (req: Request, res: Response) => {
  const userId = await getUserIdOrReject(req, res);
  if (!userId) return;
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;

  const session = await loadSessionById(userId, sessionId);
  if (!session) {
    res.status(404).json({ error: "Onboarding session not found" });
    return;
  }

  const agent = session.agent_id ? await buildAgentSummary(session.agent_id) : null;

  res.json({
    session_id: session.id,
    status: session.status,
    expires_at: session.expires_at,
    claimed_at: session.claimed_at,
    agent_id: session.agent_id,
    identity: session.identity_name ? {
      name: session.identity_name,
      description: session.identity_description,
      avatar: session.identity_avatar ?? agent?.avatar_emoji ?? "🦞",
    } : null,
    agent_url: agent?.agent_url ?? session.agent_url,
    endpoint_url: agent?.endpoint_url ?? session.endpoint_url,
    webhook_events: agent?.webhook_events ?? parseWebhookEvents(session.webhook_events),
    api_key_prefix: agent?.api_key_prefix ?? null,
    wallet_address: agent?.wallet_address ?? null,
    connection_status: agent?.connection_status ?? null,
    wallet_download_ready: Boolean(session.encrypted_wallet_bundle),
    wallet_downloaded_at: session.wallet_downloaded_at,
    last_error: session.last_error,
  });
});

router.get("/agents/byo/claim/:claimToken", async (req: Request, res: Response) => {
  const claimToken = Array.isArray(req.params.claimToken) ? req.params.claimToken[0] : req.params.claimToken;
  const session = await loadSessionByToken(hashToken(claimToken));
  if (!session) {
    res.status(404).json({ error: "Claim link not found" });
    return;
  }

  if (session.status !== "pending_claim") {
    res.status(410).json({ error: "Claim link is no longer valid" });
    return;
  }

  const claimUrl = buildClaimUrl(req, claimToken);
  res.json({
    success: true,
    workflow: "openclaw_byo_claim_v1",
    expires_at: session.expires_at,
    submit_url: claimUrl,
    method: "POST",
    required_fields: ["name", "agent_url"],
    optional_fields: ["description", "endpoint_url", "webhook_events"],
    instructions: "POST your identity payload to this same URL. Include your public agent URL. Quantik will return your runtime credentials in the response, and the owner will finalize webhook delivery in the dashboard before activation.",
    runtime_urls: {
      skill_manifest_url: `${getBaseUrl(req)}/api/skill.md`,
      skill_json_url: `${getBaseUrl(req)}/api/skill.json`,
    },
  });
});

router.post("/agents/byo/claim/:claimToken", async (req: Request, res: Response) => {
  const claimToken = Array.isArray(req.params.claimToken) ? req.params.claimToken[0] : req.params.claimToken;
  const session = await loadSessionByToken(hashToken(claimToken));
  if (!session) {
    res.status(404).json({ error: "Claim link not found" });
    return;
  }

  if (session.status === "claimed") {
    res.status(409).json({ error: "Claim link already used" });
    return;
  }

  if (session.status !== "pending_claim") {
    res.status(410).json({ error: "Claim link is no longer valid" });
    return;
  }

  try {
    await terminateExistingAgents(session.user_id);
  } catch (err) {
    console.error("[byo-claim] auto-replace error:", err);
    const now = Date.now();
    updateSqliteSession(session.id, { status: "failed", last_error: "Auto-replace failed", updated_at: now });
    await updatePgSession(session.id, { status: "failed", last_error: "Auto-replace failed", updated_at: now });
    res.status(500).json({ error: "Failed to replace existing agent" });
    return;
  }

  const normalizedIdentity = normalizeClaimedByoIdentity(req.body as {
    name?: unknown;
    description?: unknown;
    emoji?: unknown;
    avatar?: unknown;
  });
  if (!normalizedIdentity.ok) {
    res.status(400).json({ error: normalizedIdentity.error });
    return;
  }

  const agentUrl = requiredExternalUrl((req.body as { agent_url?: unknown }).agent_url, "agent_url");
  if (!agentUrl.ok) {
    res.status(400).json({ error: agentUrl.error });
    return;
  }

  const endpointUrl = optionalExternalUrl((req.body as { endpoint_url?: unknown }).endpoint_url, "endpoint_url");
  if (!endpointUrl.ok) {
    res.status(400).json({ error: endpointUrl.error });
    return;
  }

  const webhookEvents = normalizeWebhookEvents((req.body as { webhook_events?: unknown }).webhook_events);
  if (!webhookEvents.ok) {
    res.status(400).json({ error: webhookEvents.error });
    return;
  }

  try {
    const provisioned = await provisionByoAgent(req, {
      userId: session.user_id,
      name: normalizedIdentity.identity.name,
      avatar: normalizedIdentity.identity.avatar,
      description: normalizedIdentity.identity.description,
      agentUrl: agentUrl.normalizedUrl,
      endpointUrl: endpointUrl.normalizedUrl,
      webhookEvents: webhookEvents.events,
    });

    const claimedAt = Date.now();
    const updates = {
      status: "claimed" as const,
      claimed_at: claimedAt,
      agent_id: provisioned.agent.id,
      identity_name: provisioned.agent.name,
      identity_description: provisioned.agent.description,
      identity_avatar: provisioned.agent.avatar_emoji,
      agent_url: provisioned.agent.agent_url,
      endpoint_url: provisioned.agent.endpoint_url,
      webhook_events: serializeEvents(provisioned.agent.webhook_events),
      encrypted_wallet_bundle: provisioned.walletEscrowCiphertext,
      wallet_downloaded_at: null,
      last_error: null,
      updated_at: claimedAt,
    };
    updateSqliteSession(session.id, updates);
    await updatePgSession(session.id, updates);

    res.json({
      success: true,
      agent: provisioned.agent,
      credentials: provisioned.credentials,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to provision BYO agent";
    const failedAt = Date.now();
    updateSqliteSession(session.id, { status: "failed", last_error: message, updated_at: failedAt });
    await updatePgSession(session.id, { status: "failed", last_error: message, updated_at: failedAt });
    console.error("[byoOnboarding] claim error:", err);
    res.status(500).json({ error: "Failed to complete claim" });
  }
});

router.post("/agents/byo/onboarding/:sessionId/wallet-download", async (req: Request, res: Response) => {
  const userId = await getUserIdOrReject(req, res);
  if (!userId) return;
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;

  const session = await loadSessionById(userId, sessionId);
  if (!session) {
    res.status(404).json({ error: "Onboarding session not found" });
    return;
  }

  if (session.status !== "claimed") {
    res.status(409).json({ error: "Wallet backup is not available until the OpenClaw claim is complete" });
    return;
  }

  if (session.wallet_downloaded_at) {
    res.status(410).json({ error: "Wallet backup has already been downloaded" });
    return;
  }

  if (!session.encrypted_wallet_bundle) {
    res.status(410).json({ error: "Wallet backup is no longer available" });
    return;
  }

  try {
    const wallet = deserializeWalletBundle(session.encrypted_wallet_bundle);
    const downloadedAt = Date.now();
    const updates = {
      encrypted_wallet_bundle: null,
      wallet_downloaded_at: downloadedAt,
      updated_at: downloadedAt,
    };
    updateSqliteSession(session.id, updates);
    await updatePgSession(session.id, updates);

    res.json({
      address: wallet.address,
      privateKey: wallet.privateKey,
      seedPhrase: wallet.seedPhrase,
    });
  } catch (err) {
    console.error("[byoOnboarding] wallet download error:", err);
    res.status(500).json({ error: "Wallet backup is unavailable" });
  }
});

router.patch("/agents/:id/byo-config", async (req: Request, res: Response) => {
  const userId = await getUserIdOrReject(req, res);
  if (!userId) return;
  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!(await ensureOwnerOwnsByoAgent(agentId, userId))) {
    res.status(404).json({ error: "BYO agent not found" });
    return;
  }

  const currentAgent = await buildAgentSummary(agentId);
  if (!currentAgent) {
    res.status(404).json({ error: "BYO agent not found" });
    return;
  }

  const requestBody = req.body as {
    endpoint_url?: unknown;
    agent_url?: unknown;
    webhook_events?: unknown;
  };
  const hasEndpointUrl = Object.prototype.hasOwnProperty.call(requestBody, "endpoint_url");
  const hasAgentUrl = Object.prototype.hasOwnProperty.call(requestBody, "agent_url");
  const hasWebhookEvents = Object.prototype.hasOwnProperty.call(requestBody, "webhook_events");

  let nextEndpointUrl = currentAgent.endpoint_url;
  if (hasEndpointUrl) {
    const endpointUrl = optionalExternalUrl(requestBody.endpoint_url, "endpoint_url");
    if (!endpointUrl.ok) {
      res.status(400).json({ error: endpointUrl.error });
      return;
    }
    nextEndpointUrl = endpointUrl.normalizedUrl;
  }

  let nextAgentUrl = currentAgent.agent_url;
  if (hasAgentUrl) {
    const agentUrl = requiredExternalUrl(requestBody.agent_url, "agent_url");
    if (!agentUrl.ok) {
      res.status(400).json({ error: agentUrl.error });
      return;
    }
    nextAgentUrl = agentUrl.normalizedUrl;
  }

  let nextWebhookEvents = currentAgent.webhook_events;
  if (hasWebhookEvents) {
    const webhookEvents = normalizeWebhookEvents(requestBody.webhook_events);
    if (!webhookEvents.ok) {
      res.status(400).json({ error: webhookEvents.error });
      return;
    }
    nextWebhookEvents = webhookEvents.events;
  }

  await updateSqliteByoConfig({
    agentId,
    endpointUrl: nextEndpointUrl,
    agentUrl: nextAgentUrl,
    webhookEvents: nextWebhookEvents,
  });
  await updatePgByoConfig({
    agentId,
    endpointUrl: nextEndpointUrl,
    agentUrl: nextAgentUrl,
    webhookEvents: nextWebhookEvents,
  });
  await syncSessionConfigForAgent({
    agentId,
    endpointUrl: nextEndpointUrl,
    agentUrl: nextAgentUrl,
    webhookEvents: nextWebhookEvents,
  });

  const agent = await buildAgentSummary(agentId);
  res.json({ success: true, data: agent });
});

export default router;
