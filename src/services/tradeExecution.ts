import { v4 as uuid } from "uuid";
import { runCliWithWallet, CliError } from "../cli";
import { insertTrade, insertPaperTrade, getSettings } from "../db/queries";
import { dualQueryOne, dualExec } from "../db/postgres";
import { insertExecutionRecord } from "../utils/executions";
import { fetchMarketBySlug } from "../utils/market-fetch";
import { emitTradeExecuted, emitNotification } from "../infra/socket";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  recommendationToDirection,
} from "../utils/executionDirection";
import { toFiniteNumber } from "../utils/numbers";
import type { TradeDirection, ExecutionRecord } from "../types/execution";

export type ManagedTradeDirection = TradeDirection;

export interface ManagedTradeRequest {
  userId: string | null;
  agentId: string | null;
  marketSlug: string;
  direction: ManagedTradeDirection;
  source: "autopilot" | "manual";
  sizeUsdc: number;
  requestedTokenId?: string | null;
  quotedPrice?: number | null;
  netEv?: number | null;
  evGrade?: string | null;
  pipelineRunId?: string | null;
  walletPrivateKey?: string | null;
  walletError?: string;
  emitUserId?: string | null;
}

export interface ManagedTradeResult {
  ok: boolean;
  orderId: string | null;
  paper: boolean;
  status: "paper" | "placed" | "failed";
  tokenId: string;
  direction: ManagedTradeDirection;
  size: number;
  price: number;
  slug: string;
  rawData: unknown;
  error?: string;
}

