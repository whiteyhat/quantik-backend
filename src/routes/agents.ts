import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { getUserId, getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne, pgQuery, pgExec } from "../db/postgres";

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

const LEVERAGE: Record<string, string> = {
  none: "NEVER use leverage. Trade spot only at 1x. Capital preservation through no borrowed funds.",
  moderate: "Use 2x-5x leverage on high-conviction setups only. Always account for liquidation price in position sizing.",
  full_throttle: "Use high leverage to maximize capital efficiency. Manage risk through position sizing and stops, not leverage limits.",
};

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

## Leverage Policy
${LEVERAGE[config.leverageVibe] ?? ""}

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
  wallet_address: string;
  personality: string;
  decisionStyle: string;
  tradingInstinct: string;
  timePatience: string;
  profitDream: string;
  moneyApproach: string;
  protectionMindset: string;
  leverageVibe: string;
  marketSense: string;
  assetLove: string;
}

function generateAgentCode(): string {
  const num = Math.floor(Math.random() * 900 + 100);
  return `Q-AGENT-X${num}`;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ── POST /api/v1/agents — Create agent ───────────────────────

router.post("/agents", async (req: Request, res: Response) => {
  const body = req.body as AgentCreateBody;

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  if (!body.wallet_address || !EVM_ADDRESS_RE.test(body.wallet_address)) {
    res.status(400).json({ error: "wallet_address must be a valid EVM address (0x + 40 hex chars)" });
    return;
  }

  const id = uuidv4();
  const agentCode = generateAgentCode();
  const walletAddress = body.wallet_address;
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
    body.leverageVibe ?? "moderate",
    body.marketSense ?? "fixed_rules",
    body.assetLove ?? "crypto",
    systemPrompt,
    walletAddress,
    now, now,
  ];

  try {
    if (isPgEnabled()) {
      const userId = await getUserIdAsync(req);
      await pgExec(`
        INSERT INTO agents (
          id, agent_code, status, name, avatar_emoji, animal_type, avatar_image,
          personality, decision_style, trading_instinct, time_patience, profit_dream,
          money_approach, protection_mindset, leverage_vibe, market_sense, asset_love,
          system_prompt, wallet_address, user_id, created_at, updated_at
        ) VALUES ($1, $2, 'inactive', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      `, [...agentParams.slice(0, 18), userId, ...agentParams.slice(18)]);

      if (userId) {
        await pgExec("UPDATE users SET agent_id = $1 WHERE id = $2", [id, userId]);
      }
    } else {
      const userId = getUserId(req);
      const db = getDb();
      db.prepare(`
        INSERT INTO agents (
          id, agent_code, status, name, avatar_emoji, animal_type, avatar_image,
          personality, decision_style, trading_instinct, time_patience, profit_dream,
          money_approach, protection_mindset, leverage_vibe, market_sense, asset_love,
          system_prompt, wallet_address, user_id, created_at, updated_at
        ) VALUES (?, ?, 'inactive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...agentParams.slice(0, 18), userId, ...agentParams.slice(18));

      if (userId) {
        db.prepare("UPDATE users SET agent_id = ? WHERE id = ?").run(id, userId);
      }
    }

    res.status(201).json({
      id,
      agent_code: agentCode,
      wallet_address: walletAddress,
      status: "inactive",
      system_prompt: systemPrompt,
    });
  } catch (err) {
    console.error("[agents] create error:", err);
    res.status(500).json({ error: "Failed to create agent" });
  }
});

// ── GET /api/v1/agent/me — Get authenticated user's agent ────

router.get("/agent/me", async (req: Request, res: Response) => {
  const AGENT_COLS = `id, agent_code, status, name, avatar_emoji, animal_type, avatar_image,
    personality, decision_style, trading_instinct, time_patience, profit_dream,
    money_approach, protection_mindset, leverage_vibe, market_sense, asset_love,
    wallet_address, created_at, updated_at, deployed_at`;

  if (isPgEnabled()) {
    const userId = await getUserIdAsync(req);
    if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }

    const user = await pgQueryOne<{ agent_id: string | null }>("SELECT agent_id FROM users WHERE id = $1", [userId]);
    if (!user?.agent_id) { res.status(404).json({ error: "No agent configured. Create one in Agent Factory." }); return; }

    const agent = await pgQueryOne(`SELECT ${AGENT_COLS} FROM agents WHERE id = $1`, [user.agent_id]);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    res.json(agent);
  } else {
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }

    const db = getDb();
    const user = db.prepare("SELECT agent_id FROM users WHERE id = ?").get(userId) as { agent_id: string | null } | undefined;
    if (!user?.agent_id) { res.status(404).json({ error: "No agent configured. Create one in Agent Factory." }); return; }

    const agent = db.prepare(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?`).get(user.agent_id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
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
           wallet_address, created_at, updated_at, deployed_at
    FROM agents ORDER BY created_at DESC
  `).all();

  res.json({ agents });
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
    leverageVibe: (body.leverageVibe ?? existing.leverage_vibe) as string,
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
    merged.profitDream, merged.moneyApproach, merged.protectionMindset, merged.leverageVibe,
    merged.marketSense, merged.assetLove, systemPrompt, now,
    req.params.id
  );

  res.json({ ok: true, system_prompt: systemPrompt });
});

// ── POST /api/v1/agents/:id/deploy — Activate agent ─────────

router.post("/agents/:id/deploy", (req: Request, res: Response) => {
  const db = getDb();
  const agent = db.prepare(`SELECT id, status FROM agents WHERE id = ?`).get(req.params.id) as { id: string; status: string } | undefined;

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const now = Date.now();
  db.prepare(`UPDATE agents SET status = 'active', deployed_at = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, req.params.id);

  res.json({ ok: true, status: "active", deployed_at: now });
});

// ── POST /api/v1/agents/:id/pause — Pause agent ─────────────

router.post("/agents/:id/pause", (req: Request, res: Response) => {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(`UPDATE agents SET status = 'paused', updated_at = ? WHERE id = ?`)
    .run(now, req.params.id);

  if (result.changes === 0) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json({ ok: true, status: "paused" });
});

// ── POST /api/v1/agents/:id/terminate — Terminate agent ─────

router.post("/agents/:id/terminate", (req: Request, res: Response) => {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(`UPDATE agents SET status = 'terminated', updated_at = ? WHERE id = ?`)
    .run(now, req.params.id);

  if (result.changes === 0) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json({ ok: true, status: "terminated" });
});

export default router;
