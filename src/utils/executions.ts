import { getDb } from "../db/schema";
import { isPgEnabled, pgExec } from "../db/postgres";

export interface ExecutionRecordInput {
  userId: string | null;
  agentId: string | null;
  slug: string;
  side: string;
  direction: "YES" | "NO";
  source: "autopilot" | "manual";
  amount: number;
  executedAt: number;
  status: string;
  orderId?: string | null;
  fillPrice?: number | null;
  pnl?: number | null;
  resolutionDate?: string | null;
}

export async function insertExecutionRecord(input: ExecutionRecordInput): Promise<void> {
  const db = getDb();
  db.prepare(
    `INSERT INTO executions (
       user_id, agent_id, slug, side, direction, source, amount, executed_at, status, order_id, fill_price, pnl, resolution_date
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    input.resolutionDate ?? null
  );

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO executions (
         user_id, agent_id, slug, side, direction, source, amount, executed_at, status, order_id, fill_price, pnl, resolution_date
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
      ]
    );
  }
}
