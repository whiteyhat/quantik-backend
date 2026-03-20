import { getDb } from "../db/schema";
import { computeHealthScore, type HealthScore } from "../monitoring/healthScore";
import { getCircuitBreaker, getCorrelationMonitor } from "../risk";
import { loadCircuitBreakerState } from "../risk/state";
import { getScannerStatus } from "../scanner/marketScanner";
import { getWalletFundingSnapshot } from "../utils/balances";
import { isPgEnabled, pgQuery, pgQueryOne } from "../db/postgres";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerDirectionMap,
  resolveExecutionDirection,
} from "../utils/executionDirection";

export interface ToolExecutionContext {
  userId: string | null;
  linkedAgentId: string | null;
  agentType: "created" | "byo" | null;
  walletAddress: string | null;
  autopilotEnabled: boolean;
  connectionStatus: string | null;
  agentName: string | null;
  lastHeartbeat: number | null;
  agentStatus: string | null;
  polymarketReady: boolean;
}

export interface PortfolioPositionSnapshot {
  slug: string;
  direction: "YES" | "NO";
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
}

export interface PortfolioSnapshot {
  address: string;
  usdc: number;
  onChainUsdc: number;
  onChainUsdcFormatted: string;
  pol: number;
  clobBalance: number;
  polFormatted: string;
  totalValue: number | null;
  pnl: number;
  pnlPct: number | null;
  winRate: number;
  totalTrades: number;
  pnlToday: number;
  pnlTodayPct: number | null;
  circuitBreakerStatus: string;
  kellyUtilization: number;
  drawdown: number;
  drawdownLimit: number;
  balanceStatus: "live" | "unfunded" | "unavailable" | "no_wallet";
  balanceMessage: string;
  fundingStatus: string;
  fundingMessage: string;
  funding_status: string;
  funding_message: string;
  liveBalanceAvailable: boolean;
  realizedToday: number;
  unrealizedToday: number;
  tradesToday: number;
  openPositions: number;
  recentTrades: Array<{
    id: number | string;
    slug: string;
    direction: "YES" | "NO";
    amount: number;
    status: string;
    source: "autopilot" | "manual";
    executedAt: string;
  }>;
  metrics: {
    bestTrade: string;
    bestPnl: number;
    worstTrade: string;
    worstPnl: number;
    totalVolume: number;
    currentStreak: number;
    avgTradeSize: number;
  };
  positions: PortfolioPositionSnapshot[];
  deployedCapital: number;
  availableCapital: number;
  exposurePct: number;
  dailyPnl: number;
  dailyPnlPct: number | null;
}

export interface RiskSnapshot {
  totalCapital: number;
  deployedCapital: number;
  availableCapital: number;
  exposurePct: number;
  dailyPnl: number;
  dailyPnlPct: number;
  circuitBreaker: string;
  circuitBreakerDetail: unknown;
  themeExposure: Record<string, number>;
  positionCount: number;
  maxDrawdownPct: number;
  maxPositionSizePct: number;
  kellyFraction: number;
  luciferVetoThreshold: number;
}

export interface TradeHistorySnapshot {
  trades: Array<{
    slug: string;
    direction: "YES" | "NO";
    size: number;
    price: number;
    outcome: "WIN" | "LOSS" | "OPEN";
    pnl: number;
    timestamp: number;
    mode: string;
  }>;
  count: number;
  winRate: number;
  totalPnl: number;
}

export interface ScannerSignalSnapshot {
  slug: string;
  question: string;
  sigmaConfidence: number;
  kellyFraction: number;
  recommendation: string;
  probability: number;
  scannedAt: number;
  isNew: boolean;
}

export interface ScannerSnapshot {
  source: "cached";
  signals: ScannerSignalSnapshot[];
  count: number;
  newSignalCount: number;
  lastScannedAt: number | null;
  freshnessMs: number | null;
  stale: boolean;
  scanRunning: boolean;
  scanIntervalMs: number;
  action: {
    id: "refresh_signals";
    label: string;
    message: string;
    requiresExplicit: true;
  };
}

export interface OpsSnapshot {
  agentName: string | null;
  agentType: "created" | "byo" | null;
  agentStatus: string | null;
  connectionStatus: string | null;
  autopilotEnabled: boolean;
  lastHeartbeat: number | null;
  health: HealthScore | null;
  polymarketReady: boolean;
}

