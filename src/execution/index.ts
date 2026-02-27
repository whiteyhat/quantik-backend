// ── ExecutionEngine — routes signals through paper or live CLOB ──

import { PaperModeEngine } from "./paperMode";
import { FillMonitor } from "./fillMonitor";
import type { PaperOrder } from "./paperMode";
import type { SignalValidation } from "../signal/validator";
import type { RiskApproval } from "../risk";

export type { PaperOrder } from "./paperMode";
export { PaperModeEngine } from "./paperMode";
export { FillMonitor } from "./fillMonitor";

export interface TradeSignal {
  slug: string;
  direction: "YES" | "NO";
  sizeUsdc: number;
}

export interface ExecutionResult {
  orderId: string | null;
  status: "submitted" | "filled" | "rejected" | "stub";
  filledPrice: number | null;
  filledSize: number | null;
}

const paperEngine = new PaperModeEngine();
const fillMonitor = new FillMonitor();

const PAPER_TRADING = process.env.PAPER_TRADING !== "false"; // default true

export function execute(
  signal: TradeSignal,
  riskApproval: RiskApproval
): ExecutionResult {
  if (!riskApproval.approved) {
    return {
      orderId: null,
      status: "rejected",
      filledPrice: null,
      filledSize: null,
    };
  }

  const size = riskApproval.adjustedSize;

  if (PAPER_TRADING) {
    const order = paperEngine.placePaperOrder(
      signal.slug,
      signal.direction,
      size
    );
    return {
      orderId: order.id,
      status: "submitted",
      filledPrice: order.entryPrice,
      filledSize: size,
    };
  }

  // Live CLOB — stub for now
  console.warn(
    `[ExecutionEngine] LIVE trading not implemented. Would place ${signal.direction} order on ${signal.slug} for $${size}`
  );
  return {
    orderId: null,
    status: "stub",
    filledPrice: null,
    filledSize: null,
  };
}

/** Singleton accessors */
export function getPaperEngine(): PaperModeEngine {
  return paperEngine;
}

export function getFillMonitor(): FillMonitor {
  return fillMonitor;
}

/** Start the fill monitor (call from app startup). */
export function startFillMonitor(): void {
  fillMonitor.start();
}
