// ── ExecutionEngine — routes signals through paper or live CLOB ──

import { PaperModeEngine } from "./paperMode";
import { FillMonitor } from "./fillMonitor";
import { runCliWithWallet } from "../cli";
import { loadActiveAgentContext } from "../utils/agentKey";
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

  // Size is already validated upstream:
  //   - Scanner path: capped by agent's autopilot policy (maxBetUsdc from DB)
  //   - Pipeline path: validated by approvePosition() risk checks
  const size = riskApproval.adjustedSize;

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
  // Polymarket CLOB tick size is 0.01 (max 2 decimal places)
  const tickPrice = Math.round(price * 100) / 100;
  // --size is share count, not USDC. Convert: shares = usdc / pricePerShare
  const shareSize = tickPrice > 0
    ? Math.floor((size / tickPrice) * 100) / 100
    : size;
  const cliArgs = [
    "clob", "create-order",
    "--token", tokenId,
    "--side", "buy",
    "--price", String(tickPrice),
    "--size", String(shareSize),
    "--signature-type", process.env.POLYMARKET_SIGNATURE_TYPE ?? "eoa",
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

  // Decrypt the active agent's private key and inject it into the CLI subprocess env
  const { privateKey } = await loadActiveAgentContext();
  const rawData = await runCliWithWallet(cliArgs, privateKey) as Record<string, unknown>;
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

/** Single fill check — used by BullMQ worker. */
export async function runFillCheck(): Promise<void> { fillMonitor.pollOrders(); }
