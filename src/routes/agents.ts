import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { getDb } from "../db/schema";
import { getUserId, getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne, pgQuery, pgExec } from "../db/postgres";
import { requireEitherAuth } from "../middleware/apiKeyAuth";
import { getWalletFundingSnapshot } from "../utils/balances";
import { computeHealthScore } from "../monitoring/healthScore";
import { generateWalletCredentials } from "../wallet/generate";
import { encrypt } from "../infra/encryption";
import { rateLimit } from "../infra/rateLimit";
import { verifyAndPreparePolymarket } from "../services/polymarket-prep.service";

const router = Router();

// ── Attribute-to-Prompt Mappings ─────────────────────────────

const PERSONALITY: Record<string, string> = {
  guardian: "You are a conservative, risk-averse trader. Capital preservation is your #1 priority. Never risk more than 1% of portfolio on a single trade. When in doubt, stay out.",
  balanced: "You seek optimal risk/reward balance. Target 2-3% risk per trade. Take calculated positions where expected value is clearly positive.",
  adventurer: "You are an aggressive, high-conviction trader. You tolerate large drawdowns for outsized returns. You size up on strong signals and aren't afraid of volatility.",
};

const DECISION: Record<string, string> = {
  gut: "You act quickly on momentum shifts and market sentiment. Speed matters more than exhaustive analysis. Trust pattern recognition and react fast.",
  analyst: "You are deeply data-driven. Every decision requires multiple confirming indicators, statistical edge calculation, and thorough technical analysis before entry.",
  observer: "You are extremely patient. You wait for high-probability setups with clear confluence. You ignore noise and only act when conditions are ideal.",
};

const INSTINCT: Record<string, string> = {
  trend_chaser: "You follow established trends. Buy breakouts, ride momentum, use moving averages and trend lines. Never fight the trend.",
  reversal_spotter: "You identify exhaustion points and counter-trend opportunities. Look for divergences, oversold/overbought conditions, and capitulation signals.",
  value_hunter: "You find mispriced assets using fundamental analysis. Look for discrepancies between intrinsic value and market price.",
  speed_demon: "You scalp micro-movements with high frequency. Target small gains repeatedly. Use tight stops and rapid execution.",
};

const TIME: Record<string, string> = {
  lightning: "Your holding period is seconds to minutes. You are a day trader / scalper. Close all positions by end of session.",
  swing: "Your holding period is hours to days. You capture medium-term swings and multi-day trends.",
  longterm: "Your holding period is days to weeks. You build positions gradually and let winners run.",
};

const PROFIT: Record<string, string> = {
  quick_wins: "Target consistent small gains with high win rate. Compound returns through volume of trades rather than size of individual wins.",
  big_moves: "Hunt for outsized returns on high-conviction breakout trades. Accept lower win rate for much higher reward-to-risk ratio.",
  wealth_builder: "Focus on steady compounding growth. Reinvest profits, minimize drawdowns, and build portfolio value over time.",
};

const MONEY: Record<string, string> = {
  fixed_safe: "Use fixed position sizes (1-2% of portfolio). Never vary size regardless of conviction. Consistency over optimization.",
  smart_scaling: "Scale position size based on conviction level and recent performance. Size up on winning streaks, down on losing streaks. Use Kelly criterion.",
  aggressive: "Maximize capital utilization. Size aggressively on high-conviction setups. Concentrate portfolio in best ideas.",
};

const PROTECTION: Record<string, string> = {
  tight: "Use tight stop-losses (0.5-1% from entry). Cut losses immediately. Never move a stop loss further from entry.",
  flexible: "Use dynamic stops based on ATR/volatility. Give trades room to breathe but always have a defined exit.",
  hands_off: "Focus on take-profit targets more than stops. Use wide stops or mental stops. Let positions develop.",
};

// Leverage is disabled — agents always trade spot only (1x, no borrowing/lending).

const SENSE: Record<string, string> = {
  fixed_rules: "Make decisions purely on quantitative indicators and technical rules. Ignore news, social media, and narrative. Numbers only.",
  mood_reader: "Incorporate social sentiment, news flow, and market narrative into decisions. Use both quantitative and qualitative signals.",
};

const ASSET: Record<string, string> = {
  stocks: "You specialize in equities and major indices. Focus on earnings, sector rotation, and institutional flows.",
  forex: "You specialize in currency pairs and macro. Focus on central bank policy, interest rate differentials, and geopolitical events.",
  crypto: "You specialize in digital assets. Focus on on-chain metrics, DeFi flows, whale movements, and crypto-native catalysts.",
  all_rounder: "You trade across all asset classes. Diversify by seeking the best opportunities regardless of market.",
};

// ── System Prompt Builder ────────────────────────────────────

function buildSystemPrompt(config: Omit<AgentCreateBody, "wallet_address">, agentCode: string): string {
  return `# Agent: ${config.name} (${agentCode})

## Core Identity
You are ${config.name}, an AI trading agent deployed on the Quantik platform.
${PERSONALITY[config.personality] ?? ""}

## Decision Framework
${DECISION[config.decisionStyle] ?? ""}

## Trading Strategy
${INSTINCT[config.tradingInstinct] ?? ""}

## Time Horizon
${TIME[config.timePatience] ?? ""}

## Position Sizing
${MONEY[config.moneyApproach] ?? ""}

## Risk Management
${PROTECTION[config.protectionMindset] ?? ""}

## Market Analysis Approach
${SENSE[config.marketSense] ?? ""}

## Asset Specialization
${ASSET[config.assetLove] ?? ""}

## Profit Objective
${PROFIT[config.profitDream] ?? ""}

## Operational Rules
1. Always respect your risk parameters. Never override your protection mindset.
2. Log every decision with reasoning for audit trail.
3. If circuit breaker triggers, halt all activity immediately.
4. Report performance metrics after every trade.
5. Never exceed allocated capital for this agent's wallet.`;
}