function extractOrderId(data: Record<string, unknown>): string | null {
  const candidates = [data["id"], data["orderID"], data["order_id"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractFillPrice(data: Record<string, unknown>): number | null {
  const directFields = [
    data["avgPrice"],
    data["avg_price"],
    data["executedPrice"],
    data["executed_price"],
    data["price"],
  ];
  for (const field of directFields) {
    const parsed = toFiniteNumber(field);
    if (parsed != null) return parsed;
  }

  const nestedOrder = data["order"];
  if (nestedOrder && typeof nestedOrder === "object") {
    const nestedPrice = toFiniteNumber((nestedOrder as Record<string, unknown>)["price"]);
    if (nestedPrice != null) return nestedPrice;
  }

  return null;
}

function resolveQuotedPrice(direction: ManagedTradeDirection, quotedPrice: number | null, marketData: Awaited<ReturnType<typeof fetchMarketBySlug>> | null): number {
  if (quotedPrice != null && Number.isFinite(quotedPrice)) {
    return quotedPrice;
  }
  if (direction === "YES") {
    return marketData?.yes_price ?? 0.5;
  }
  return marketData?.no_price ?? Math.max(0.01, Math.min(0.99, 1 - (marketData?.yes_price ?? 0.5)));
}

export async function executeManagedTrade(input: ManagedTradeRequest): Promise<ManagedTradeResult> {
  const [settings, marketData] = await Promise.all([
    getSettings(),
    fetchMarketBySlug(input.marketSlug).catch(() => null),
  ]);
  const resolutionDate = marketData?.resolution_date ?? null;

  const derivedTokenId =
    input.direction === "YES"
      ? marketData?.yes_token_id ?? marketData?.token_id ?? null
      : marketData?.no_token_id ?? marketData?.token_id ?? null;

  const resolvedTokenId =
    input.requestedTokenId && (!derivedTokenId || input.requestedTokenId === derivedTokenId)
      ? input.requestedTokenId
      : derivedTokenId ?? input.requestedTokenId ?? null;

  if (!resolvedTokenId) {
    return {
      ok: false,
      orderId: null,
      paper: settings.paper_mode,
      status: "failed",
      tokenId: "",
      direction: input.direction,
      size: input.sizeUsdc,
      price: resolveQuotedPrice(input.direction, input.quotedPrice ?? null, marketData),
      slug: input.marketSlug,
      rawData: { error: "Unable to resolve Polymarket token ID for this market/direction." },
      error: "Unable to resolve Polymarket token ID for this market/direction.",
    };
  }

  const quotedPrice = resolveQuotedPrice(input.direction, input.quotedPrice ?? null, marketData);
  const socketUserId = input.emitUserId ?? input.userId;
  const now = Date.now();

  if (settings.paper_mode) {
    const paperId = `PAPER-${uuid()}`;

    await Promise.all([
      insertPaperTrade({
        id: paperId,
        market_id: resolvedTokenId,
        side: input.direction,
        size: input.sizeUsdc,
        price: quotedPrice,
        status: "submitted",
        created_at: now,
        settled_at: null,
        pnl: null,
      }),
      insertTrade({
        id: uuid(),
        order_id: paperId,
        market_slug: input.marketSlug,
        direction: input.direction,
        source: input.source,
        size: input.sizeUsdc,
        price: quotedPrice,
        net_ev: input.netEv ?? null,
        ev_grade: input.evGrade ?? null,
        status: "paper",
        created_at: now,
        pipeline_run_id: input.pipelineRunId ?? null,
      }),
      insertExecutionRecord({
        userId: input.userId,
        agentId: input.agentId,
        slug: input.marketSlug,
        side: "buy",
        direction: input.direction,
        source: input.source,
        amount: input.sizeUsdc,
        executedAt: now,
        status: "paper",
        orderId: paperId,
        fillPrice: quotedPrice,
        resolutionDate,
        pipelineRunId: input.pipelineRunId ?? null,
      }),
    ]);

    emitTradeExecuted(socketUserId, {
      orderId: paperId,
      slug: input.marketSlug,
      direction: input.direction,
      size: input.sizeUsdc,
      price: quotedPrice,
      status: "paper",
      paper: true,
      timestamp: now,
    });

    // Build rawData (the shape sent to the client) once, then reference it
    const paperData = { orderId: paperId, status: "paper" as const, paper: true, tokenId: resolvedTokenId, direction: input.direction, price: quotedPrice, size: input.sizeUsdc };
    return {
      ok: true,
      ...paperData,
      slug: input.marketSlug,
      rawData: paperData,
    };
  }

  if (!input.walletPrivateKey) {
    const walletMsg = input.walletError
      ?? "No wallet configured. Go to Manage Agent -> assign a wallet and run approvals.";
    return {
      ok: false,
      orderId: null,
      paper: false,
      status: "failed",
      tokenId: resolvedTokenId,
      direction: input.direction,
      size: input.sizeUsdc,
      price: quotedPrice,
      slug: input.marketSlug,
      rawData: { error: walletMsg },
      error: walletMsg,
    };
  }

  const cliArgs = [
    "clob",
    "market-order",
    "--token", resolvedTokenId,
    "--side", "buy",
    "--amount", input.sizeUsdc.toFixed(2),
    "--signature-type", process.env.POLYMARKET_SIGNATURE_TYPE ?? "eoa",
  ];

  let rawData: unknown;
  try {
    rawData = await runCliWithWallet(cliArgs, input.walletPrivateKey);
  } catch (cliErr) {
    // The Polymarket CLI exits non-zero on API errors (e.g. insufficient balance).
    // Try to extract the JSON error from the CliError message before giving up.
    let errorMsg = cliErr instanceof Error ? cliErr.message : String(cliErr);
    if (cliErr instanceof CliError) {
      const jsonMatch = errorMsg.match(/\{[^}]*"error"\s*:\s*"([^"]+)"/);
      if (jsonMatch?.[1]) {
        // Extract the human-readable part after the HTTP status prefix
        const inner = jsonMatch[1];
        const readable = inner.replace(/^Status:\s*error\([^)]*\)\s*making\s+\w+\s+call\s+to\s+\S+\s+with\s+/, "");
        try {
          const parsed = JSON.parse(readable);
          errorMsg = typeof parsed.error === "string" ? parsed.error : readable;
        } catch {
          errorMsg = readable;
        }
      }
    }

    await insertExecutionRecord({
      userId: input.userId,
      agentId: input.agentId,
      slug: input.marketSlug,
      side: "buy",
      direction: input.direction,
      source: input.source,
      amount: input.sizeUsdc,
      executedAt: now,
      status: "failed",
      fillPrice: quotedPrice,
      resolutionDate,
      pipelineRunId: input.pipelineRunId ?? null,
    });

    return {
      ok: false,
      orderId: null,
      paper: false,
      status: "failed",
      tokenId: resolvedTokenId,
      direction: input.direction,
      size: input.sizeUsdc,
      price: quotedPrice,
      slug: input.marketSlug,
      rawData: { error: errorMsg },
      error: errorMsg,
    };
  }

  const data =
    rawData !== null && typeof rawData === "object"
      ? (rawData as Record<string, unknown>)
      : {};

  if (typeof data["error"] === "string") {
    await insertExecutionRecord({
      userId: input.userId,
      agentId: input.agentId,
      slug: input.marketSlug,
      side: "buy",
      direction: input.direction,
      source: input.source,
      amount: input.sizeUsdc,
      executedAt: now,
      status: "failed",
      fillPrice: quotedPrice,
      resolutionDate,
      pipelineRunId: input.pipelineRunId ?? null,
    });

    return {
      ok: false,
      orderId: null,
      paper: false,
      status: "failed",
      tokenId: resolvedTokenId,
      direction: input.direction,
      size: input.sizeUsdc,
      price: quotedPrice,
      slug: input.marketSlug,
      rawData,
      error: data["error"],
    };
  }

  const orderId = extractOrderId(data);
  const fillPrice = extractFillPrice(data) ?? quotedPrice;

  await Promise.all([
    insertTrade({
      id: uuid(),
      order_id: orderId,
      market_slug: input.marketSlug,
      direction: input.direction,
      source: input.source,
      size: input.sizeUsdc,
      price: fillPrice,
      net_ev: input.netEv ?? null,
      ev_grade: input.evGrade ?? null,
      status: "submitted",
      created_at: now,
      pipeline_run_id: input.pipelineRunId ?? null,
    }),
    insertExecutionRecord({
      userId: input.userId,
      agentId: input.agentId,
      slug: input.marketSlug,
      side: "buy",
      direction: input.direction,
      source: input.source,
      amount: input.sizeUsdc,
      executedAt: now,
      status: "placed",
      orderId,
      fillPrice,
      resolutionDate,
      pipelineRunId: input.pipelineRunId ?? null,
    }),
  ]);

  emitTradeExecuted(socketUserId, {
    orderId: orderId ?? "",
    slug: input.marketSlug,
    direction: input.direction,
    size: input.sizeUsdc,
    price: fillPrice,
    status: "placed",
    paper: false,
    timestamp: now,
  });

  return {
    ok: true,
    orderId,
    paper: false,
    status: "placed",
    tokenId: resolvedTokenId,
    direction: input.direction,
    size: input.sizeUsdc,
    price: fillPrice,
    slug: input.marketSlug,
    rawData,
  };
}

// ── Close Position ──────────────────────────────────────────────

export interface ClosePositionRequest {
  executionId: number;
  userId: string | null;
  agentId: string | null;
}

export type ClosePositionErrorCode = "NOT_FOUND" | "FORBIDDEN";

export interface ClosePositionResult {
  ok: boolean;
  executionId?: number;
  slug?: string;
  direction?: string;
  size?: number;
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  closedAt?: number;
  status?: "closed";
  error?: ClosePositionErrorCode | string;
}

export async function closePosition(req: ClosePositionRequest): Promise<ClosePositionResult> {
  const { executionId, userId, agentId } = req;

  // Fetch the open execution
  const execution = await dualQueryOne<ExecutionRecord>(
    `SELECT id, user_id, agent_id, slug, side, direction, source, amount, fill_price, status, resolution_date
       FROM executions
      WHERE id = $1
        AND status IN ('placed', 'paper')
        AND pnl IS NULL`,
    [executionId]
  ) ?? undefined;

  if (!execution) {
    return { ok: false, error: "NOT_FOUND" };
  }

  // Ownership check
  const isOwner =
    (userId && execution.user_id === userId) ||
    (agentId && execution.agent_id === agentId);
  if (!isOwner) {
    return { ok: false, error: "FORBIDDEN" };
  }

  // Fetch latest scanner row for this slug (price + direction in one query)
  const scannerRow = await dualQueryOne<{ probability: number; recommendation: string | null }>(
    `SELECT probability, recommendation FROM scanner_results WHERE slug = $1 ORDER BY scanned_at DESC LIMIT 1`,
    [execution.slug]
  );

  const scannerDirection = scannerRow ? recommendationToDirection(scannerRow.recommendation) ?? undefined : undefined;
  const currentYes = scannerRow?.probability ?? getEntryYesPrice(execution, scannerDirection);
  const metrics = calculateOpenExecutionMetrics(execution, currentYes, scannerDirection);
  const realizedPnl = Math.round(metrics.pnl * 100) / 100;
  const now = Date.now();

  // Update execution to closed
  await dualExec(
    `UPDATE executions
        SET status = 'closed',
            pnl = $1,
            closed_at = $2,
            updated_at = $3
      WHERE id = $4`,
    [realizedPnl, now, now, execution.id]
  );

  // Emit notification
  emitNotification(userId ?? execution.user_id ?? null, {
    id: `position-close-${execution.id}-${now}`,
    level: realizedPnl >= 0 ? "success" : "warning",
    title: "Position closed",
    message: `${execution.slug} closed at ${Math.round(metrics.currentTokenPrice * 100)}¢ for ${realizedPnl >= 0 ? "+" : ""}$${Math.abs(realizedPnl).toFixed(2)} P&L.`,
    category: "position",
    timestamp: now,
    action: {
      label: "Open market",
      href: `/market/${execution.slug}`,
    },
  });

  return {
    ok: true,
    executionId: execution.id,
    slug: execution.slug,
    direction: metrics.direction,
    size: execution.amount,
    entryPrice: metrics.entryTokenPrice,
    exitPrice: metrics.currentTokenPrice,
    pnl: realizedPnl,
    closedAt: now,
    status: "closed",
  };
}
