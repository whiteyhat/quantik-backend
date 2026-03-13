import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne, pgExec } from "../db/postgres";

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

type AgentLinkRow = {
  user_id: string;
  agent_id: string;
  status: string;
  agent_type: string;
  wallet_address: string | null;
  autopilot_enabled: number | boolean | null;
};

function buildContext(row: AgentLinkRow): LinkedAgentContext {
  return {
    userId: row.user_id,
    agentId: row.agent_id,
    status: row.status,
    agentType: row.agent_type,
    walletAddress: row.wallet_address,
    autopilotEnabled: normalizeDbBoolean(row.autopilot_enabled),
  };
}

export async function loadLinkedAgentForUser(userId: string): Promise<LinkedAgentContext | null> {
  if (isPgEnabled()) {
    // Primary: join via users.agent_id
    const row = await pgQueryOne<AgentLinkRow>(
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
    if (row) return buildContext(row);

    // Fallback: find agent by user_id on agents table (covers users.agent_id sync gap)
    const fallbackRow = await pgQueryOne<AgentLinkRow>(
      `SELECT $1::text AS user_id,
              agents.id AS agent_id,
              agents.status,
              agents.agent_type,
              agents.wallet_address,
              agents.autopilot_enabled
       FROM agents
       WHERE agents.user_id = $1 AND agents.status != 'terminated'
       ORDER BY agents.created_at DESC
       LIMIT 1`,
      [userId]
    );
    if (!fallbackRow) return null;

    // Auto-heal: link this agent back to the user so future queries use the primary path
    try {
      await pgExec("UPDATE users SET agent_id = $1 WHERE id = $2", [fallbackRow.agent_id, userId]);
    } catch {
      // Non-fatal — the fallback data is still usable
    }
    return buildContext(fallbackRow);
  }

  const db = getDb();

  // Primary: join via users.agent_id
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
  ).get(userId) as AgentLinkRow | undefined;

  if (row) return buildContext(row);

  // Fallback: find agent by user_id on agents table
  const fallbackRow = db.prepare(
    `SELECT ? AS user_id,
            agents.id AS agent_id,
            agents.status,
            agents.agent_type,
            agents.wallet_address,
            agents.autopilot_enabled
     FROM agents
     WHERE agents.user_id = ? AND agents.status != 'terminated'
     ORDER BY agents.created_at DESC
     LIMIT 1`
  ).get(userId, userId) as AgentLinkRow | undefined;

  if (!fallbackRow) return null;

  // Auto-heal
  try {
    db.prepare("UPDATE users SET agent_id = ? WHERE id = ?").run(fallbackRow.agent_id, userId);
  } catch {
    // Non-fatal
  }
  return buildContext(fallbackRow);
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
