// Shared type definitions for trade executions.

/** Execution lifecycle status. */
export type ExecutionStatus = "paper" | "placed" | "failed" | "closed";

/** Trade source — who initiated it. */
export type ExecutionSource = "autopilot" | "manual";

/** Trade direction on Polymarket. */
export type TradeDirection = "YES" | "NO";

/** Shape of an execution row from the DB. */
export interface ExecutionRecord {
  id: number;
  user_id: string | null;
  agent_id: string | null;
  slug: string;
  side: "buy" | "sell";
  direction: TradeDirection | null;
  source: ExecutionSource | null;
  amount: number;
  executed_at: number;
  status: ExecutionStatus;
  order_id: string | null;
  fill_price: number | null;
  pnl: number | null;
  resolution_date: string | null;
  pipeline_run_id: string | null;
  closed_at: number | null;
  updated_at: number | null;
  chain_mode?: "polymarket" | "kraken" | null;
  protocol?: string | null;
  action?: string | null;
  asset_pair?: string | null;
  tx_hash?: string | null;
}