// ── Types ────────────────────────────────────────────────────

interface AgentCreateBody {
  name: string;
  avatar: string;
  animalType?: string;
  generatedImage?: string | null;
  wallet_address?: string;
  private_key?: string;
  seed_phrase?: string;
  personality: string;
  decisionStyle: string;
  tradingInstinct: string;
  timePatience: string;
  profitDream: string;
  moneyApproach: string;
  protectionMindset: string;
  marketSense: string;
  assetLove: string;
}

function generateAgentCode(): string {
  const num = Math.floor(Math.random() * 900 + 100);
  return `Q-AGENT-X${num}`;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface OwnedAgentRecord {
  id: string;
  user_id: string;
  agent_type: string;
  status: string;
  last_heartbeat: number | null;
  connection_status: string | null;
}

interface OwnedAgentContext extends OwnedAgentRecord {
  name: string;
  wallet_address: string | null;
  endpoint_url: string | null;
  webhook_secret: string | null;
  autopilot_enabled: number | boolean | null;
  autopilot_updated_at: number | null;
}

interface UsageStats {
  total_requests_24h: number;
  requests_last_hour: number;
  error_count_24h: number;
  error_rate_24h: string;
  by_tool: { tool: string; requests: number; avg_latency_ms: number | null; errors: number }[];
  daily_breakdown: { day: string; count: number; errors: number }[];
  recent_errors: { tool_name: string; status_code: number; error: string | null; created_at: number }[];
}

async function getRequiredUserId(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdAsync(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return userId;
}

async function terminateExistingAgents(userId: string): Promise<void> {
  const now = Date.now();
  const db = getDb();

  // Find all non-terminated agents for this user
  const sqliteAgents = db.prepare(
    `SELECT id FROM agents WHERE user_id = ? AND status != 'terminated'`
  ).all(userId) as { id: string }[];

  for (const agent of sqliteAgents) {
    db.prepare(`DELETE FROM webhook_delivery_log WHERE agent_id = ?`).run(agent.id);
    db.prepare(`DELETE FROM byo_request_log WHERE agent_id = ?`).run(agent.id);
    db.prepare(`DELETE FROM api_keys WHERE agent_id = ?`).run(agent.id);
    db.prepare(`DELETE FROM agents WHERE id = ?`).run(agent.id);
  }
  db.prepare(`UPDATE users SET agent_id = NULL WHERE id = ?`).run(userId);

  if (isPgEnabled()) {
    const pgAgents = await pgQuery<{ id: string }>(
      `SELECT id FROM agents WHERE user_id = $1 AND status != 'terminated'`,
      [userId]
    );
    for (const agent of pgAgents) {
      await pgExec(`DELETE FROM webhook_delivery_log WHERE agent_id = $1`, [agent.id]);
      await pgExec(`DELETE FROM byo_request_log WHERE agent_id = $1`, [agent.id]);
      await pgExec(`DELETE FROM api_keys WHERE agent_id = $1`, [agent.id]);
      await pgExec(`DELETE FROM agents WHERE id = $1`, [agent.id]);
    }
    await pgExec(`UPDATE users SET agent_id = NULL WHERE id = $1`, [userId]);
  }
}

async function loadOwnedAgent(agentId: string, userId: string): Promise<OwnedAgentRecord | null> {
  if (isPgEnabled()) {
    return await pgQueryOne<OwnedAgentRecord>(
      `SELECT id, user_id, agent_type, status, last_heartbeat, connection_status
       FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    );
  }

  const db = getDb();
  const agent = db.prepare(
    `SELECT id, user_id, agent_type, status, last_heartbeat, connection_status
     FROM agents WHERE id = ? AND user_id = ?`
  ).get(agentId, userId) as OwnedAgentRecord | undefined;
  return agent ?? null;
}

async function loadOwnedAgentContext(agentId: string, userId: string): Promise<OwnedAgentContext | null> {
  if (isPgEnabled()) {
    return await pgQueryOne<OwnedAgentContext>(
      `SELECT id, user_id, agent_type, status, last_heartbeat, connection_status,
              name, wallet_address, endpoint_url, webhook_secret, autopilot_enabled, autopilot_updated_at
       FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    );
  }

  const db = getDb();
  const agent = db.prepare(
    `SELECT id, user_id, agent_type, status, last_heartbeat, connection_status,
            name, wallet_address, endpoint_url, webhook_secret, autopilot_enabled, autopilot_updated_at
     FROM agents WHERE id = ? AND user_id = ?`
  ).get(agentId, userId) as OwnedAgentContext | undefined;
  return agent ?? null;
}

function normalizeAutopilotEnabled(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

async function loadUsageStats(agentId: string): Promise<UsageStats> {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  if (isPgEnabled()) {
    const total24h = await pgQueryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM byo_request_log WHERE agent_id = $1 AND created_at >= $2",
      [agentId, oneDayAgo]
    );
    const byTool = await pgQuery<{
      tool_name: string;
      count: number;
      avg_latency: number | null;
      errors: number;
    }>(
      `SELECT tool_name,
              COUNT(*)::int AS count,
              AVG(latency_ms) AS avg_latency,
              COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0)::int AS errors
       FROM byo_request_log
       WHERE agent_id = $1 AND created_at >= $2
       GROUP BY tool_name
       ORDER BY count DESC`,
      [agentId, oneDayAgo]
    );
    const errors24h = await pgQueryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM byo_request_log WHERE agent_id = $1 AND created_at >= $2 AND status_code >= 400",
      [agentId, oneDayAgo]
    );
    const lastHour = await pgQueryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM byo_request_log WHERE agent_id = $1 AND created_at >= $2",
      [agentId, oneHourAgo]
    );
    const dailyBreakdown = await pgQuery<{ day: string; count: number; errors: number }>(
      `SELECT TO_CHAR(TO_TIMESTAMP(created_at / 1000.0), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS count,
              COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0)::int AS errors
       FROM byo_request_log
       WHERE agent_id = $1 AND created_at >= $2
       GROUP BY day
       ORDER BY day ASC`,
      [agentId, sevenDaysAgo]
    );
    const recentErrors = await pgQuery<{
      tool_name: string;
      status_code: number;
      error: string | null;
      created_at: number;
    }>(
      `SELECT tool_name, status_code, error, created_at
       FROM byo_request_log
       WHERE agent_id = $1 AND status_code >= 400
       ORDER BY created_at DESC
       LIMIT 10`,
      [agentId]
    );

    const total = total24h?.count ?? 0;
    const errors = errors24h?.count ?? 0;
    return {
      total_requests_24h: total,
      requests_last_hour: lastHour?.count ?? 0,
      error_count_24h: errors,
      error_rate_24h: total > 0 ? `${((errors / total) * 100).toFixed(1)}%` : "0%",
      by_tool: byTool.map((entry) => ({
        tool: entry.tool_name,
        requests: entry.count,
        avg_latency_ms: entry.avg_latency == null ? null : Math.round(entry.avg_latency),
        errors: entry.errors,
      })),
      daily_breakdown: dailyBreakdown,
      recent_errors: recentErrors,
    };
  }

  const db = getDb();
  const total24h = db.prepare(
    "SELECT COUNT(*) as count FROM byo_request_log WHERE agent_id = ? AND created_at >= ?"
  ).get(agentId, oneDayAgo) as { count: number };
  const byTool = db.prepare(
    `SELECT tool_name, COUNT(*) as count, AVG(latency_ms) as avg_latency,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
     FROM byo_request_log WHERE agent_id = ? AND created_at >= ?
     GROUP BY tool_name ORDER BY count DESC`
  ).all(agentId, oneDayAgo) as { tool_name: string; count: number; avg_latency: number | null; errors: number }[];
  const errors24h = db.prepare(
    "SELECT COUNT(*) as count FROM byo_request_log WHERE agent_id = ? AND created_at >= ? AND status_code >= 400"
  ).get(agentId, oneDayAgo) as { count: number };
  const lastHour = db.prepare(
    "SELECT COUNT(*) as count FROM byo_request_log WHERE agent_id = ? AND created_at >= ?"
  ).get(agentId, oneHourAgo) as { count: number };
  const dailyBreakdown = db.prepare(
    `SELECT DATE(created_at / 1000, 'unixepoch') as day, COUNT(*) as count,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
     FROM byo_request_log WHERE agent_id = ? AND created_at >= ?
     GROUP BY day ORDER BY day ASC`
  ).all(agentId, sevenDaysAgo) as { day: string; count: number; errors: number }[];
  const recentErrors = db.prepare(
    `SELECT tool_name, status_code, error, created_at
     FROM byo_request_log WHERE agent_id = ? AND status_code >= 400
     ORDER BY created_at DESC LIMIT 10`
  ).all(agentId) as { tool_name: string; status_code: number; error: string | null; created_at: number }[];

  return {
    total_requests_24h: total24h.count,
    requests_last_hour: lastHour.count,
    error_count_24h: errors24h.count,
    error_rate_24h: total24h.count > 0 ? `${((errors24h.count / total24h.count) * 100).toFixed(1)}%` : "0%",
    by_tool: byTool.map((entry) => ({
      tool: entry.tool_name,
      requests: entry.count,
      avg_latency_ms: entry.avg_latency == null ? null : Math.round(entry.avg_latency),
      errors: entry.errors,
    })),
    daily_breakdown: dailyBreakdown,
    recent_errors: recentErrors,
  };
}

