// ── ExecutionEngine — routes signals through paper or live CLOB ──

import { PaperModeEngine } from "./paperMode";
import { FillMonitor } from "./fillMonitor";
import { runCli } from "../cli";
import type { PaperOrder } from "./paperMode";
import type { RiskApproval } from "../risk";

export type { PaperOrder } from "./paperMode";
export { PaperModeEngine } from "./paperMode";
export { FillMonitor } from "./fillMonitor";

export interface TradeSignal {
  slug: string;
  direction: "YES" | "NO";
  sizeUsdc: number;
  tokenId?: string;
  price?: number;
}

export interface ExecutionResult {
  orderId: string | null;
  status: "submitted" | "filled" | "rejected" | "stub" | "dry-run";
  filledPrice: number | null;
  filledSize: number | null;
  execution_mode: "live" | "paper";
}

const paperEngine = new PaperModeEngine();
const fillMonitor = new FillMonitor();

const PAPER_TRADING = process.env.PAPER_TRADING !== "false"; // default true
const MAX_BET_USDC = Number(process.env.MAX_BET_USDC ?? 10);  // default $10 hard cap
const DRY_RUN = process.env.DRY_RUN === "true";               // log CLI cmd, no exec

// ── Rate limit: max 1 execution per market per 60 s ─────────────
const lastExecTime = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;

function checkRateLimit(slug: string): boolean {
  const now = Date.now();
  const last = lastExecTime.get(slug);
  if (last && now - last < RATE_LIMIT_MS) return false;
  lastExecTime.set(slug, now);
  return true;
}

export async function execute(
  signal: TradeSignal,
  riskApproval: RiskApproval
): Promise<ExecutionResult> {
  if (!riskApproval.approved) {
    return {
      orderId: null,
      status: "rejected",
      filledPrice: null,
      filledSize: null,
      execution_mode: PAPER_TRADING ? "paper" : "live",
    };
  }

  // MAX_BET_USDC guard
  const rawSize = riskApproval.adjustedSize;
  const size = Math.min(rawSize, MAX_BET_USDC);
  if (rawSize > MAX_BET_USDC) {
    console.warn("[ExecutionEngine] Size capped from $" + rawSize + " to MAX_BET_USDC=$" + MAX_BET_USDC);
  }

  if (PAPER_TRADING) {
    const order = paperEngine.placePaperOrder(signal.slug, signal.direction, size);
    return {
      orderId: order.id,
      status: "submitted",
      filledPrice: order.entryPrice,
      filledSize: size,
      execution_mode: "paper",
    };
  }

  // ── Live CLOB path ────────────────────────────────────────────

  if (!checkRateLimit(signal.slug)) {
    console.warn("[ExecutionEngine] Rate limit hit for market " + signal.slug);
    return {
      orderId: null,
      status: "rejected",
      filledPrice: null,
      filledSize: null,
      execution_mode: "live",
    };
  }

  const tokenId = signal.tokenId ?? signal.slug;
  const price = signal.price ?? 0.5;
  const cliArgs = [
    "clob", "create-order",
    "--token-id", tokenId,
    "--side", signal.direction,
    "--price", String(price),
    "--size", String(size),
  ];

  // Dry-run mode: log the command but don't execute
  if (DRY_RUN) {
    console.log("[ExecutionEngine][DRY-RUN] polymarket " + cliArgs.join(" "));
    return {
      orderId: null,
      status: "dry-run",
      filledPrice: price,
      filledSize: size,
      execution_mode: "live",
    };
  }

  const rawData = await runCli(cliArgs) as Record<string, unknown>;
  const orderId =
    typeof rawData["orderID"] === "string"
      ? rawData["orderID"]
      : typeof rawData["order_id"] === "string"
      ? rawData["order_id"]
      : null;

  return {
    orderId,
    status: "submitted",
    filledPrice: price,
    filledSize: size,
    execution_mode: "live",
  };
}

/** Singleton accessors */
export function getPaperEngine(): PaperModeEngine { return paperEngine; }
export function getFillMonitor(): FillMonitor { return fillMonitor; }

/** Start the fill monitor (call from app startup). */
export function startFillMonitor(): void { fillMonitor.start(); }
