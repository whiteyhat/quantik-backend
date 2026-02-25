import { getDb } from "./schema";

// ── Pipeline Runs ──────────────────────────────────────────────

export interface PipelineRun {
  id: string;
  market_slug: string;
  market_question: string;
  created_at: number;
  completed_at: number | null;
  decision: string | null;
  confidence: number | null;
  aura_output: string | null;
  flux_output: string | null;
  oracle_output: string | null;
  edge_output: string | null;
  sigma_output: string | null;
  clause_output: string | null;
  lucifer_output: string | null;
}

export function insertPipelineRun(run: PipelineRun): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO pipeline_runs
      (id, market_slug, market_question, created_at, completed_at, decision, confidence,
       aura_output, flux_output, oracle_output, edge_output, sigma_output, clause_output, lucifer_output)
    VALUES
      (@id, @market_slug, @market_question, @created_at, @completed_at, @decision, @confidence,
       @aura_output, @flux_output, @oracle_output, @edge_output, @sigma_output, @clause_output, @lucifer_output)
  `).run(run);
}

export function updatePipelineRun(id: string, fields: Partial<PipelineRun>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, val] of Object.entries(fields)) {
    if (key === "id") continue;
    sets.push(`${key} = @${key}`);
    values[key] = val;
  }

  if (sets.length === 0) return;
  db.prepare(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE id = @id`).run(values);
}

export function getPipelineHistory(limit = 20): PipelineRun[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as PipelineRun[];
}

// ── Trades ─────────────────────────────────────────────────────

export interface Trade {
  id: string;
  order_id: string | null;
  market_slug: string;
  direction: string;
  size: number;
  price: number;
  net_ev: number | null;
  ev_grade: string | null;
  status: string;
  created_at: number;
  pipeline_run_id: string | null;
}

export function insertTrade(trade: Trade): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO trades
      (id, order_id, market_slug, direction, size, price, net_ev, ev_grade, status, created_at, pipeline_run_id)
    VALUES
      (@id, @order_id, @market_slug, @direction, @size, @price, @net_ev, @ev_grade, @status, @created_at, @pipeline_run_id)
  `).run(trade);
}

// ── Settings ───────────────────────────────────────────────────

export interface Settings {
  id: number;
  paper_mode: boolean;
}

interface SettingsRow {
  id: number;
  paper_mode: number;
}

export function getSettings(): Settings {
  const db = getDb();
  const row = db
    .prepare<[], SettingsRow>("SELECT * FROM settings WHERE id = 1")
    .get();
  if (!row) {
    return { id: 1, paper_mode: false };
  }
  return { id: row.id, paper_mode: row.paper_mode === 1 };
}

export function setPaperMode(enabled: boolean): Settings {
  const db = getDb();
  db.prepare("UPDATE settings SET paper_mode = ? WHERE id = 1").run(
    enabled ? 1 : 0
  );
  return getSettings();
}

// ── Paper Trades ───────────────────────────────────────────────

export interface PaperTrade {
  id: string;
  market_id: string;
  side: string;
  size: number;
  price: number;
  status: string;
  created_at: number;
  settled_at: number | null;
  pnl: number | null;
}

export function insertPaperTrade(trade: PaperTrade): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO paper_trades
      (id, market_id, side, size, price, status, created_at, settled_at, pnl)
    VALUES
      (@id, @market_id, @side, @size, @price, @status, @created_at, @settled_at, @pnl)
  `).run(trade);
}
