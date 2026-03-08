import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne } from "../db/postgres";

export interface LinkedAgentContext {
  userId: string;
  agentId: string;
  status: string;
  agentType: string;
  walletAddress: string | null;
  autopilotEnabled: boolean;
}

function normalizeDbBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export async function loadLinkedAgentForUser(userId: string): Promise<LinkedAgentContext | null> {
  if (isPgEnabled()) {
    const row = await pgQueryOne<{
      user_id: string;
      agent_id: string;
      status: string;
      agent_type: string;
      wallet_address: string | null;
      autopilot_enabled: number | boolean | null;
    }>(
      `SELECT users.id AS user_id,
              agents.id AS agent_id,
              agents.status,
              agents.agent_type,
              agents.wallet_address,
              agents.autopilot_enabled
       FROM users
       JOIN agents ON agents.id = users.agent_id
       WHERE users.id = $1`,
      [userId]
    );
    if (!row) return null;
    return {
      userId: row.user_id,
      agentId: row.agent_id,
      status: row.status,
      agentType: row.agent_type,
      walletAddress: row.wallet_address,
      autopilotEnabled: normalizeDbBoolean(row.autopilot_enabled),
    };
  }

  const db = getDb();
  const row = db.prepare(
    `SELECT users.id AS user_id,
            agents.id AS agent_id,
            agents.status,
            agents.agent_type,
            agents.wallet_address,
            agents.autopilot_enabled
     FROM users
     JOIN agents ON agents.id = users.agent_id
     WHERE users.id = ?`
  ).get(userId) as {
    user_id: string;
    agent_id: string;
    status: string;
    agent_type: string;
    wallet_address: string | null;
    autopilot_enabled: number | boolean | null;
  } | undefined;

  if (!row) return null;
  return {
    userId: row.user_id,
    agentId: row.agent_id,
    status: row.status,
    agentType: row.agent_type,
    walletAddress: row.wallet_address,
    autopilotEnabled: normalizeDbBoolean(row.autopilot_enabled),
  };
}

export async function loadSingleAutopilotExecutionContext(): Promise<LinkedAgentContext | null> {
  if (isPgEnabled()) {
    const rows = await pgQuery<{
      user_id: string;
      agent_id: string;
      status: string;
      agent_type: string;
      wallet_address: string | null;
      autopilot_enabled: number | boolean | null;
    }>(
      `SELECT users.id AS user_id,
              agents.id AS agent_id,
              agents.status,
              agents.agent_type,
              agents.wallet_address,
              agents.autopilot_enabled
       FROM users
       JOIN agents ON agents.id = users.agent_id
       WHERE agents.status != 'terminated'
       LIMIT 2`
    );
    if (rows.length !== 1) return null;
    return {
      userId: rows[0].user_id,
      agentId: rows[0].agent_id,
      status: rows[0].status,
      agentType: rows[0].agent_type,
      walletAddress: rows[0].wallet_address,
      autopilotEnabled: normalizeDbBoolean(rows[0].autopilot_enabled),
    };
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT users.id AS user_id,
            agents.id AS agent_id,
            agents.status,
            agents.agent_type,
            agents.wallet_address,
            agents.autopilot_enabled
     FROM users
     JOIN agents ON agents.id = users.agent_id
     WHERE agents.status != 'terminated'
     LIMIT 2`
  ).all() as Array<{
    user_id: string;
    agent_id: string;
    status: string;
    agent_type: string;
    wallet_address: string | null;
    autopilot_enabled: number | boolean | null;
  }>;
  if (rows.length !== 1) return null;
  return {
    userId: rows[0].user_id,
    agentId: rows[0].agent_id,
    status: rows[0].status,
    agentType: rows[0].agent_type,
    walletAddress: rows[0].wallet_address,
    autopilotEnabled: normalizeDbBoolean(rows[0].autopilot_enabled),
  };
}