function updateSqliteAgentFields(agentId: string, fields: Record<string, unknown>): void {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  const db = getDb();
  const assignments = entries.map(([field]) => `${field} = ?`).join(", ");
  db.prepare(`UPDATE agents SET ${assignments} WHERE id = ?`).run(
    ...entries.map(([, value]) => value),
    agentId
  );
}

async function updatePgAgentFields(agentId: string, fields: Record<string, unknown>): Promise<void> {
  if (!isPgEnabled()) return;

  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  const assignments = entries.map(([field], idx) => `${field} = $${idx + 1}`).join(", ");
  await pgExec(
    `UPDATE agents SET ${assignments} WHERE id = $${entries.length + 1}`,
    [...entries.map(([, value]) => value), agentId]
  );
}

async function syncAgentFields(agentId: string, fields: Record<string, unknown>): Promise<void> {
  if (isPgEnabled()) {
    await updatePgAgentFields(agentId, fields);
  }
  updateSqliteAgentFields(agentId, fields);
}

async function loadActiveApiKey(agentId: string): Promise<{ id: string; last_used_at: number | null } | null> {
  if (isPgEnabled()) {
    return await pgQueryOne<{ id: string; last_used_at: number | null }>(
      `SELECT id, last_used_at
       FROM api_keys
       WHERE agent_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [agentId]
    );
  }

  const db = getDb();
  const apiKey = db.prepare(
    `SELECT id, last_used_at
     FROM api_keys
     WHERE agent_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(agentId) as { id: string; last_used_at: number | null } | undefined;
  return apiKey ?? null;
}

// ── Derive risk config from agent factory attributes ──────────

function deriveRiskConfig(attrs: {
  personality?: string;
  protectionMindset?: string;
  moneyApproach?: string;
}): { drawdownLimit: number; maxPositionSize: number; kellyMultiplier: number } {
  // ── Drawdown limit: protection_mindset is primary driver
  const ddMap: Record<string, number> = { tight: 0.08, flexible: 0.15, hands_off: 0.30 };
  let drawdownLimit = ddMap[attrs.protectionMindset ?? "flexible"] ?? 0.15;

  // Personality modifier
  if (attrs.personality === "guardian") drawdownLimit = Math.max(0.05, drawdownLimit - 0.03);
  if (attrs.personality === "adventurer") drawdownLimit = Math.min(0.40, drawdownLimit + 0.05);

  // ── Max position size: money_approach is primary driver
  const posMap: Record<string, number> = { fixed_safe: 0.05, smart_scaling: 0.10, aggressive: 0.20 };
  const maxPositionSize = posMap[attrs.moneyApproach ?? "smart_scaling"] ?? 0.10;

  // ── Kelly multiplier: based on personality
  const kellyBase: Record<string, number> = { guardian: 0.15, balanced: 0.25, adventurer: 0.50 };
  const kellyMultiplier = kellyBase[attrs.personality ?? "balanced"] ?? 0.25;

  return {
    drawdownLimit: Math.round(drawdownLimit * 1000) / 1000,
    maxPositionSize: Math.round(maxPositionSize * 1000) / 1000,
    kellyMultiplier: Math.round(kellyMultiplier * 100) / 100,
  };
}

function applyDerivedRiskConfig(
  db: ReturnType<typeof getDb>,
  config: { drawdownLimit: number; maxPositionSize: number; kellyMultiplier: number }
): void {
  // Update the active global circuit breaker with derived values
  db.prepare(`
    UPDATE global_circuit_breakers
    SET drawdown_limit_pct = ?, max_position_size_pct = ?, kelly_fraction_multiplier = ?, updated_at = ?
    WHERE risk_configuration_id = (
      SELECT id FROM risk_configurations WHERE is_active = 1 LIMIT 1
    )
  `).run(config.drawdownLimit, config.maxPositionSize, config.kellyMultiplier, Date.now());
}

async function applyDerivedRiskConfigPg(
  config: { drawdownLimit: number; maxPositionSize: number; kellyMultiplier: number }
): Promise<void> {
  await pgExec(`
    UPDATE global_circuit_breakers
    SET drawdown_limit_pct = $1, max_position_size_pct = $2, kelly_fraction_multiplier = $3, updated_at = $4
    WHERE risk_configuration_id = (
      SELECT id FROM risk_configurations WHERE is_active = 1 LIMIT 1
    )
  `, [config.drawdownLimit, config.maxPositionSize, config.kellyMultiplier, Date.now()]);
}

// ── POST /api/v1/agents — Create agent ───────────────────────

router.post("/agents", async (req: Request, res: Response) => {
  const body = req.body as AgentCreateBody;
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    await terminateExistingAgents(userId);
  } catch (err) {
    console.error("[agents] auto-replace error:", err);
    res.status(500).json({ error: "Failed to replace existing agent" });
    return;
  }

  // Wallet handling: frontend generates wallet via /api/wallet/generate,
  // user downloads the private key, then passes address + key here.
  // Backend encrypts the key for server-side Polymarket approvals.
  // Fallback: if no wallet_address provided, generate server-side.
  let walletAddress: string;
  let encryptedPrivateKey: string;
  let encryptedSeedPhrase: string;

  if (body.wallet_address && EVM_ADDRESS_RE.test(body.wallet_address)) {
    walletAddress = body.wallet_address;
    // If frontend also sent the private key, encrypt+store it for automated approvals
    encryptedPrivateKey = body.private_key ? encrypt(body.private_key) : "";
    encryptedSeedPhrase = body.seed_phrase ? encrypt(body.seed_phrase) : "";
    // Clear from request body immediately
    body.private_key = undefined;
    body.seed_phrase = undefined;
  } else {
    // Fallback: generate wallet server-side (no key returned to user)
    try {
      const wallet = await generateWalletCredentials();
      walletAddress = wallet.address;
      encryptedPrivateKey = encrypt(wallet.privateKey);
      encryptedSeedPhrase = encrypt(wallet.seedPhrase);
      wallet.privateKey = "";
      wallet.seedPhrase = "";
    } catch (walletErr) {
      console.error("[agents] wallet generation error:", walletErr instanceof Error ? walletErr.message : walletErr);
      res.status(500).json({ error: "Failed to generate wallet" });
      return;
    }
  }

  const id = uuidv4();
  const agentCode = generateAgentCode();
  const now = Date.now();
  const systemPrompt = buildSystemPrompt(body, agentCode);

  const agentParams = [
    id, agentCode,
    body.name.trim(),
    body.avatar ?? "🦊",
    body.animalType ?? null,
    body.generatedImage ?? null,
    body.personality ?? "balanced",
    body.decisionStyle ?? "analyst",
    body.tradingInstinct ?? "reversal_spotter",
    body.timePatience ?? "swing",
    body.profitDream ?? "wealth_builder",
    body.moneyApproach ?? "smart_scaling",
    body.protectionMindset ?? "flexible",
    "none",
    body.marketSense ?? "fixed_rules",
    body.assetLove ?? "crypto",
    systemPrompt,
    walletAddress,
    encryptedPrivateKey || null,
    encryptedSeedPhrase || null,
    now, now,
  ];

  try {
    if (isPgEnabled()) {
      await pgExec(`
        INSERT INTO agents (
          id, agent_code, status, name, avatar_emoji, animal_type, avatar_image,
          personality, decision_style, trading_instinct, time_patience, profit_dream,
          money_approach, protection_mindset, leverage_vibe, market_sense, asset_love,
          system_prompt, wallet_address, encrypted_private_key, encrypted_seed_phrase,
          polymarket_ready, polymarket_status, user_id, created_at, updated_at
        ) VALUES ($1, $2, 'inactive', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 0, 'pending_funding', $21, $22, $23)
      `, [...agentParams.slice(0, 20), userId, ...agentParams.slice(20)]);

      if (userId) {
        await pgExec("UPDATE users SET agent_id = $1 WHERE id = $2", [id, userId]);
      }

      // Derive and apply risk config from agent personality
      const derivedRisk = deriveRiskConfig(body);
      await applyDerivedRiskConfigPg(derivedRisk);
    } else {
      const db = getDb();
      db.prepare(`
        INSERT INTO agents (
          id, agent_code, status, name, avatar_emoji, animal_type, avatar_image,
          personality, decision_style, trading_instinct, time_patience, profit_dream,
          money_approach, protection_mindset, leverage_vibe, market_sense, asset_love,
          system_prompt, wallet_address, encrypted_private_key, encrypted_seed_phrase,
          polymarket_ready, polymarket_status, user_id, created_at, updated_at
        ) VALUES (?, ?, 'inactive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending_funding', ?, ?, ?)
      `).run(...agentParams.slice(0, 20), userId, ...agentParams.slice(20));

      if (userId) {
        db.prepare("UPDATE users SET agent_id = ? WHERE id = ?").run(id, userId);
      }

      // Derive and apply risk config from agent personality
      const derivedRisk = deriveRiskConfig(body);
      applyDerivedRiskConfig(db, derivedRisk);
    }

    res.status(201).json({
      id,
      agent_code: agentCode,
      status: "inactive",
      name: body.name.trim(),
      avatar_emoji: body.avatar ?? "🦊",
      animal_type: body.animalType ?? null,
      avatar_image: body.generatedImage ?? null,
      personality: body.personality ?? "balanced",
      decision_style: body.decisionStyle ?? "analyst",
      trading_instinct: body.tradingInstinct ?? "reversal_spotter",
      time_patience: body.timePatience ?? "swing",
      profit_dream: body.profitDream ?? "wealth_builder",
      money_approach: body.moneyApproach ?? "smart_scaling",
      protection_mindset: body.protectionMindset ?? "flexible",
      leverage_vibe: "none",
      market_sense: body.marketSense ?? "fixed_rules",
      asset_love: body.assetLove ?? "crypto",
      wallet_address: walletAddress,
      polymarket_ready: false,
      polymarket_status: "pending_funding",
      funding_instructions: {
        address: walletAddress,
        network: "Polygon (Mainnet)",
        required: {
          pol: ">0.01 POL (gas fees)",
          usdc: ">$1 USDC.e (trading)",
        },
        usdc_contract: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        note: "Fund this address, then click Verify Readiness.",
      },
      created_at: now,
      updated_at: now,
      deployed_at: null,
    });
  } catch (err) {
    console.error("[agents] create error:", err);
    res.status(500).json({ error: "Failed to create agent" });
  }
});

// ── POST /api/v1/agents/:id/verify-polymarket — Run Polymarket approvals ─────
// Decrypts the agent's stored private key, checks funding, runs CLI approvals,
// and marks the agent as Polymarket-ready. Rate-limited to 3 calls/min/user.

const polymarketVerifyLimit = rateLimit({
  windowMs: 60_000,
  max: 3,
  keyPrefix: "polymarket-verify",
});

router.post("/agents/:id/verify-polymarket", polymarketVerifyLimit, async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const result = await verifyAndPreparePolymarket(agentId, userId);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg === "Agent not found") {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    console.error("[polymarket-verify] error:", msg);
    res.status(500).json({ error: "Polymarket verification failed. Try again." });
  }
});

