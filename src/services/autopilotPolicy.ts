import { getDb } from "../db/schema";
import { isPgEnabled, pgExec, pgQueryOne, pgQuery } from "../db/postgres";
import { v4 as uuid } from "uuid";

export interface AutopilotTraitInput {
  agentId?: string;
  personality?: string | null;
  decision_style?: string | null;
  trading_instinct?: string | null;
  time_patience?: string | null;
  money_approach?: string | null;
  protection_mindset?: string | null;
  market_sense?: string | null;
}

export interface AutopilotPolicyOverrides {
  cadenceMinutes: number | null;
  cooldownMinutes: number | null;
  maxTradesPerDay: number | null;
  maxBetUsdc: number | null;
  updatedAt: number | null;
}

export interface AutopilotPolicyEffective {
  cadenceMinutes: number;
  cooldownMinutes: number;
  maxTradesPerDay: number;
  maxBetUsdc: number;
  minSigma: number;
  minKelly: number;
  kellyMultiplier: number;
  maxPositionFraction: number;
  dailyLossLimitPct: number;
  useAuraSentiment: boolean;
}

export interface AutopilotPolicyEnvelope {
  derived: AutopilotPolicyEffective;
  overrides: AutopilotPolicyOverrides;
  effective: AutopilotPolicyEffective;
}

export interface AutopilotDecisionInput {
  agentId: string;
  userId: string | null;
  slug: string;
  direction: "YES" | "NO";
  decision: "executed" | "skipped" | "failed";
  reasonCode: string;
  sizeUsdc: number | null;
  scannedAt: number;
  policySnapshot: AutopilotPolicyEnvelope;
  signalSnapshot: unknown;
  error?: string | null;
}

export interface AutopilotDecisionRecord {
  id: string;
  agent_id: string;
  user_id: string | null;
  slug: string;
  direction: "YES" | "NO";
  decision: "executed" | "skipped" | "failed";
  reason_code: string;
  size_usdc: number | null;
  scanned_at: number;
  policy_snapshot: AutopilotPolicyEnvelope;
  signal_snapshot: unknown;
  error: string | null;
}

interface AutopilotPolicyRow {
  cadence_minutes: number | null;
  cooldown_minutes: number | null;
  max_trades_per_day: number | null;
  max_bet_usdc: number | null;
  updated_at: number | null;
}

function sanitizeOptionalInteger(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.round(parsed));
}

function sanitizeOptionalMoney(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.round(parsed * 100) / 100);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundMinutes(value: number, floor: number): number {
  return Math.max(floor, Math.round(value));
}

function normalizeOverrides(row: AutopilotPolicyRow | null): AutopilotPolicyOverrides {
  if (!row) {
    return {
      cadenceMinutes: null,
      cooldownMinutes: null,
      maxTradesPerDay: null,
      maxBetUsdc: null,
      updatedAt: null,
    };
  }

  return {
    cadenceMinutes: sanitizeOptionalInteger(row.cadence_minutes),
    cooldownMinutes: sanitizeOptionalInteger(row.cooldown_minutes),
    maxTradesPerDay: sanitizeOptionalInteger(row.max_trades_per_day),
    maxBetUsdc: sanitizeOptionalMoney(row.max_bet_usdc),
    updatedAt: row.updated_at == null ? null : Number(row.updated_at),
  };
}

