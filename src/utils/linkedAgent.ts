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

export interface AutopilotExecutionContext extends LinkedAgentContext {
  personality: string | null;
  decisionStyle: string | null;
  tradingInstinct: string | null;
  timePatience: string | null;
  moneyApproach: string | null;
  protectionMindset: string | null;
  marketSense: string | null;
  polymarketReady: boolean;
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

type AutopilotAgentRow = AgentLinkRow & {
  personality: string | null;
  decision_style: string | null;
  trading_instinct: string | null;
  time_patience: string | null;
  money_approach: string | null;
  protection_mindset: string | null;
  market_sense: string | null;
  polymarket_ready: number | boolean | null;
};

function buildAutopilotContext(row: AutopilotAgentRow): AutopilotExecutionContext {
  return {
    ...buildContext(row),
    personality: row.personality,
    decisionStyle: row.decision_style,
    tradingInstinct: row.trading_instinct,
    timePatience: row.time_patience,
    moneyApproach: row.money_approach,
    protectionMindset: row.protection_mindset,
    marketSense: row.market_sense,
    polymarketReady: normalizeDbBoolean(row.polymarket_ready),
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
  const rows = await loadAutopilotExecutionContexts();
  return rows[0] ?? null;
}

export async function loadAutopilotExecutionContexts(): Promise<AutopilotExecutionContext[]> {
  if (isPgEnabled()) {
    const rows = await pgQuery<AutopilotAgentRow>(
      `SELECT agents.user_id,
              agents.id AS agent_id,
              agents.status,
              agents.agent_type,
              agents.wallet_address,
              agents.autopilot_enabled,
              agents.personality,
              agents.decision_style,
              agents.trading_instinct,
              agents.time_patience,
              agents.money_approach,
              agents.protection_mindset,
              agents.market_sense,
              agents.polymarket_ready
       FROM agents
       WHERE agents.user_id IS NOT NULL
         AND agents.status = 'active'
         AND agents.autopilot_enabled = 1
         AND agents.polymarket_ready = 1
       ORDER BY agents.updated_at DESC NULLS LAST`
    );
    return rows.map(buildAutopilotContext);
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT agents.user_id,
            agents.id AS agent_id,
            agents.status,
            agents.agent_type,
            agents.wallet_address,
            agents.autopilot_enabled,
            agents.personality,
            agents.decision_style,
            agents.trading_instinct,
            agents.time_patience,
            agents.money_approach,
            agents.protection_mindset,
            agents.market_sense,
            agents.polymarket_ready
     FROM agents
     WHERE agents.user_id IS NOT NULL
       AND agents.status = 'active'
       AND agents.autopilot_enabled = 1
       AND agents.polymarket_ready = 1
     ORDER BY agents.updated_at DESC`
  ).all() as AutopilotAgentRow[];
  return rows.map(buildAutopilotContext);
}