// ── POST /api/v1/agents/byo — Legacy path removed in favor of onboarding ────

router.post("/agents/byo", (_req: Request, res: Response) => {
  res.status(410).json({
    error: "BYO_LEGACY_DEPRECATED",
    message: "Use /api/v1/agents/byo/onboarding and complete the claim flow instead.",
  });
});

// ── POST /api/v1/agents/:id/health-check — Verify connection ─

router.post("/agents/:id/health-check", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;
  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const agent = await loadOwnedAgent(agentId, userId);

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  if (agent.agent_type !== "byo") {
    res.status(400).json({ error: "Health check is only available for BYO agents" });
    return;
  }

  const apiKey = await loadActiveApiKey(agent.id);

  const now = Date.now();
  let status: string;

  if (!apiKey) {
    status = "error";
  } else if (agent.last_heartbeat && (now - agent.last_heartbeat) < 10 * 60 * 1000) {
    status = "connected";
  } else if (apiKey.last_used_at && (now - apiKey.last_used_at) < 30 * 60 * 1000) {
    status = "connected";
  } else {
    status = "pending";
  }

  await syncAgentFields(agent.id, { connection_status: status, updated_at: now });

  res.json({
    ok: true,
    connection_status: status,
    has_api_key: !!apiKey,
    last_heartbeat: agent.last_heartbeat,
    last_api_key_used: apiKey?.last_used_at ?? null,
  });
});