export function deriveAutopilotPolicy(attrs: AutopilotTraitInput): AutopilotPolicyEffective {
  const timeBase = {
    lightning: { cadence: 15, cooldown: 60, tradesPerDay: 12 },
    swing: { cadence: 60, cooldown: 360, tradesPerDay: 6 },
    longterm: { cadence: 240, cooldown: 1440, tradesPerDay: 2 },
  } as const;

  const instinctAdjustments = {
    speed_demon: { cadenceMultiplier: 0.5, cooldownMultiplier: 0.5, tradesDelta: 4 },
    trend_chaser: { cadenceMultiplier: 0.75, cooldownMultiplier: 0.75, tradesDelta: 2 },
    reversal_spotter: { cadenceMultiplier: 1.0, cooldownMultiplier: 1.0, tradesDelta: 0 },
    value_hunter: { cadenceMultiplier: 1.5, cooldownMultiplier: 1.25, tradesDelta: -1 },
  } as const;

  const sigmaFloors = {
    gut: 0.60,
    analyst: 0.72,
    observer: 0.82,
  } as const;

  const personalityProfile = {
    guardian: { minKelly: 0.04, kellyMultiplier: 0.15 },
    balanced: { minKelly: 0.03, kellyMultiplier: 0.25 },
    adventurer: { minKelly: 0.02, kellyMultiplier: 0.50 },
  } as const;

  const positionFractions = {
    fixed_safe: 0.03,
    smart_scaling: 0.08,
    aggressive: 0.15,
  } as const;

  const maxBetDefaults = {
    fixed_safe: 10,
    smart_scaling: 25,
    aggressive: 50,
  } as const;

  const dailyLossLimits = {
    tight: 0.05,
    flexible: 0.08,
    hands_off: 0.12,
  } as const;

  const time = timeBase[attrs.time_patience as keyof typeof timeBase] ?? timeBase.swing;
  const instinct = instinctAdjustments[attrs.trading_instinct as keyof typeof instinctAdjustments] ?? instinctAdjustments.reversal_spotter;
  const personality = personalityProfile[attrs.personality as keyof typeof personalityProfile] ?? personalityProfile.balanced;
  const moneyApproach = attrs.money_approach as keyof typeof positionFractions;
  const protectionMindset = attrs.protection_mindset as keyof typeof dailyLossLimits;

  const cadenceMinutes = roundMinutes(time.cadence * instinct.cadenceMultiplier, 5);
  const cooldownMinutes = Math.max(
    cadenceMinutes,
    roundMinutes(time.cooldown * instinct.cooldownMultiplier, 15)
  );
  const maxTradesPerDay = Math.max(1, time.tradesPerDay + instinct.tradesDelta);

  return {
    cadenceMinutes,
    cooldownMinutes,
    maxTradesPerDay,
    maxBetUsdc: maxBetDefaults[moneyApproach] ?? maxBetDefaults.smart_scaling,
    minSigma: sigmaFloors[attrs.decision_style as keyof typeof sigmaFloors] ?? sigmaFloors.analyst,
    minKelly: personality.minKelly,
    kellyMultiplier: personality.kellyMultiplier,
    maxPositionFraction: positionFractions[moneyApproach] ?? positionFractions.smart_scaling,
    dailyLossLimitPct: dailyLossLimits[protectionMindset] ?? dailyLossLimits.flexible,
    useAuraSentiment: attrs.market_sense === "mood_reader",
  };
}

export function buildAutopilotPolicyEnvelope(
  attrs: AutopilotTraitInput,
  overrides: AutopilotPolicyOverrides
): AutopilotPolicyEnvelope {
  const derived = deriveAutopilotPolicy(attrs);
  const effective: AutopilotPolicyEffective = {
    cadenceMinutes: overrides.cadenceMinutes ?? derived.cadenceMinutes,
    cooldownMinutes: overrides.cooldownMinutes ?? derived.cooldownMinutes,
    maxTradesPerDay: overrides.maxTradesPerDay ?? derived.maxTradesPerDay,
    maxBetUsdc: overrides.maxBetUsdc ?? derived.maxBetUsdc,
    minSigma: derived.minSigma,
    minKelly: derived.minKelly,
    kellyMultiplier: derived.kellyMultiplier,
    maxPositionFraction: derived.maxPositionFraction,
    dailyLossLimitPct: derived.dailyLossLimitPct,
    useAuraSentiment: derived.useAuraSentiment,
  };

  return {
    derived: {
      ...derived,
      maxBetUsdc: roundMoney(derived.maxBetUsdc),
      minSigma: roundRatio(derived.minSigma),
      minKelly: roundRatio(derived.minKelly),
      kellyMultiplier: roundRatio(derived.kellyMultiplier),
      maxPositionFraction: roundRatio(derived.maxPositionFraction),
      dailyLossLimitPct: roundRatio(derived.dailyLossLimitPct),
    },
    overrides,
    effective: {
      ...effective,
      maxBetUsdc: roundMoney(effective.maxBetUsdc),
      minSigma: roundRatio(effective.minSigma),
      minKelly: roundRatio(effective.minKelly),
      kellyMultiplier: roundRatio(effective.kellyMultiplier),
      maxPositionFraction: roundRatio(effective.maxPositionFraction),
      dailyLossLimitPct: roundRatio(effective.dailyLossLimitPct),
    },
  };
}

