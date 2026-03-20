import { v4 as uuid } from "uuid";
import { runCliWithWallet } from "../cli";
import { insertTrade, insertPaperTrade, getSettings } from "../db/queries";
import { insertExecutionRecord } from "../utils/executions";
import { fetchMarketBySlug } from "../utils/market-fetch";
import { emitTradeExecuted } from "../infra/socket";

export type ManagedTradeDirection = "YES" | "NO";

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

function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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
  const settings = await getSettings();
  const marketData = await fetchMarketBySlug(input.marketSlug).catch(() => null);
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

    await insertPaperTrade({
      id: paperId,
      market_id: resolvedTokenId,
      side: input.direction,
      size: input.sizeUsdc,
      price: quotedPrice,
      status: "submitted",
      created_at: now,
      settled_at: null,
      pnl: null,
    });

    await insertTrade({
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
    });

    await insertExecutionRecord({
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
    });

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

    const paperResult = {
      orderId: paperId,
      status: "paper",
      paper: true,
      tokenId: resolvedTokenId,
      direction: input.direction,
      price: quotedPrice,
      size: input.sizeUsdc,
    };

    return {
      ok: true,
      orderId: paperId,
      paper: true,
      status: "paper",
      tokenId: resolvedTokenId,
      direction: input.direction,
      size: input.sizeUsdc,
      price: quotedPrice,
      slug: input.marketSlug,
      rawData: paperResult,
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

  const rawData = await runCliWithWallet(cliArgs, input.walletPrivateKey);
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

  await insertTrade({
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
  });

  await insertExecutionRecord({
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
  });

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