interface DbAgentContextRow {
  id: string;
  user_id: string | null;
  name: string | null;
  agent_type: string | null;
  wallet_address: string | null;
  autopilot_enabled: number | boolean | null;
  connection_status: string | null;
  last_heartbeat: number | null;
  status: string | null;
}

interface RiskConfigRow {
  drawdown_limit_pct: number;
  max_position_size_pct: number;
  kelly_fraction_multiplier: number;
}

interface LuciferThresholdRow {
  var_threshold: number;
}

interface ScannerRow {
  slug: string;
  scanned_at: number;
  sigma_confidence: number | null;
  kelly_fraction: number | null;
  recommendation: string | null;
  probability: number | null;
  pipeline_result: string | null;
}

function normalizeBoolean(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function slugToQuestion(slug: string): string {
  return slug
    .split("-")
    .map((word) => word ? word.charAt(0).toUpperCase() + word.slice(1) : word)
    .join(" ");
}

function parseScannerQuestion(rawPipeline: string | null, slug: string): string {
  if (!rawPipeline) return slugToQuestion(slug);
  try {
    const parsed = JSON.parse(rawPipeline) as Record<string, unknown>;
    const directQuestion = parsed.market_question;
    if (typeof directQuestion === "string" && directQuestion.trim()) {
      return directQuestion.trim();
    }
  } catch {
    // Ignore malformed JSON from historical rows.
  }
  return slugToQuestion(slug);
}

async function getLatestScannerPriceMap(): Promise<Map<string, number>> {
  let rows: Array<{ slug: string; probability: number }>;

  if (isPgEnabled()) {
    rows = await pgQuery<{ slug: string; probability: number }>(
      `SELECT DISTINCT ON (slug) slug, probability
       FROM scanner_results
       ORDER BY slug, scanned_at DESC`
    );
  } else {
    const db = getDb();
    rows = db.prepare(
      `SELECT s.slug, s.probability
       FROM scanner_results s
       INNER JOIN (
         SELECT slug, MAX(scanned_at) AS latest
         FROM scanner_results
         GROUP BY slug
       ) latest
         ON latest.slug = s.slug AND latest.latest = s.scanned_at`
    ).all() as Array<{ slug: string; probability: number }>;
  }

  return new Map(rows.map((row) => [row.slug, Number(row.probability ?? 0.5)]));
}

async function getRiskConfig(): Promise<{ config: RiskConfigRow | null; lucifer: LuciferThresholdRow | null }> {
  let config: RiskConfigRow | null;
  let lucifer: LuciferThresholdRow | null;

  if (isPgEnabled()) {
    config = await pgQueryOne<RiskConfigRow>(
      `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
       FROM global_circuit_breakers gcb
       JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
       WHERE rc.is_active = 1
       LIMIT 1`
    );

    lucifer = await pgQueryOne<LuciferThresholdRow>(
      `SELECT at.var_threshold
       FROM agent_thresholds at
       JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 AND at.agent_name = $1
       LIMIT 1`,
      ["lucifer"]
    );
  } else {
    const db = getDb();
    config = db.prepare<[], RiskConfigRow>(
      `SELECT gcb.drawdown_limit_pct, gcb.max_position_size_pct, gcb.kelly_fraction_multiplier
       FROM global_circuit_breakers gcb
       JOIN risk_configurations rc ON gcb.risk_configuration_id = rc.id
       WHERE rc.is_active = 1
       LIMIT 1`
    ).get() ?? null;

    lucifer = db.prepare<[], LuciferThresholdRow>(
      `SELECT at.var_threshold
       FROM agent_thresholds at
       JOIN risk_configurations rc ON at.risk_configuration_id = rc.id
       WHERE rc.is_active = 1 AND at.agent_name = 'lucifer'
       LIMIT 1`
    ).get() ?? null;
  }

  return { config, lucifer };
}

function emptyPortfolioSnapshot(context: ToolExecutionContext): PortfolioSnapshot {
  const noWallet = !context.walletAddress;
  return {
    address: context.walletAddress ?? "",
    usdc: 0,
    onChainUsdc: 0,
    onChainUsdcFormatted: "0.00",
    pol: 0,
    clobBalance: 0,
    polFormatted: "0.0000",
    totalValue: null,
    pnl: 0,
    pnlPct: null,
    winRate: 0,
    totalTrades: 0,
    pnlToday: 0,
    pnlTodayPct: null,
    circuitBreakerStatus: "ARMED",
    kellyUtilization: 0,
    drawdown: 0,
    drawdownLimit: 0.15,
    balanceStatus: noWallet ? "no_wallet" : "unavailable",
    balanceMessage: noWallet
      ? "No wallet assigned to this agent yet."
      : "No scoped portfolio data is available for this agent yet.",
    fundingStatus: noWallet ? "no_wallet" : "unavailable",
    fundingMessage: noWallet
      ? "No wallet assigned to this agent yet."
      : "No scoped portfolio data is available for this agent yet.",
    funding_status: noWallet ? "no_wallet" : "unavailable",
    funding_message: noWallet
      ? "No wallet assigned to this agent yet."
      : "No scoped portfolio data is available for this agent yet.",
    liveBalanceAvailable: false,
    realizedToday: 0,
    unrealizedToday: 0,
    tradesToday: 0,
    openPositions: 0,
    recentTrades: [],
    metrics: {
      bestTrade: "N/A",
      bestPnl: 0,
      worstTrade: "N/A",
      worstPnl: 0,
      totalVolume: 0,
      currentStreak: 0,
      avgTradeSize: 0,
    },
    positions: [],
    deployedCapital: 0,
    availableCapital: 0,
    exposurePct: 0,
    dailyPnl: 0,
    dailyPnlPct: null,
  };
}

export function buildToolExecutionContextFromAgentRow(
  userId: string | null,
  agentRow: Record<string, unknown> | null,
): ToolExecutionContext | null {
  if (!agentRow) return null;
  return {
    userId,
    linkedAgentId: typeof agentRow.id === "string" ? agentRow.id : null,
    agentType: agentRow.agent_type === "byo" ? "byo" : "created",
    walletAddress: typeof agentRow.wallet_address === "string" ? agentRow.wallet_address : null,
    autopilotEnabled: normalizeBoolean(agentRow.autopilot_enabled as number | boolean | null | undefined),
    connectionStatus: typeof agentRow.connection_status === "string" ? agentRow.connection_status : null,
    agentName: typeof agentRow.name === "string" ? agentRow.name : null,
    lastHeartbeat: typeof agentRow.last_heartbeat === "number" ? agentRow.last_heartbeat : null,
    agentStatus: typeof agentRow.status === "string" ? agentRow.status : null,
    polymarketReady: normalizeBoolean(agentRow.polymarket_ready as number | boolean | null | undefined),
  };
}

export async function loadToolExecutionContextByAgentId(
  agentId: string,
  userId?: string | null,
): Promise<ToolExecutionContext | null> {
  const columns = `id, user_id, name, agent_type, wallet_address, autopilot_enabled, connection_status, last_heartbeat, status, polymarket_ready`;
  let row: DbAgentContextRow | null = null;

  if (isPgEnabled()) {
    row = await pgQueryOne<DbAgentContextRow>(
      `SELECT ${columns} FROM agents WHERE id = $1${userId ? " AND user_id = $2" : ""}`,
      userId ? [agentId, userId] : [agentId],
    );
  } else {
    const db = getDb();
    row = db.prepare(
      `SELECT ${columns} FROM agents WHERE id = ?${userId ? " AND user_id = ?" : ""}`
    ).get(...(userId ? [agentId, userId] : [agentId])) as DbAgentContextRow | null;
  }

  return buildToolExecutionContextFromAgentRow(userId ?? row?.user_id ?? null, row as Record<string, unknown> | null);
}

export async function loadPortfolioSnapshot(context: ToolExecutionContext | null): Promise<PortfolioSnapshot> {
  if (!context?.linkedAgentId) {
    return emptyPortfolioSnapshot(context ?? {
      userId: null,
      linkedAgentId: null,
      agentType: null,
      walletAddress: null,
      autopilotEnabled: false,
      connectionStatus: null,
      agentName: null,
      lastHeartbeat: null,
      agentStatus: null,
      polymarketReady: false,
    });
  }

  const todayStart = new Date().setUTCHours(0, 0, 0, 0);
  const latestPrices = await getLatestScannerPriceMap();
  const scannerDirections = await getLatestScannerDirectionMap();

  type TradesTodayRow = { tradesToday: number };
  type RealizedTodayRow = { realizedToday: number };
  type OpenExecutionRow = {
    id: number;
    slug: string;
    side: string;
    direction: string | null;
    source: string | null;
    amount: number;
    fill_price: number | null;
    status: string;
    executed_at: number;
  };

  let tradesToday: number;
  let realizedToday: number;
  let openExecutions: OpenExecutionRow[];

  if (isPgEnabled()) {
    const ttRow = await pgQueryOne<TradesTodayRow>(
      `SELECT COUNT(*) AS "tradesToday"
       FROM executions
       WHERE agent_id = $1 AND executed_at >= $2 AND status != 'failed'`,
      [context.linkedAgentId, todayStart]
    );
    tradesToday = Number(ttRow?.tradesToday ?? 0);

    const rtRow = await pgQueryOne<RealizedTodayRow>(
      `SELECT COALESCE(SUM(pnl), 0) AS "realizedToday"
       FROM executions
       WHERE agent_id = $1 AND executed_at >= $2 AND status != 'failed' AND pnl IS NOT NULL`,
      [context.linkedAgentId, todayStart]
    );
    realizedToday = Number(rtRow?.realizedToday ?? 0);

    openExecutions = await pgQuery<OpenExecutionRow>(
      `SELECT id, slug, side, direction, source, amount, fill_price, status, executed_at
       FROM executions
       WHERE agent_id = $1 AND status IN ('placed', 'paper') AND pnl IS NULL
       ORDER BY executed_at DESC`,
      [context.linkedAgentId]
    );
  } else {
    const db = getDb();
    ({ tradesToday } = db.prepare(
      `SELECT COUNT(*) AS tradesToday
       FROM executions
       WHERE agent_id = ? AND executed_at >= ? AND status != 'failed'`
    ).get(context.linkedAgentId, todayStart) as TradesTodayRow);

    ({ realizedToday } = db.prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS realizedToday
       FROM executions
       WHERE agent_id = ? AND executed_at >= ? AND status != 'failed' AND pnl IS NOT NULL`
    ).get(context.linkedAgentId, todayStart) as RealizedTodayRow);

    openExecutions = db.prepare(
      `SELECT id, slug, side, direction, source, amount, fill_price, status, executed_at
       FROM executions
       WHERE agent_id = ? AND status IN ('placed', 'paper') AND pnl IS NULL
       ORDER BY executed_at DESC`
    ).all(context.linkedAgentId) as OpenExecutionRow[];
  }

  let unrealizedToday = 0;
  const positions: PortfolioPositionSnapshot[] = openExecutions.map((execution) => {
    const scannerDirection = scannerDirections.get(execution.slug);
    const currentYes = latestPrices.get(execution.slug) ?? getEntryYesPrice(execution, scannerDirection);
    const metrics = calculateOpenExecutionMetrics(
      execution,
      currentYes,
      scannerDirection
    );

    unrealizedToday += metrics.pnl;

    return {
      slug: execution.slug,
      direction: metrics.direction,
      size: round2(execution.amount),
      entryPrice: round2(metrics.entryTokenPrice),
      currentPrice: round2(metrics.currentTokenPrice),
      pnl: round2(metrics.pnl),
    };
  });

  type TotalWinsRow = { total: number; wins: number };
  type TradeSlugPnlRow = { slug: string; pnl: number };
  type TotalVolumeRow = { totalVolume: number };

  let total: number;
  let wins: number;
  let bestTrade: TradeSlugPnlRow | undefined;
  let worstTrade: TradeSlugPnlRow | undefined;
  let totalVolume: number;

  if (isPgEnabled()) {
    const twRow = await pgQueryOne<TotalWinsRow>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins
       FROM executions
       WHERE agent_id = $1 AND status != 'failed' AND pnl IS NOT NULL`,
      [context.linkedAgentId]
    );
    total = Number(twRow?.total ?? 0);
    wins = Number(twRow?.wins ?? 0);

    bestTrade = (await pgQueryOne<TradeSlugPnlRow>(
      `SELECT slug, pnl
       FROM executions
       WHERE agent_id = $1 AND pnl IS NOT NULL
       ORDER BY pnl DESC
       LIMIT 1`,
      [context.linkedAgentId]
    )) ?? undefined;

    worstTrade = (await pgQueryOne<TradeSlugPnlRow>(
      `SELECT slug, pnl
       FROM executions
       WHERE agent_id = $1 AND pnl IS NOT NULL
       ORDER BY pnl ASC
       LIMIT 1`,
      [context.linkedAgentId]
    )) ?? undefined;

    const tvRow = await pgQueryOne<TotalVolumeRow>(
      `SELECT COALESCE(SUM(amount), 0) AS "totalVolume"
       FROM executions
       WHERE agent_id = $1 AND status != 'failed'`,
      [context.linkedAgentId]
    );
    totalVolume = Number(tvRow?.totalVolume ?? 0);
  } else {
    const db2 = getDb();
    ({ total, wins } = db2.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins
       FROM executions
       WHERE agent_id = ? AND status != 'failed' AND pnl IS NOT NULL`
    ).get(context.linkedAgentId) as TotalWinsRow);

    bestTrade = db2.prepare(
      `SELECT slug, pnl
       FROM executions
       WHERE agent_id = ? AND pnl IS NOT NULL
       ORDER BY pnl DESC
       LIMIT 1`
    ).get(context.linkedAgentId) as TradeSlugPnlRow | undefined;

    worstTrade = db2.prepare(
      `SELECT slug, pnl
       FROM executions
       WHERE agent_id = ? AND pnl IS NOT NULL
       ORDER BY pnl ASC
       LIMIT 1`
    ).get(context.linkedAgentId) as TradeSlugPnlRow | undefined;

    ({ totalVolume } = db2.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS totalVolume
       FROM executions
       WHERE agent_id = ? AND status != 'failed'`
    ).get(context.linkedAgentId) as TotalVolumeRow);
  }

  type RecentTradeRow = {
    id: number;
    slug: string;
    side: string;
    direction: string | null;
    source: string | null;
    amount: number;
    status: string;
    executed_at: number;
  };

  let recentTradeRows: RecentTradeRow[];

  if (isPgEnabled()) {
    recentTradeRows = await pgQuery<RecentTradeRow>(
      `SELECT id, slug, side, direction, source, amount, status, executed_at
       FROM executions
       WHERE agent_id = $1 AND status != 'failed'
       ORDER BY executed_at DESC
       LIMIT 20`,
      [context.linkedAgentId]
    );
  } else {
    const db3 = getDb();
    recentTradeRows = db3.prepare(
      `SELECT id, slug, side, direction, source, amount, status, executed_at
       FROM executions
       WHERE agent_id = ? AND status != 'failed'
       ORDER BY executed_at DESC
       LIMIT 20`
    ).all(context.linkedAgentId) as RecentTradeRow[];
  }

  const recentTrades = recentTradeRows.map((execution) => ({
    id: execution.id,
    slug: execution.slug,
    direction: resolveExecutionDirection(execution, scannerDirections.get(execution.slug)).direction,
    amount: round2(execution.amount),
    status: String(execution.status ?? "").toUpperCase(),
    source: execution.source === "autopilot" ? ("autopilot" as const) : ("manual" as const),
    executedAt: execution.executed_at && Number.isFinite(Number(execution.executed_at))
      ? new Date(Number(execution.executed_at)).toISOString()
      : null,
  }));

  let lastTrades: Array<{ pnl: number }>;

  if (isPgEnabled()) {
    lastTrades = await pgQuery<{ pnl: number }>(
      `SELECT pnl
       FROM executions
       WHERE agent_id = $1 AND pnl IS NOT NULL
       ORDER BY executed_at DESC
       LIMIT 20`,
      [context.linkedAgentId]
    );
  } else {
    const db4 = getDb();
    lastTrades = db4.prepare(
      `SELECT pnl
       FROM executions
       WHERE agent_id = ? AND pnl IS NOT NULL
       ORDER BY executed_at DESC
       LIMIT 20`
    ).all(context.linkedAgentId) as Array<{ pnl: number }>;
  }

  let currentStreak = 0;
  if (lastTrades.length > 0) {
    const firstWasWin = lastTrades[0].pnl > 0;
    for (const trade of lastTrades) {
      if ((trade.pnl > 0) === firstWasWin) currentStreak += 1;
      else break;
    }
    if (!firstWasWin) currentStreak = -currentStreak;
  }

  const funding = await getWalletFundingSnapshot(context.walletAddress);
  let totalTradesAll: number;
  let totalRealizedPnl: number;

  if (isPgEnabled()) {
    const ttaRow = await pgQueryOne<{ totalTradesAll: number }>(
      `SELECT COUNT(*) AS "totalTradesAll"
       FROM executions
       WHERE agent_id = $1 AND status != 'failed'`,
      [context.linkedAgentId]
    );
    totalTradesAll = Number(ttaRow?.totalTradesAll ?? 0);

    const trpRow = await pgQueryOne<{ totalRealizedPnl: number }>(
      `SELECT COALESCE(SUM(pnl), 0) AS "totalRealizedPnl"
       FROM executions
       WHERE agent_id = $1 AND pnl IS NOT NULL`,
      [context.linkedAgentId]
    );
    totalRealizedPnl = Number(trpRow?.totalRealizedPnl ?? 0);
  } else {
    const db5 = getDb();
    ({ totalTradesAll } = db5.prepare(
      `SELECT COUNT(*) AS totalTradesAll
       FROM executions
       WHERE agent_id = ? AND status != 'failed'`
    ).get(context.linkedAgentId) as { totalTradesAll: number });

    ({ totalRealizedPnl } = db5.prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS totalRealizedPnl
       FROM executions
       WHERE agent_id = ? AND pnl IS NOT NULL`
    ).get(context.linkedAgentId) as { totalRealizedPnl: number });
  }

  const deployedCapital = round2(openExecutions.reduce((sum, execution) => sum + (execution.amount ?? 0), 0));
  const pnlToday = round2(realizedToday + unrealizedToday);
  const cumulativePnl = round2(totalRealizedPnl + unrealizedToday);
  const trackedPortfolioValue = funding.usdcStatus === "live"
    ? Math.max(funding.onChainUsdc + deployedCapital + unrealizedToday, 0)
    : null;
  const totalValue = trackedPortfolioValue == null ? null : round2(trackedPortfolioValue);
  const balanceStatus = !context.walletAddress
    ? "no_wallet"
    : funding.usdcStatus !== "live"
      ? "unavailable"
      : totalValue && totalValue > 0
        ? "live"
        : "unfunded";
  const balanceMessage = balanceStatus === "no_wallet"
    ? "No wallet assigned to this agent yet."
    : balanceStatus === "unavailable"
      ? "Unable to read the on-chain USDC balance right now."
      : balanceStatus === "unfunded"
        ? "Wallet created but no on-chain USDC balance or tracked open positions detected yet."
        : deployedCapital > 0
          ? "Live on-chain USDC balance plus tracked open exposure."
          : "Live on-chain USDC balance available.";
  const pnlPct = totalValue && totalValue > 0 ? cumulativePnl / totalValue : null;
  const pnlTodayPct = totalValue && totalValue > 0 ? pnlToday / totalValue : null;
  const exposurePct = totalValue && totalValue > 0 ? (deployedCapital / totalValue) * 100 : 0;
  const winRate = total > 0 ? (wins ?? 0) / total : 0;

  const cbRow = await loadCircuitBreakerState();
  const { config } = await getRiskConfig();
  const kellyMultiplier = config?.kelly_fraction_multiplier ?? 0.25;
  const kellyUtilization = totalValue !== null && totalValue > 0 && kellyMultiplier > 0
    ? deployedCapital / (totalValue * kellyMultiplier)
    : 0;

  return {
    address: funding.address ?? context.walletAddress ?? "",
    usdc: round2(funding.onChainUsdc),
    onChainUsdc: round2(funding.onChainUsdc),
    onChainUsdcFormatted: funding.onChainUsdc.toFixed(2),
    pol: round2(funding.pol),
    polFormatted: funding.pol.toFixed(4),
    totalValue,
    pnl: cumulativePnl,
    pnlPct,
    winRate,
    totalTrades: totalTradesAll ?? 0,
    pnlToday,
    pnlTodayPct,
    circuitBreakerStatus: cbRow?.state ?? "ARMED",
    kellyUtilization,
    drawdown: cbRow?.drawdown_pct ?? 0,
    drawdownLimit: config?.drawdown_limit_pct ?? 0.15,
    balanceStatus,
    balanceMessage,
    clobBalance: round2(funding.clobBalance),
    fundingStatus: funding.fundingStatus,
    fundingMessage: funding.fundingMessage,
    funding_status: funding.fundingStatus,
    funding_message: funding.fundingMessage,
    liveBalanceAvailable: funding.usdcStatus === "live",
    realizedToday: round2(realizedToday),
    unrealizedToday: round2(unrealizedToday),
    tradesToday: tradesToday ?? 0,
    openPositions: openExecutions.length,
    recentTrades,
    metrics: {
      bestTrade: bestTrade?.slug ?? "N/A",
      bestPnl: round2(bestTrade?.pnl ?? 0),
      worstTrade: worstTrade?.slug ?? "N/A",
      worstPnl: round2(worstTrade?.pnl ?? 0),
      totalVolume: round2(totalVolume ?? 0),
      currentStreak,
      avgTradeSize: total > 0 ? round2((totalVolume ?? 0) / total) : 0,
    },
    positions,
    deployedCapital,
    availableCapital: funding.usdcStatus === "live" ? round2(funding.onChainUsdc) : 0,
    exposurePct: round2(exposurePct),
    dailyPnl: pnlToday,
    dailyPnlPct: pnlTodayPct,
  };
}

export async function loadRiskSnapshot(context: ToolExecutionContext | null): Promise<RiskSnapshot> {
  const portfolio = await loadPortfolioSnapshot(context);
  const correlation = getCorrelationMonitor();
  const cbStatus = await getCircuitBreaker().getStatus();
  const { config, lucifer } = await getRiskConfig();

  const totalCapital = portfolio.totalValue ?? 0;
  const themeExposure: Record<string, number> = {};
  for (const position of portfolio.positions) {
    const category = correlation.categorize(position.slug);
    const prev = themeExposure[category] ?? 0;
    const contribution = totalCapital > 0 ? (position.size / totalCapital) * 100 : 0;
    themeExposure[category] = round2(prev + contribution);
  }

  const rawMaxPosition = config?.max_position_size_pct ?? 0.10;
  const maxPositionSizePct = rawMaxPosition > 1 ? rawMaxPosition / 100 : rawMaxPosition;

  return {
    totalCapital: round2(totalCapital),
    deployedCapital: portfolio.deployedCapital,
    availableCapital: portfolio.availableCapital,
    exposurePct: portfolio.exposurePct,
    dailyPnl: portfolio.dailyPnl,
    dailyPnlPct: round2((portfolio.dailyPnlPct ?? 0) * 100),
    circuitBreaker: cbStatus.state,
    circuitBreakerDetail: cbStatus,
    themeExposure,
    positionCount: portfolio.positions.length,
    maxDrawdownPct: config?.drawdown_limit_pct ?? 0.15,
    maxPositionSizePct,
    kellyFraction: config?.kelly_fraction_multiplier ?? 0.25,
    luciferVetoThreshold: lucifer?.var_threshold ?? 0.03,
  };
}

export async function loadTradeHistorySnapshot(
  context: ToolExecutionContext | null,
  limit = 10,
): Promise<TradeHistorySnapshot> {
  if (!context?.linkedAgentId) {
    return { trades: [], count: 0, winRate: 0, totalPnl: 0 };
  }

  const safeLimit = Math.min(Math.max(1, limit), 50);
  const livePrice = await getLatestScannerPriceMap();
  const scannerDirections = await getLatestScannerDirectionMap();

  type TradeExecutionRow = {
    slug: string;
    side: string;
    direction: string | null;
    amount: number;
    fill_price: number | null;
    status: string;
    pnl: number | null;
    executed_at: number;
  };

  let executions: TradeExecutionRow[];

  if (isPgEnabled()) {
    executions = await pgQuery<TradeExecutionRow>(
      `SELECT slug, side, direction, amount, fill_price, status, pnl, executed_at
       FROM executions
       WHERE agent_id = $1
       ORDER BY executed_at DESC
       LIMIT $2`,
      [context.linkedAgentId, safeLimit]
    );
  } else {
    const db = getDb();
    executions = db.prepare(
      `SELECT slug, side, direction, amount, fill_price, status, pnl, executed_at
       FROM executions
       WHERE agent_id = ?
       ORDER BY executed_at DESC
       LIMIT ?`
    ).all(context.linkedAgentId, safeLimit) as TradeExecutionRow[];
  }

  const trades = executions.map((execution) => {
    const scannerDirection = scannerDirections.get(execution.slug);
    const currentYes = livePrice.get(execution.slug) ?? getEntryYesPrice(execution, scannerDirection);
    const metrics = calculateOpenExecutionMetrics(
      execution,
      currentYes,
      scannerDirection
    );

    let outcome: "WIN" | "LOSS" | "OPEN" = "OPEN";
    if (execution.pnl != null) outcome = execution.pnl > 0 ? "WIN" : "LOSS";
    else if (execution.status === "failed") outcome = "LOSS";

    return {
      slug: execution.slug,
      direction: metrics.direction,
      size: round2(execution.amount),
      price: round2(metrics.entryYesPrice),
      outcome,
      pnl: round2(execution.pnl ?? metrics.pnl),
      timestamp: execution.executed_at,
      mode: execution.status,
    };
  });

  const settled = trades.filter((trade) => trade.outcome !== "OPEN");
  const wins = settled.filter((trade) => trade.outcome === "WIN").length;

  return {
    trades,
    count: trades.length,
    winRate: settled.length > 0 ? round2((wins / settled.length) * 100) : 0,
    totalPnl: round2(trades.reduce((sum, trade) => sum + trade.pnl, 0)),
  };
}

export async function loadScannerSnapshot(options?: {
  alertsOnly?: boolean;
  lastSeenSignalAt?: number | null;
  limit?: number;
}): Promise<ScannerSnapshot> {
  const status = getScannerStatus();
  const safeLimit = Math.min(Math.max(1, options?.limit ?? 3), 10);
  const lastSeenSignalAt = options?.lastSeenSignalAt ?? null;

  let rows: ScannerRow[];

  if (isPgEnabled()) {
    const pgAlertFilter = options?.alertsOnly
      ? "WHERE sigma_confidence >= 0.70 AND kelly_fraction >= 0.40"
      : "";
    rows = await pgQuery<ScannerRow>(
      `SELECT slug, scanned_at, sigma_confidence, kelly_fraction, recommendation, probability, pipeline_result
       FROM (
         SELECT DISTINCT ON (slug) slug, scanned_at, sigma_confidence, kelly_fraction, recommendation, probability, pipeline_result
         FROM scanner_results
         ORDER BY slug, scanned_at DESC
       ) latest
       ${pgAlertFilter}
       ORDER BY scanned_at DESC
       LIMIT $1`,
      [safeLimit]
    );
  } else {
    const db = getDb();
    const sqliteAlertFilter = options?.alertsOnly
      ? "WHERE s.sigma_confidence >= 0.70 AND s.kelly_fraction >= 0.40"
      : "";
    rows = db.prepare(
      `SELECT s.slug, s.scanned_at, s.sigma_confidence, s.kelly_fraction, s.recommendation, s.probability, s.pipeline_result
       FROM scanner_results s
       INNER JOIN (
         SELECT slug, MAX(scanned_at) AS latest
         FROM scanner_results
         GROUP BY slug
       ) latest
         ON latest.slug = s.slug AND latest.latest = s.scanned_at
       ${sqliteAlertFilter}
       ORDER BY s.scanned_at DESC
       LIMIT ?`
    ).all(safeLimit) as ScannerRow[];
  }

  const lastScannedAt = rows[0]?.scanned_at ?? status.lastScan ?? null;
  const freshnessMs = lastScannedAt ? Math.max(0, Date.now() - lastScannedAt) : null;
  const stale = freshnessMs == null ? true : freshnessMs > 10 * 60 * 1000;
  const signals = rows.map((row) => ({
    slug: row.slug,
    question: parseScannerQuestion(row.pipeline_result, row.slug),
    sigmaConfidence: Number(row.sigma_confidence ?? 0),
    kellyFraction: Number(row.kelly_fraction ?? 0),
    recommendation: String(row.recommendation ?? "SKIP"),
    probability: Number(row.probability ?? 0),
    scannedAt: row.scanned_at,
    isNew: lastSeenSignalAt != null ? row.scanned_at > lastSeenSignalAt : false,
  }));

  return {
    source: "cached",
    signals,
    count: signals.length,
    newSignalCount: signals.filter((signal) => signal.isNew).length,
    lastScannedAt,
    freshnessMs,
    stale,
    scanRunning: status.running,
    scanIntervalMs: 5 * 60 * 1000,
    action: {
      id: "refresh_signals",
      label: "Refresh signals",
      message: "Refresh scanner signals now.",
      requiresExplicit: true,
    },
  };
}

export async function loadOpsSnapshot(context: ToolExecutionContext | null): Promise<OpsSnapshot> {
  const health = context?.agentType === "byo" && context.linkedAgentId
    ? await computeHealthScore(context.linkedAgentId)
    : null;

  return {
    agentName: context?.agentName ?? null,
    agentType: context?.agentType ?? null,
    agentStatus: context?.agentStatus ?? null,
    connectionStatus: context?.connectionStatus ?? null,
    autopilotEnabled: context?.autopilotEnabled ?? false,
    lastHeartbeat: context?.lastHeartbeat ?? null,
    health,
    polymarketReady: context?.polymarketReady ?? false,
  };
}
