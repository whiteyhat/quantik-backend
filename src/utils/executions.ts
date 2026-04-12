import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import type { TradeDirection, ExecutionSource, ExecutionStatus } from "../types/execution";

export interface ExecutionRecordInput {
  userId: string | null;
  agentId: string | null;
  slug: string;
  side: string;
  direction: TradeDirection;
  source: ExecutionSource;
  amount: number;
  executedAt: number;
  status: ExecutionStatus;
  orderId?: string | null;
  fillPrice?: number | null;
  pnl?: number | null;
  resolutionDate?: string | null;
  pipelineRunId?: string | null;
  closedAt?: number | null;
  chainMode?: "polymarket" | "kraken" | null;
  protocol?: string | null;
  action?: string | null;
  assetPair?: string | null;
  txHash?: string | null;
}

export async function insertExecutionRecord(input: ExecutionRecordInput): Promise<number | null> {
  const updatedAt = input.closedAt ?? input.executedAt;
  const db = getDb();
  const sqliteResult = db.prepare(
    `INSERT INTO executions (
       user_id, agent_id, slug, side, direction, source, amount, executed_at, status, order_id, fill_price, pnl, resolution_date, pipeline_run_id, closed_at, updated_at, chain_mode, protocol, action, asset_pair, tx_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.userId,
    input.agentId,
    input.slug,
    input.side,
    input.direction,
    input.source,
    input.amount,
    input.executedAt,
    input.status,
    input.orderId ?? null,
    input.fillPrice ?? null,
    input.pnl ?? null,
    input.resolutionDate ?? null,
    input.pipelineRunId ?? null,
    input.closedAt ?? null,
    updatedAt,
    input.chainMode ?? null,
    input.protocol ?? null,
    input.action ?? null,
    input.assetPair ?? null,
    input.txHash ?? null
  );

  if (isPgEnabled()) {
    const result = await pgQueryOne<{ id: number }>(
      `INSERT INTO executions (
         user_id, agent_id, slug, side, direction, source, amount, executed_at, status, order_id, fill_price, pnl, resolution_date, pipeline_run_id, closed_at, updated_at, chain_mode, protocol, action, asset_pair, tx_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING id`,
      [
        input.userId,
        input.agentId,
        input.slug,
        input.side,
        input.direction,
        input.source,
        input.amount,
        input.executedAt,
        input.status,
        input.orderId ?? null,
        input.fillPrice ?? null,
        input.pnl ?? null,
        input.resolutionDate ?? null,
        input.pipelineRunId ?? null,
        input.closedAt ?? null,
        updatedAt,
        input.chainMode ?? null,
        input.protocol ?? null,
        input.action ?? null,
        input.assetPair ?? null,
        input.txHash ?? null,
      ]
    );
    return result?.id ?? null;
  }

  return Number(sqliteResult.lastInsertRowid ?? 0) || null;
}