export async function loadAutopilotPolicyOverrides(agentId: string): Promise<AutopilotPolicyOverrides> {
  if (isPgEnabled()) {
    const row = await pgQueryOne<AutopilotPolicyRow>(
      `SELECT cadence_minutes, cooldown_minutes, max_trades_per_day, max_bet_usdc, updated_at
       FROM autopilot_policies
       WHERE agent_id = $1`,
      [agentId]
    );
    return normalizeOverrides(row);
  }

  const db = getDb();
  const row = db.prepare(
    `SELECT cadence_minutes, cooldown_minutes, max_trades_per_day, max_bet_usdc, updated_at
     FROM autopilot_policies
     WHERE agent_id = ?`
  ).get(agentId) as AutopilotPolicyRow | undefined;
  return normalizeOverrides(row ?? null);
}

export async function getAutopilotPolicyEnvelope(attrs: AutopilotTraitInput): Promise<AutopilotPolicyEnvelope> {
  const overrides = attrs.agentId ? await loadAutopilotPolicyOverrides(attrs.agentId) : normalizeOverrides(null);
  return buildAutopilotPolicyEnvelope(attrs, overrides);
}

export async function upsertAutopilotPolicyOverrides(
  agentId: string,
  overrides: Partial<Pick<AutopilotPolicyOverrides, "cadenceMinutes" | "cooldownMinutes" | "maxTradesPerDay" | "maxBetUsdc">>
): Promise<AutopilotPolicyOverrides> {
  const now = Date.now();
  const normalized: AutopilotPolicyOverrides = {
    cadenceMinutes: overrides.cadenceMinutes == null ? null : sanitizeOptionalInteger(overrides.cadenceMinutes),
    cooldownMinutes: overrides.cooldownMinutes == null ? null : sanitizeOptionalInteger(overrides.cooldownMinutes),
    maxTradesPerDay: overrides.maxTradesPerDay == null ? null : sanitizeOptionalInteger(overrides.maxTradesPerDay),
    maxBetUsdc: overrides.maxBetUsdc == null ? null : sanitizeOptionalMoney(overrides.maxBetUsdc),
    updatedAt: now,
  };

  const db = getDb();
  db.prepare(
    `INSERT INTO autopilot_policies (
       agent_id, cadence_minutes, cooldown_minutes, max_trades_per_day, max_bet_usdc, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       cadence_minutes = excluded.cadence_minutes,
       cooldown_minutes = excluded.cooldown_minutes,
       max_trades_per_day = excluded.max_trades_per_day,
       max_bet_usdc = excluded.max_bet_usdc,
       updated_at = excluded.updated_at`
  ).run(
    agentId,
    normalized.cadenceMinutes,
    normalized.cooldownMinutes,
    normalized.maxTradesPerDay,
    normalized.maxBetUsdc,
    normalized.updatedAt
  );

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO autopilot_policies (
         agent_id, cadence_minutes, cooldown_minutes, max_trades_per_day, max_bet_usdc, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id) DO UPDATE SET
         cadence_minutes = EXCLUDED.cadence_minutes,
         cooldown_minutes = EXCLUDED.cooldown_minutes,
         max_trades_per_day = EXCLUDED.max_trades_per_day,
         max_bet_usdc = EXCLUDED.max_bet_usdc,
         updated_at = EXCLUDED.updated_at`,
      [
        agentId,
        normalized.cadenceMinutes,
        normalized.cooldownMinutes,
        normalized.maxTradesPerDay,
        normalized.maxBetUsdc,
        normalized.updatedAt,
      ]
    );
  }

  return normalized;
}

export async function insertAutopilotDecision(input: AutopilotDecisionInput): Promise<void> {
  const id = uuid();
  const policySnapshot = JSON.stringify(input.policySnapshot);
  const signalSnapshot = JSON.stringify(input.signalSnapshot ?? null);

  const db = getDb();
  db.prepare(
    `INSERT INTO autopilot_decisions (
       id, agent_id, user_id, slug, direction, decision, reason_code, size_usdc, scanned_at, policy_snapshot, signal_snapshot, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.agentId,
    input.userId,
    input.slug,
    input.direction,
    input.decision,
    input.reasonCode,
    input.sizeUsdc,
    input.scannedAt,
    policySnapshot,
    signalSnapshot,
    input.error ?? null
  );

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO autopilot_decisions (
         id, agent_id, user_id, slug, direction, decision, reason_code, size_usdc, scanned_at, policy_snapshot, signal_snapshot, error
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        input.agentId,
        input.userId,
        input.slug,
        input.direction,
        input.decision,
        input.reasonCode,
        input.sizeUsdc,
        input.scannedAt,
        policySnapshot,
        signalSnapshot,
        input.error ?? null,
      ]
    );
  }
}