// ── GET /api/v1/agent/me — Get authenticated user's agent ────

router.get("/agent/me", async (req: Request, res: Response) => {
  const AGENT_COLS = `id, agent_code, status, name, avatar_emoji, animal_type, avatar_image,
    personality, decision_style, trading_instinct, time_patience, profit_dream,
    money_approach, protection_mindset, leverage_vibe, market_sense, asset_love,
    wallet_address, created_at, updated_at, deployed_at,
    agent_type, endpoint_url, agent_url, connection_status, last_heartbeat, description, webhook_events,
    autopilot_enabled, autopilot_updated_at`;

  if (isPgEnabled()) {
    const userId = await getUserIdAsync(req);
    if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }

    const user = await pgQueryOne<{ agent_id: string | null }>("SELECT agent_id FROM users WHERE id = $1", [userId]);
    if (!user?.agent_id) { res.status(404).json({ error: "No agent configured. Create one in Agent Factory." }); return; }

    const agent = await pgQueryOne(`SELECT ${AGENT_COLS} FROM agents WHERE id = $1`, [user.agent_id]);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

    if ((agent as Record<string, unknown>).agent_type === "byo") {
      const apiKey = await pgQueryOne<{ key_prefix: string }>(
        "SELECT key_prefix FROM api_keys WHERE agent_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [user.agent_id]
      );
      (agent as Record<string, unknown>).api_key_prefix = apiKey?.key_prefix ?? null;
      const rawEvents = (agent as Record<string, unknown>).webhook_events;
      if (typeof rawEvents === "string") {
        try {
          (agent as Record<string, unknown>).webhook_events = JSON.parse(rawEvents);
        } catch {
          (agent as Record<string, unknown>).webhook_events = ["*"];
        }
      }
    }

    (agent as Record<string, unknown>).autopilot_enabled = normalizeAutopilotEnabled(
      (agent as Record<string, unknown>).autopilot_enabled as number | boolean | null | undefined
    );

    res.json(agent);
  } else {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }

    const db = getDb();
    const user = db.prepare("SELECT agent_id FROM users WHERE id = ?").get(userId) as { agent_id: string | null } | undefined;
    if (!user?.agent_id) { res.status(404).json({ error: "No agent configured. Create one in Agent Factory." }); return; }

    const agent = db.prepare(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?`).get(user.agent_id) as Record<string, unknown> | undefined;
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

    // Include API key prefix for BYO agents
    if (agent.agent_type === "byo") {
      const apiKey = db.prepare(
        `SELECT key_prefix FROM api_keys WHERE agent_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`
      ).get(user.agent_id) as { key_prefix: string } | undefined;
      (agent as Record<string, unknown>).api_key_prefix = apiKey?.key_prefix ?? null;
      const rawEvents = (agent as Record<string, unknown>).webhook_events;
      if (typeof rawEvents === "string") {
        try {
          (agent as Record<string, unknown>).webhook_events = JSON.parse(rawEvents);
        } catch {
          (agent as Record<string, unknown>).webhook_events = ["*"];
        }
      }
    }

    (agent as Record<string, unknown>).autopilot_enabled = normalizeAutopilotEnabled(
      (agent as Record<string, unknown>).autopilot_enabled as number | boolean | null | undefined
    );

    res.json(agent);
  }
});

// ── GET /api/v1/agents — List agents ─────────────────────────

router.get("/agents", (_req: Request, res: Response) => {
  const db = getDb();
  const agents = db.prepare(`
    SELECT id, agent_code, status, name, avatar_emoji, animal_type, avatar_image,
           personality, decision_style, trading_instinct, time_patience, profit_dream,
           money_approach, protection_mindset, leverage_vibe, market_sense, asset_love,
           wallet_address, created_at, updated_at, deployed_at, agent_type, endpoint_url, agent_url,
           connection_status, last_heartbeat, description, webhook_events,
           autopilot_enabled, autopilot_updated_at
    FROM agents ORDER BY created_at DESC
  `).all();

  res.json({
    agents: (agents as Array<Record<string, unknown>>).map((agent) => ({
      ...agent,
      autopilot_enabled: normalizeAutopilotEnabled(agent.autopilot_enabled as number | boolean | null | undefined),
      webhook_events: typeof agent.webhook_events === "string"
        ? (() => {
            try {
              return JSON.parse(agent.webhook_events);
            } catch {
              return ["*"];
            }
          })()
        : agent.webhook_events,
    })),
  });
});

// ── GET /api/v1/agents/:id — Get agent detail ────────────────

router.get("/agents/:id", (req: Request, res: Response) => {
  const db = getDb();
  const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(req.params.id);

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json(agent);
});

// ── PATCH /api/v1/agents/:id — Update agent config ──────────

router.patch("/agents/:id", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;

  if (!existing) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const body = req.body as Partial<AgentCreateBody>;
  const merged: Omit<AgentCreateBody, "wallet_address"> = {
    name: (body.name ?? existing.name) as string,
    avatar: (body.avatar ?? existing.avatar_emoji) as string,
    animalType: (body.animalType ?? existing.animal_type) as string,
    generatedImage: (body.generatedImage ?? existing.avatar_image) as string | null,
    personality: (body.personality ?? existing.personality) as string,
    decisionStyle: (body.decisionStyle ?? existing.decision_style) as string,
    tradingInstinct: (body.tradingInstinct ?? existing.trading_instinct) as string,
    timePatience: (body.timePatience ?? existing.time_patience) as string,
    profitDream: (body.profitDream ?? existing.profit_dream) as string,
    moneyApproach: (body.moneyApproach ?? existing.money_approach) as string,
    protectionMindset: (body.protectionMindset ?? existing.protection_mindset) as string,
    marketSense: (body.marketSense ?? existing.market_sense) as string,
    assetLove: (body.assetLove ?? existing.asset_love) as string,
  };

  const agentCode = existing.agent_code as string;
  const systemPrompt = buildSystemPrompt(merged, agentCode);
  const now = Date.now();

  db.prepare(`
    UPDATE agents SET
      name = ?, avatar_emoji = ?, animal_type = ?, avatar_image = ?,
      personality = ?, decision_style = ?, trading_instinct = ?, time_patience = ?,
      profit_dream = ?, money_approach = ?, protection_mindset = ?, leverage_vibe = ?,
      market_sense = ?, asset_love = ?, system_prompt = ?, updated_at = ?
    WHERE id = ?
  `).run(
    merged.name, merged.avatar, merged.animalType ?? null, merged.generatedImage ?? null,
    merged.personality, merged.decisionStyle, merged.tradingInstinct, merged.timePatience,
    merged.profitDream, merged.moneyApproach, merged.protectionMindset, "none",
    merged.marketSense, merged.assetLove, systemPrompt, now,
    req.params.id
  );

  res.json({ ok: true, system_prompt: systemPrompt });
});

// ── POST /api/v1/agents/:id/deploy — Activate agent ─────────

router.post("/agents/:id/deploy", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;
  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const agent = await loadOwnedAgent(agentId, userId);

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const now = Date.now();
  await syncAgentFields(agentId, {
    status: "active",
    deployed_at: now,
    updated_at: now,
  });

  res.json({ ok: true, status: "active", deployed_at: now });
});

// ── PATCH /api/v1/agents/:id/autopilot — Persist autopilot state ──

router.patch("/agents/:id/autopilot", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;
  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const agent = await loadOwnedAgentContext(agentId, userId);

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const body = req.body as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }

  const now = Date.now();
  if (body.enabled) {
    const funding = await getWalletFundingSnapshot(agent.wallet_address);
    if (!funding.ready) {
      res.status(409).json({
        error: "AUTOPILOT_FUNDING_REQUIRED",
        message: funding.fundingMessage,
        wallet_address: funding.address,
        pol: funding.pol,
        on_chain_usdc: funding.onChainUsdc,
        funding_status: funding.fundingStatus,
        funding_message: funding.fundingMessage,
      });
      return;
    }
  }

  await syncAgentFields(agentId, {
    autopilot_enabled: body.enabled ? 1 : 0,
    autopilot_updated_at: now,
    updated_at: now,
  });

  res.json({
    ok: true,
    agent_id: agentId,
    autopilot_enabled: body.enabled,
    autopilot_updated_at: now,
  });
});

// ── POST /api/v1/agents/:id/pause — Pause agent ─────────────

router.post("/agents/:id/pause", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;
  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const now = Date.now();
  await syncAgentFields(agentId, { status: "paused", updated_at: now });

  res.json({ ok: true, status: "paused" });
});

// ── POST /api/v1/agents/:id/terminate — Terminate agent ─────

router.post("/agents/:id/terminate", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;
  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const now = Date.now();
  await syncAgentFields(agentId, { status: "terminated", updated_at: now });

  res.json({ ok: true, status: "terminated" });
});

// ── GET /api/v1/agents/:id/health-score — Agent health score ──

router.get("/agents/:id/health-score", requireEitherAuth, async (req: Request, res: Response) => {
  const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const owner = await loadOwnedAgent(targetId, req.apiKeyAgent!.userId);
  if (!owner || owner.agent_type !== "byo") {
    res.status(404).json({ error: "BYO agent not found" });
    return;
  }

  const score = await computeHealthScore(targetId);
  if (!score) {
    res.status(500).json({ error: "Failed to compute health score" });
    return;
  }

  res.json({ success: true, data: score });
});

// ── GET /api/v1/agents/:id/usage — Owner-facing BYO usage stats ──

router.get("/agents/:id/usage", requireEitherAuth, async (req: Request, res: Response) => {
  const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const owner = await loadOwnedAgent(targetId, req.apiKeyAgent!.userId);
  if (!owner || owner.agent_type !== "byo") {
    res.status(404).json({ error: "BYO agent not found" });
    return;
  }

  const usage = await loadUsageStats(targetId);
  res.json({ success: true, data: usage });
});

// ── GET /api/v1/agents/:id/webhook-log — Webhook delivery log ─

router.get("/agents/:id/webhook-log", requireEitherAuth, async (req: Request, res: Response) => {
  const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const owner = await loadOwnedAgent(targetId, req.apiKeyAgent!.userId);
  if (!owner || owner.agent_type !== "byo") {
    res.status(404).json({ error: "BYO agent not found" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

  if (isPgEnabled()) {
    const entries = await pgQuery(
      `SELECT event, url, status_code, latency_ms, attempt, error, created_at
       FROM webhook_delivery_log
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [targetId, limit]
    );
    res.json({ success: true, data: entries });
    return;
  }

  const db = getDb();
  const entries = db.prepare(
    `SELECT event, url, status_code, latency_ms, attempt, error, created_at
     FROM webhook_delivery_log WHERE agent_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(targetId, limit);

  res.json({ success: true, data: entries });
});

// ── POST /api/v1/agents/:id/webhook-test — Dry-run webhook ───

router.post("/agents/:id/webhook-test", requireEitherAuth, async (req: Request, res: Response) => {
  const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const agent = await loadOwnedAgentContext(targetId, req.apiKeyAgent!.userId);

  if (!agent || agent.agent_type !== "byo") {
    res.status(404).json({ error: "BYO agent not found" });
    return;
  }

  if (!agent.endpoint_url) {
    res.status(400).json({ error: "No webhook URL configured" });
    return;
  }

  const testPayload = JSON.stringify({
    event: "webhook:test",
    data: { message: "This is a test webhook from Quantik", timestamp: Date.now() },
    timestamp: Date.now(),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Quantik-Event": "webhook:test",
    "X-Quantik-Agent": agent.id,
    "X-Quantik-Timestamp": String(Date.now()),
  };

  if (agent.webhook_secret) {
    const hmac = crypto.createHmac("sha256", agent.webhook_secret).update(testPayload).digest("hex");
    headers["X-Quantik-Signature"] = `sha256=${hmac}`;
  }

  const start = Date.now();
  try {
    const webhookRes = await fetch(agent.endpoint_url, {
      method: "POST",
      headers,
      body: testPayload,
      signal: AbortSignal.timeout(10000),
    });
    const latency = Date.now() - start;

    res.json({
      success: true,
      data: {
        status_code: webhookRes.status,
        latency_ms: latency,
        ok: webhookRes.ok,
      },
    });
  } catch (err) {
    const latency = Date.now() - start;
    res.json({
      success: false,
      data: {
        status_code: null,
        latency_ms: latency,
        error: err instanceof Error ? err.message : "Webhook delivery failed",
        ok: false,
      },
    });
  }
});

// ── GET /api/v1/agents/:id/activity — Recent API activity log ─

router.get("/agents/:id/activity", requireEitherAuth, async (req: Request, res: Response) => {
  const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const owner = await loadOwnedAgent(targetId, req.apiKeyAgent!.userId);
  if (!owner) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  if (isPgEnabled()) {
    const entries = await pgQuery(
      `SELECT tool_name, method, status_code, latency_ms, created_at
       FROM byo_request_log
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [targetId, limit, offset]
    );
    const total = await pgQueryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM byo_request_log WHERE agent_id = $1",
      [targetId]
    );
    const count = total?.count ?? 0;
    res.json({ success: true, data: entries, total: count, hasMore: offset + limit < count });
    return;
  }

  const db = getDb();
  const entries = db.prepare(
    `SELECT tool_name, method, status_code, latency_ms, created_at
     FROM byo_request_log WHERE agent_id = ?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(targetId, limit, offset);

  const total = db.prepare(
    "SELECT COUNT(*) as count FROM byo_request_log WHERE agent_id = ?"
  ).get(targetId) as { count: number };

  res.json({ success: true, data: entries, total: total.count, hasMore: offset + limit < total.count });
});

// ── DELETE /api/v1/agents/:id — Delete agent permanently ─────

router.delete("/agents/:id", async (req: Request, res: Response) => {
  try {
    if (isPgEnabled()) {
      const userId = await getUserIdAsync(req);
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const agent = await pgQueryOne<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM agents WHERE id = $1`,
        [req.params.id]
      );
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (agent.user_id !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      await pgExec(`DELETE FROM webhook_delivery_log WHERE agent_id = $1`, [req.params.id]);
      await pgExec(`DELETE FROM byo_request_log WHERE agent_id = $1`, [req.params.id]);
      await pgExec(`DELETE FROM api_keys WHERE agent_id = $1`, [req.params.id]);
      await pgExec(`DELETE FROM agents WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
      await pgExec(`UPDATE users SET agent_id = NULL WHERE id = $1`, [userId]);

      const db = getDb();
      db.prepare(`DELETE FROM webhook_delivery_log WHERE agent_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM byo_request_log WHERE agent_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM api_keys WHERE agent_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM agents WHERE id = ?`).run(req.params.id);
      db.prepare(`UPDATE users SET agent_id = NULL WHERE id = ?`).run(userId);
    } else {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const db = getDb();
      const agent = db.prepare(`SELECT id, user_id FROM agents WHERE id = ?`).get(req.params.id) as
        | { id: string; user_id: string }
        | undefined;
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (agent.user_id !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      db.prepare(`DELETE FROM webhook_delivery_log WHERE agent_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM byo_request_log WHERE agent_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM api_keys WHERE agent_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM agents WHERE id = ? AND user_id = ?`).run(req.params.id, userId);
      db.prepare(`UPDATE users SET agent_id = NULL WHERE id = ?`).run(userId);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[agents] delete error:", err);
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

export default router;
