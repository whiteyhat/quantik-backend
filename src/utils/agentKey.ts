// ── Shared active-agent wallet context ────────────────────────
// Single source of truth for loading the active agent's wallet
// address and decrypted private key. Used by the execution engine,
// balance checks, and risk portfolio manager.

import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { decrypt } from "../infra/encryption";

export interface AgentWalletContext {
  agentId: string;
  walletAddress: string;
  privateKey: string;
}

interface AgentKeyRow {
  id: string;
  wallet_address: string | null;
  encrypted_private_key: string | null;
}

async function loadAgentRow(agentId: string): Promise<AgentKeyRow | null> {
  if (isPgEnabled()) {
    return pgQueryOne<AgentKeyRow>(
      `SELECT id, wallet_address, encrypted_private_key
       FROM agents
       WHERE id = $1`,
      [agentId]
    );
  }

  const db = getDb();
  return (
    db
      .prepare(
        `SELECT id, wallet_address, encrypted_private_key
         FROM agents
         WHERE id = ?`
      )
      .get(agentId) as AgentKeyRow | undefined
  ) ?? null;
}

async function loadActiveAgentRow(): Promise<AgentKeyRow | null> {
  if (isPgEnabled()) {
    return pgQueryOne<AgentKeyRow>(
      `SELECT id, wallet_address, encrypted_private_key FROM agents
       WHERE polymarket_ready = 1 AND status != 'terminated'
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`
    );
  }

  const db = getDb();
  return (
    db
      .prepare(
        `SELECT id, wallet_address, encrypted_private_key FROM agents
         WHERE polymarket_ready = 1 AND status != 'terminated'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get() as AgentKeyRow | undefined
  ) ?? null;
}

/**
 * Load the active Polymarket-ready agent's wallet address and decrypted key.
 * Throws if no ready agent exists or the key cannot be decrypted.
 */
export async function loadActiveAgentContext(): Promise<AgentWalletContext> {
  const row = await loadActiveAgentRow();

  if (!row) {
    throw new Error(
      "No Polymarket-ready agent found. Ensure the agent wallet is funded and approvals are complete."
    );
  }
  if (!row.wallet_address) {
    throw new Error("Active agent has no wallet address.");
  }
  if (!row.encrypted_private_key) {
    throw new Error("Active agent has no encrypted private key.");
  }

  return {
    agentId: row.id,
    walletAddress: row.wallet_address,
    privateKey: decrypt(row.encrypted_private_key),
  };
}

/**
 * Best-effort version — returns null instead of throwing.
 * Use for non-critical paths (display, balance polling).
 */
export async function tryLoadActiveAgentContext(): Promise<AgentWalletContext | null> {
  try {
    return await loadActiveAgentContext();
  } catch {
    return null;
  }
}

export async function loadAgentWalletContext(agentId: string): Promise<AgentWalletContext> {
  const row = await loadAgentRow(agentId);

  if (!row) {
    throw new Error("Agent wallet context not found.");
  }
  if (!row.wallet_address) {
    throw new Error("Agent has no wallet address.");
  }
  if (!row.encrypted_private_key) {
    throw new Error("Agent has no encrypted private key. Please re-assign your wallet in Manage Agent.");
  }

  try {
    return {
      agentId: row.id,
      walletAddress: row.wallet_address,
      privateKey: decrypt(row.encrypted_private_key),
    };
  } catch (decryptErr) {
    console.error(`[agentKey] Failed to decrypt private key for agent ${agentId}:`, decryptErr instanceof Error ? decryptErr.message : decryptErr);
    throw new Error("Wallet key decryption failed. The server encryption key may have changed. Please re-assign your wallet in Manage Agent.");
  }
}

export async function tryLoadAgentWalletContext(agentId: string): Promise<AgentWalletContext | null> {
  try {
    return await loadAgentWalletContext(agentId);
  } catch {
    return null;
  }
}

/**
 * Diagnostic version — returns { context, error } instead of throwing.
 * Use when you need to surface the actual failure reason to the user.
 */
export async function loadAgentWalletContextWithDiag(agentId: string): Promise<{
  context: AgentWalletContext | null;
  error: string | null;
}> {
  try {
    const context = await loadAgentWalletContext(agentId);
    return { context, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown wallet error";
    console.error(`[agentKey] loadAgentWalletContext failed for agent ${agentId}: ${msg}`);
    return { context: null, error: msg };
  }
}