export async function listAutopilotDecisions(agentId: string, limit = 50): Promise<AutopilotDecisionRecord[]> {
  const cappedLimit = Math.max(1, Math.min(200, Math.round(limit)));
  const rows = isPgEnabled()
    ? await pgQuery<{
        id: string;
        agent_id: string;
        user_id: string | null;
        slug: string;
        direction: "YES" | "NO";
        decision: "executed" | "skipped" | "failed";
        reason_code: string;
        size_usdc: number | null;
        scanned_at: number;
        policy_snapshot: string;
        signal_snapshot: string;
        error: string | null;
      }>(
        `SELECT id, agent_id, user_id, slug, direction, decision, reason_code, size_usdc, scanned_at, policy_snapshot, signal_snapshot, error
         FROM autopilot_decisions
         WHERE agent_id = $1
         ORDER BY scanned_at DESC
         LIMIT $2`,
        [agentId, cappedLimit]
      )
    : (getDb().prepare(
        `SELECT id, agent_id, user_id, slug, direction, decision, reason_code, size_usdc, scanned_at, policy_snapshot, signal_snapshot, error
         FROM autopilot_decisions
         WHERE agent_id = ?
         ORDER BY scanned_at DESC
         LIMIT ?`
      ).all(agentId, cappedLimit) as Array<{
        id: string;
        agent_id: string;
        user_id: string | null;
        slug: string;
        direction: "YES" | "NO";
        decision: "executed" | "skipped" | "failed";
        reason_code: string;
        size_usdc: number | null;
        scanned_at: number;
        policy_snapshot: string;
        signal_snapshot: string;
        error: string | null;
      }>);

  return rows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    user_id: row.user_id,
    slug: row.slug,
    direction: row.direction,
    decision: row.decision,
    reason_code: row.reason_code,
    size_usdc: row.size_usdc,
    scanned_at: row.scanned_at,
    policy_snapshot: JSON.parse(row.policy_snapshot) as AutopilotPolicyEnvelope,
    signal_snapshot: JSON.parse(row.signal_snapshot),
    error: row.error,
  }));
}
