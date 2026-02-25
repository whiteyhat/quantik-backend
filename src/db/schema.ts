import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(__dirname, "..", "..", "quantik.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      market_slug TEXT,
      market_question TEXT,
      created_at INTEGER,
      completed_at INTEGER,
      decision TEXT,
      confidence REAL,
      aura_output JSON,
      flux_output JSON,
      oracle_output JSON,
      edge_output JSON,
      sigma_output JSON,
      clause_output JSON,
      lucifer_output JSON
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      market_slug TEXT,
      direction TEXT,
      size REAL,
      price REAL,
      net_ev REAL,
      ev_grade TEXT,
      status TEXT,
      created_at INTEGER,
      pipeline_run_id TEXT
    );

    -- ── Risk Configuration ─────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS risk_configurations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_thresholds (
      id TEXT PRIMARY KEY,
      risk_configuration_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      agent_status TEXT NOT NULL DEFAULT 'active',
      var_threshold REAL NOT NULL DEFAULT 0.05,
      auto_exec_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (risk_configuration_id) REFERENCES risk_configurations(id)
    );

    CREATE TABLE IF NOT EXISTS global_circuit_breakers (
      id TEXT PRIMARY KEY,
      risk_configuration_id TEXT NOT NULL,
      panic_mode_enabled INTEGER NOT NULL DEFAULT 0,
      drawdown_limit_pct REAL NOT NULL DEFAULT 0.15,
      max_position_size_pct REAL NOT NULL DEFAULT 5.0,
      kelly_fraction_multiplier REAL NOT NULL DEFAULT 0.25,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (risk_configuration_id) REFERENCES risk_configurations(id)
    );

    -- ── Panic Mode & Liquidation ───────────────────────────────────

    CREATE TABLE IF NOT EXISTS panic_mode_events (
      id TEXT PRIMARY KEY,
      request_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pending_orders_count INTEGER NOT NULL DEFAULT 0,
      active_positions_count INTEGER NOT NULL DEFAULT 0,
      estimated_total_value REAL NOT NULL DEFAULT 0,
      initiated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS liquidation_reports (
      id TEXT PRIMARY KEY,
      report_code TEXT NOT NULL,
      panic_mode_event_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      completion_timestamp INTEGER,
      total_realized_value REAL,
      slippage_pct REAL,
      gas_execution_cost REAL,
      recovery_status TEXT,
      FOREIGN KEY (panic_mode_event_id) REFERENCES panic_mode_events(id)
    );

    CREATE TABLE IF NOT EXISTS liquidation_line_items (
      id TEXT PRIMARY KEY,
      liquidation_report_id TEXT NOT NULL,
      asset_symbol TEXT NOT NULL,
      asset_label TEXT NOT NULL,
      execution_price REAL NOT NULL,
      trigger_price REAL NOT NULL,
      size REAL NOT NULL,
      size_unit TEXT NOT NULL DEFAULT 'shares',
      pnl_impact REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (liquidation_report_id) REFERENCES liquidation_reports(id)
    );

    -- ── Application Settings ───────────────────────────────────────

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      paper_mode INTEGER NOT NULL DEFAULT 0
    );

    -- ── Paper Trades ───────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL,
      size REAL NOT NULL,
      price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      pnl REAL
    );
  `);

  // Migration: fix max_position_size_pct rows seeded with legacy percent scale (5.0 = 500%)
  // Normalise any value > 1.0 to 0–1 scale.
  db.prepare(
    `UPDATE global_circuit_breakers SET max_position_size_pct = max_position_size_pct / 100.0 WHERE max_position_size_pct > 1.0`
  ).run();

  // Seed a default active risk configuration if none exists
  const existing = db
    .prepare("SELECT id FROM risk_configurations WHERE is_active = 1 LIMIT 1")
    .get();

  if (!existing) {
    const now = Date.now();
    const configId = "rc-default-001";

    db.prepare(`
      INSERT OR IGNORE INTO risk_configurations (id, user_id, version, is_active, created_at, updated_at)
      VALUES (?, 'system', 1, 1, ?, ?)
    `).run(configId, now, now);

    const agents = [
      { name: "aura",   status: "active",   var: 0.04, autoExec: 0 },
      { name: "flux",   status: "active",   var: 0.05, autoExec: 0 },
      { name: "oracle", status: "active",   var: 0.06, autoExec: 1 },
      { name: "edge",   status: "active",   var: 0.05, autoExec: 1 },
      { name: "sigma",  status: "active",   var: 0.07, autoExec: 0 },
      { name: "clause", status: "active",   var: 0.04, autoExec: 0 },
      { name: "lucifer",status: "sentinel", var: 0.03, autoExec: 0 },
    ];

    const insertThreshold = db.prepare(`
      INSERT OR IGNORE INTO agent_thresholds
        (id, risk_configuration_id, agent_name, agent_status, var_threshold, auto_exec_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const agent of agents) {
      insertThreshold.run(
        `at-${agent.name}-001`,
        configId,
        agent.name,
        agent.status,
        agent.var,
        agent.autoExec,
        now,
        now
      );
    }

    db.prepare(`
      INSERT OR IGNORE INTO global_circuit_breakers
        (id, risk_configuration_id, panic_mode_enabled, drawdown_limit_pct, max_position_size_pct, kelly_fraction_multiplier, created_at, updated_at)
      VALUES ('gcb-default-001', ?, 0, 0.15, 0.10, 0.25, ?, ?)
    `).run(configId, now, now);
  }

  // Seed default settings row (id=1) if it doesn't exist
  db.prepare(`INSERT OR IGNORE INTO settings (id, paper_mode) VALUES (1, 0)`).run();
}
