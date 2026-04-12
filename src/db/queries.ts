import { getDb } from "./schema";
import { isPgEnabled, pgQuery, pgQueryOne, pgExec } from "./postgres";

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

export interface PipelineRunStep {
  id: string;
  run_id: string;
  step_order: number;
  step: string;
  agent: string | null;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  data: string | null;
  error: string | null;
  created_at: number;
}

export async function insertPipelineRun(run: PipelineRun): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO pipeline_runs
        (id, market_slug, market_question, created_at, completed_at, decision, confidence,
         aura_output, flux_output, oracle_output, edge_output, sigma_output, clause_output, lucifer_output)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [run.id, run.market_slug, run.market_question, run.created_at, run.completed_at, run.decision, run.confidence,
       run.aura_output, run.flux_output, run.oracle_output, run.edge_output, run.sigma_output, run.clause_output, run.lucifer_output]
    );
    return;
  }
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

export async function updatePipelineRun(id: string, fields: Partial<PipelineRun>): Promise<void> {
  const entries = Object.entries(fields).filter(([key]) => key !== "id");
  if (entries.length === 0) return;

  if (isPgEnabled()) {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    for (const [key, val] of entries) {
      sets.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }
    values.push(id);
    await pgExec(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE id = $${idx}`, values);
    return;
  }

  const db = getDb();
  const sets: string[] = [];
  const values: Record<string, unknown> = { id };
  for (const [key, val] of entries) {
    sets.push(`${key} = @${key}`);
    values[key] = val;
  }
  db.prepare(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE id = @id`).run(values);
}

export async function getPipelineHistory(limit = 20): Promise<PipelineRun[]> {
  if (isPgEnabled()) {
    return pgQuery<PipelineRun>(
      "SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
  }
  const db = getDb();
  return db
    .prepare("SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as PipelineRun[];
}

export async function getPipelineRunById(id: string): Promise<PipelineRun | null> {
  if (isPgEnabled()) {
    return pgQueryOne<PipelineRun>(
      "SELECT * FROM pipeline_runs WHERE id = $1 LIMIT 1",
      [id]
    );
  }
  const db = getDb();
  return (
    db.prepare("SELECT * FROM pipeline_runs WHERE id = ? LIMIT 1").get(id) as
      | PipelineRun
      | undefined
  ) ?? null;
}

export async function insertPipelineRunStep(step: PipelineRunStep): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO pipeline_run_steps
        (id, run_id, step_order, step, agent, status, started_at, completed_at, data, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [step.id, step.run_id, step.step_order, step.step, step.agent, step.status,
       step.started_at, step.completed_at, step.data, step.error, step.created_at]
    );
    return;
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO pipeline_run_steps
      (id, run_id, step_order, step, agent, status, started_at, completed_at, data, error, created_at)
    VALUES
      (@id, @run_id, @step_order, @step, @agent, @status, @started_at, @completed_at, @data, @error, @created_at)
  `).run(step);
}

export async function updatePipelineRunStep(id: string, fields: Partial<PipelineRunStep>): Promise<void> {
  const entries = Object.entries(fields).filter(([key]) => key !== "id");
  if (entries.length === 0) return;

  if (isPgEnabled()) {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    for (const [key, val] of entries) {
      sets.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }
    values.push(id);
    await pgExec(`UPDATE pipeline_run_steps SET ${sets.join(", ")} WHERE id = $${idx}`, values);
    return;
  }

  const db = getDb();
  const sets: string[] = [];
  const values: Record<string, unknown> = { id };
  for (const [key, val] of entries) {
    sets.push(`${key} = @${key}`);
    values[key] = val;
  }
  db.prepare(`UPDATE pipeline_run_steps SET ${sets.join(", ")} WHERE id = @id`).run(values);
}

export async function getPipelineRunSteps(runId: string): Promise<PipelineRunStep[]> {
  if (isPgEnabled()) {
    return pgQuery<PipelineRunStep>(
      "SELECT * FROM pipeline_run_steps WHERE run_id = $1 ORDER BY step_order ASC, created_at ASC",
      [runId]
    );
  }
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM pipeline_run_steps WHERE run_id = ? ORDER BY step_order ASC, created_at ASC"
    )
    .all(runId) as PipelineRunStep[];
}

// ── Trades ─────────────────────────────────────────────────────

export interface Trade {
  id: string;
  order_id: string | null;
  market_slug: string;
  direction: string;
  source: "autopilot" | "manual";
  size: number;
  price: number;
  net_ev: number | null;
  ev_grade: string | null;
  status: string;
  created_at: number;
  pipeline_run_id: string | null;
  chain_mode?: "polymarket" | "kraken" | null;
  protocol?: string | null;
  action?: string | null;
  asset_pair?: string | null;
  tx_hash?: string | null;
}

export async function insertTrade(trade: Trade): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO trades
        (id, order_id, market_slug, direction, source, size, price, net_ev, ev_grade, status, created_at, pipeline_run_id, chain_mode, protocol, action, asset_pair, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO NOTHING`,
      [trade.id, trade.order_id, trade.market_slug, trade.direction, trade.source, trade.size,
       trade.price, trade.net_ev, trade.ev_grade, trade.status, trade.created_at, trade.pipeline_run_id,
       trade.chain_mode ?? null, trade.protocol ?? null, trade.action ?? null, trade.asset_pair ?? null, trade.tx_hash ?? null]
    );
    return;
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO trades
      (id, order_id, market_slug, direction, source, size, price, net_ev, ev_grade, status, created_at, pipeline_run_id, chain_mode, protocol, action, asset_pair, tx_hash)
    VALUES
      (@id, @order_id, @market_slug, @direction, @source, @size, @price, @net_ev, @ev_grade, @status, @created_at, @pipeline_run_id, @chain_mode, @protocol, @action, @asset_pair, @tx_hash)
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

export async function getSettings(): Promise<Settings> {
  if (isPgEnabled()) {
    const row = await pgQueryOne<SettingsRow>("SELECT * FROM settings WHERE id = 1");
    if (!row) return { id: 1, paper_mode: false };
    return { id: row.id, paper_mode: row.paper_mode === 1 };
  }
  const db = getDb();
  const row = db
    .prepare<[], SettingsRow>("SELECT * FROM settings WHERE id = 1")
    .get();
  if (!row) {
    return { id: 1, paper_mode: false };
  }
  return { id: row.id, paper_mode: row.paper_mode === 1 };
}

export async function setPaperMode(enabled: boolean): Promise<Settings> {
  if (isPgEnabled()) {
    await pgExec("UPDATE settings SET paper_mode = $1 WHERE id = 1", [enabled ? 1 : 0]);
    return getSettings();
  }
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

export async function insertPaperTrade(trade: PaperTrade): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO paper_trades
        (id, market_id, side, size, price, status, created_at, settled_at, pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [trade.id, trade.market_id, trade.side, trade.size, trade.price, trade.status,
       trade.created_at, trade.settled_at, trade.pnl]
    );
    return;
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO paper_trades
      (id, market_id, side, size, price, status, created_at, settled_at, pnl)
    VALUES
      (@id, @market_id, @side, @size, @price, @status, @created_at, @settled_at, @pnl)
  `).run(trade);
}
