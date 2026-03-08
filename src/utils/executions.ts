import { getDb } from "../db/schema";
import { isPgEnabled, pgExec } from "../db/postgres";

export interface ExecutionRecordInput {
  userId: string | null;
  agentId: string | null;
  slug: string;
  side: string;
  amount: number;
  executedAt: number;
  status: string;
  orderId?: string | null;
  fillPrice?: number | null;
  pnl?: number | null;
}

export async function insertExecutionRecord(input: ExecutionRecordInput): Promise<void> {
  const db = getDb();
  db.prepare(
    `INSERT INTO executions (
       user_id, agent_id, slug, side, amount, executed_at, status, order_id, fill_price, pnl
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.userId,
    input.agentId,
    input.slug,
    input.side,
    input.amount,
    input.executedAt,
    input.status,
    input.orderId ?? null,
    input.fillPrice ?? null,
    input.pnl ?? null
  );

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO executions (
         user_id, agent_id, slug, side, amount, executed_at, status, order_id, fill_price, pnl
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.userId,
        input.agentId,
        input.slug,
        input.side,
        input.amount,
        input.executedAt,
        input.status,
        input.orderId ?? null,
        input.fillPrice ?? null,
        input.pnl ?? null,
      ]
    );
  }
}
