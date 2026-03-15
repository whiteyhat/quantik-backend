import Database from "better-sqlite3";
import path from "path";

// Use persistent volume on Railway (/data) — falls back to project root locally
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "quantik.db")
  : path.join(__dirname, "..", "..", "quantik.db");

let db: Database.Database;

/** Safely add a column — logs unexpected errors instead of swallowing them */
function addColumn(db: Database.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate column")) return; // already exists — OK
    console.error(`[migration] WARN: ${sql} — ${msg}`);
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const instance = new Database(DB_PATH);
    instance.pragma("journal_mode = WAL");
    instance.pragma("foreign_keys = ON");
    migrate(instance);
    db = instance;
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

    CREATE TABLE IF NOT EXISTS pipeline_run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      step TEXT NOT NULL,
      agent TEXT,
      status TEXT NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      data JSON,
      error TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_run_order
      ON pipeline_run_steps(run_id, step_order, created_at);

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      market_slug TEXT,
      direction TEXT,
      source TEXT,
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
      reason TEXT,
      pending_orders_count INTEGER NOT NULL DEFAULT 0,
      active_positions_count INTEGER NOT NULL DEFAULT 0,
      estimated_total_value REAL NOT NULL DEFAULT 0,
      cooldown_until INTEGER,
      rearmed_at INTEGER,
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

    CREATE TABLE IF NOT EXISTS settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ── Operator Inbox ───────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      category TEXT,
      timestamp INTEGER NOT NULL,
      read_at INTEGER,
      action_label TEXT,
      action_href TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_time
      ON notifications(user_id, timestamp DESC);

    -- ── Market Discovery ─────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS watchlists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      question TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_watchlists_user_time
      ON watchlists(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS market_alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      question TEXT,
      direction TEXT NOT NULL,
      threshold REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_state TEXT,
      last_triggered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_market_alerts_user_time
      ON market_alerts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_market_alerts_slug_enabled
      ON market_alerts(slug, enabled);

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

    -- ── Paper Orders (L4 Execution Engine) ────────────────────────

    CREATE TABLE IF NOT EXISTS paper_orders (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      direction TEXT NOT NULL,
      size REAL NOT NULL,
      entry_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      filled_at INTEGER
    );

    -- ── Markets Cache (stale fallback) ────────────────────────────

    CREATE TABLE IF NOT EXISTS markets_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    );

    -- ── Orchestrator Candidates ─────────────────────────────────

    CREATE TABLE IF NOT EXISTS orchestrator_candidates (
      slug TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      question TEXT NOT NULL,
      opportunity_score REAL NOT NULL,
      volume_score REAL,
      price_move_score REAL,
      liquidity_score REAL,
      recency_score REAL,
      triggers TEXT,
      scored_at INTEGER NOT NULL,
      pipeline_triggered INTEGER DEFAULT 0,
      pipeline_triggered_at INTEGER
    );

    -- ── Orchestrator Scan State (persisted across restarts) ─────

    CREATE TABLE IF NOT EXISTS orchestrator_scan_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_at INTEGER NOT NULL DEFAULT 0,
      markets_scanned INTEGER NOT NULL DEFAULT 0,
      candidates_found INTEGER NOT NULL DEFAULT 0,
      scan_cycle INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO orchestrator_scan_state (id) VALUES (1);

    -- ── Market Volume Snapshots (spike detection) ─────────────

    CREATE TABLE IF NOT EXISTS market_volume_snapshots (
      slug TEXT PRIMARY KEY,
      volume REAL NOT NULL,
      snapshot_at INTEGER NOT NULL
    );

    -- ── Market Price Snapshots (1hr delta computation) ──────────

    CREATE TABLE IF NOT EXISTS market_price_snapshots (
      slug TEXT NOT NULL,
      yes_price REAL NOT NULL,
      snapshot_at INTEGER NOT NULL,
      PRIMARY KEY (slug, snapshot_at)
    );

    -- ── Aura Results ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS aura_results (
      slug TEXT NOT NULL,
      scored_at INTEGER NOT NULL,
      sentiment_delta REAL,
      shift_detected INTEGER,
      shift_direction TEXT,
      shift_velocity REAL,
      shift_trend TEXT,
      shift_persistence INTEGER,
      twitter_sentiment REAL,
      twitter_volume_delta REAL,
      telegram_bias TEXT,
      breaking_news INTEGER,
      news_headlines TEXT,
      search_trend_spike INTEGER,
      search_trend_value REAL,
      whale_pos_yes_pct REAL,
      whale_positioning TEXT,
      echo_chamber_risk REAL,
      data_sufficiency REAL,
      confidence REAL,
      sources_used TEXT,
      source_status TEXT,
      raw_data TEXT,
      PRIMARY KEY (slug, scored_at)
    );

  `);

  // Migration: add is_mock column to aura_results
  addColumn(db, "ALTER TABLE aura_results ADD COLUMN is_mock INTEGER NOT NULL DEFAULT 0");

  db.exec(`
    -- ── Oracle Results ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS oracle_results (
      market_slug TEXT PRIMARY KEY,
      scored_at INTEGER NOT NULL,
      raw_prob REAL NOT NULL,
      calibrated_prob REAL NOT NULL,
      market_implied REAL NOT NULL,
      confidence REAL NOT NULL,
      data_sufficiency REAL NOT NULL,
      bull_case TEXT NOT NULL,
      bear_case TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      cross_market_signals JSON NOT NULL,
      cross_market_divergence INTEGER NOT NULL,
      arb_detected INTEGER NOT NULL,
      arb_details TEXT,
      whale_signal_p_yes REAL,
      days_to_resolution INTEGER NOT NULL,
      ensemble_variance REAL,
      longshot_adjusted INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edge_results (
      marketSlug TEXT PRIMARY KEY,
      scoredAt INTEGER NOT NULL,
      gross_edge REAL NOT NULL,
      net_edge REAL NOT NULL,
      ev_grade TEXT NOT NULL,
      net_ev REAL NOT NULL,
      kelly_recommended REAL NOT NULL,
      fractional_kelly REAL NOT NULL,
      position_size REAL NOT NULL,
      kelly_multiplier REAL NOT NULL,
      time_decay_watch INTEGER NOT NULL,
      arb_opportunities JSON NOT NULL,
      correlation_penalty REAL NOT NULL,
      corr_blocked INTEGER NOT NULL,
      direction TEXT NOT NULL,
      confidence REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clause_results (
      marketSlug TEXT PRIMARY KEY,
      scoredAt INTEGER NOT NULL,
      ambiguityScore REAL NOT NULL,
      riskLevel TEXT NOT NULL,
      veto INTEGER NOT NULL,
      ambiguityFlags JSON NOT NULL,
      technicality_risks JSON NOT NULL,
      resolutionCriteria TEXT NOT NULL,
      disputeHistory INTEGER NOT NULL,
      urgent INTEGER NOT NULL,
      confidence REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flux_results (
      marketSlug TEXT PRIMARY KEY,
      scoredAt INTEGER NOT NULL,
      liquidity_grade TEXT NOT NULL,
      spread REAL NOT NULL,
      slippage_10 REAL NOT NULL,
      slippage_50 REAL NOT NULL,
      whale_detected INTEGER NOT NULL,
      whale_signals INTEGER NOT NULL,
      depth_imbalance REAL NOT NULL,
      depth_yes_pct REAL NOT NULL,
      grade_degrading INTEGER NOT NULL,
      soft_veto INTEGER NOT NULL,
      total_liquidity REAL NOT NULL,
      confidence REAL NOT NULL
    );

    -- ── Resolutions (L5 Monitoring) ────────────────────────────────

    CREATE TABLE IF NOT EXISTS resolutions (
      id TEXT PRIMARY KEY,
      pipeline_run_id TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      predicted REAL NOT NULL,
      outcome INTEGER NOT NULL,
      brier_score REAL NOT NULL,
      signal_type TEXT,
      resolved_at INTEGER NOT NULL,
      FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
    );

    CREATE TABLE IF NOT EXISTS research_notes (
      marketSlug TEXT PRIMARY KEY,
      scoredAt INTEGER NOT NULL,
      composite_prob REAL NOT NULL,
      confidence REAL NOT NULL,
      confidence_interval JSON NOT NULL,
      consistency_score REAL NOT NULL,
      recommended_direction TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      skip_reason TEXT,
      thesis TEXT NOT NULL,
      bear_case TEXT NOT NULL,
      bull_case TEXT NOT NULL,
      agent_weights JSON NOT NULL,
      lucifer_da_score REAL,
      auto_synthesized INTEGER NOT NULL
    );
  `);

  // Migration: add signal_state column to pipeline_runs
  const cols = db.prepare("PRAGMA table_info(pipeline_runs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "signal_state")) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN signal_state TEXT");
  }
  if (!cols.some((c) => c.name === "alert_sent")) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN alert_sent INTEGER DEFAULT 0");
  }

  // Migration: resolution tracking columns on oracle_results
  const oracleCols = db.prepare("PRAGMA table_info(oracle_results)").all() as Array<{ name: string }>;
  if (!oracleCols.some((c) => c.name === "resolved_correctly")) {
    db.exec("ALTER TABLE oracle_results ADD COLUMN resolved_correctly INTEGER DEFAULT NULL");
  }
  if (!oracleCols.some((c) => c.name === "resolved_at")) {
    db.exec("ALTER TABLE oracle_results ADD COLUMN resolved_at INTEGER DEFAULT NULL");
  }

  // Migration: unique index on resolutions(pipeline_run_id, market_slug)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_resolutions_run_slug ON resolutions(pipeline_run_id, market_slug)`);

  // Migration: resolution backfill log table
  db.exec(`CREATE TABLE IF NOT EXISTS resolution_backfill_log (
    slug TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    backfilled_at INTEGER NOT NULL,
    positions_found INTEGER NOT NULL DEFAULT 0
  )`);

  // ── Scanner results (Phase 1 autopilot) ───────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS scanner_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      scanned_at INTEGER NOT NULL,
      sigma_confidence REAL,
      kelly_fraction REAL,
      recommendation TEXT,
      probability REAL,
      alert_sent INTEGER DEFAULT 0,
      pipeline_result TEXT,
      UNIQUE(slug, scanned_at)
    );
    CREATE INDEX IF NOT EXISTS idx_scanner_slug_time ON scanner_results(slug, scanned_at DESC);
  `);

  // Autopilot execution log
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      agent_id TEXT,
      slug TEXT NOT NULL,
      side TEXT NOT NULL,
      direction TEXT,
      source TEXT,
      amount REAL NOT NULL,
      executed_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT,
      fill_price REAL,
      pnl REAL DEFAULT NULL,
      resolution_date TEXT,
      closed_at INTEGER,
      updated_at INTEGER,
      pipeline_run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_executions_slug_time ON executions(slug, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_date ON executions(executed_at DESC);
  `);

  addColumn(db, "ALTER TABLE executions ADD COLUMN user_id TEXT");
  addColumn(db, "ALTER TABLE executions ADD COLUMN agent_id TEXT");
  addColumn(db, "ALTER TABLE executions ADD COLUMN direction TEXT");
  addColumn(db, "ALTER TABLE executions ADD COLUMN source TEXT");
  addColumn(db, "ALTER TABLE executions ADD COLUMN resolution_date TEXT");
  addColumn(db, "ALTER TABLE executions ADD COLUMN closed_at INTEGER");
  addColumn(db, "ALTER TABLE executions ADD COLUMN updated_at INTEGER");
  addColumn(db, "ALTER TABLE executions ADD COLUMN pipeline_run_id TEXT");
  addColumn(db, "ALTER TABLE trades ADD COLUMN source TEXT");
  addColumn(db, "ALTER TABLE panic_mode_events ADD COLUMN reason TEXT");
  addColumn(db, "ALTER TABLE panic_mode_events ADD COLUMN cooldown_until INTEGER");
  addColumn(db, "ALTER TABLE panic_mode_events ADD COLUMN rearmed_at INTEGER");

  // Create indexes after ensuring columns exist (addColumn above)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_user ON executions(user_id, executed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_agent ON executions(agent_id, executed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_agent_slug_time ON executions(agent_id, slug, executed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_agent_source_time ON executions(agent_id, source, executed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_pipeline_run ON executions(pipeline_run_id, executed_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_policies (
      agent_id TEXT PRIMARY KEY,
      cadence_minutes INTEGER,
      cooldown_minutes INTEGER,
      max_trades_per_day INTEGER,
      max_bet_usdc REAL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autopilot_decisions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT,
      slug TEXT NOT NULL,
      direction TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      size_usdc REAL,
      scanned_at INTEGER NOT NULL,
      policy_snapshot TEXT NOT NULL,
      signal_snapshot TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_agent_time ON autopilot_decisions(agent_id, scanned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_slug_time ON autopilot_decisions(slug, scanned_at DESC);
  `);

  db.exec(`
    UPDATE executions
       SET source = 'autopilot'
     WHERE source IS NULL
       AND agent_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM autopilot_decisions d
          WHERE d.agent_id = executions.agent_id
            AND d.slug = executions.slug
            AND d.decision = 'executed'
            AND ABS(d.scanned_at - executions.executed_at) <= 1800000
       )
  `);

  db.exec(`
    UPDATE executions
       SET updated_at = COALESCE(updated_at, executed_at)
     WHERE updated_at IS NULL
  `);

  db.exec(`
    UPDATE executions
       SET pipeline_run_id = (
         SELECT t.pipeline_run_id
           FROM trades t
          WHERE t.order_id = executions.order_id
            AND t.pipeline_run_id IS NOT NULL
          ORDER BY t.created_at DESC
          LIMIT 1
       )
     WHERE pipeline_run_id IS NULL
       AND order_id IS NOT NULL
  `);

  // Legacy migration cleanup: executions must allow multiple rows per slug/day.
  try {
    db.exec(`DROP INDEX IF EXISTS ux_executions_slug_day`);
  } catch (e) { console.log("[schema] executions index:", e); }

  try {
    db.exec(`
      UPDATE executions
      SET user_id = COALESCE(user_id, (
            SELECT users.id
            FROM users
            JOIN agents ON agents.id = users.agent_id
            LIMIT 1
          )),
          agent_id = COALESCE(agent_id, (
            SELECT agents.id
            FROM agents
            JOIN users ON users.agent_id = agents.id
            LIMIT 1
          ))
      WHERE user_id IS NULL OR agent_id IS NULL
    `);
  } catch {}

  // Add execution columns to scanner_results if missing
  addColumn(db, "ALTER TABLE scanner_results ADD COLUMN execution_status TEXT DEFAULT NULL");
  addColumn(db, "ALTER TABLE scanner_results ADD COLUMN execution_id INTEGER DEFAULT NULL");

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

  // ── Users (Clerk-linked accounts) ──────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      clerk_id TEXT UNIQUE NOT NULL,
      email TEXT,
      agent_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id);
  `);

  // ── Trading Agents (Agent Factory) ──────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'inactive',
      name TEXT NOT NULL,
      avatar_emoji TEXT NOT NULL,
      animal_type TEXT,
      avatar_image TEXT,
      personality TEXT NOT NULL,
      decision_style TEXT NOT NULL,
      trading_instinct TEXT NOT NULL,
      time_patience TEXT NOT NULL,
      profit_dream TEXT NOT NULL,
      money_approach TEXT NOT NULL,
      protection_mindset TEXT NOT NULL,
      leverage_vibe TEXT NOT NULL,
      market_sense TEXT NOT NULL,
      asset_love TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      wallet_address TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deployed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  `);

  // Migration: add user_id to agents table
  addColumn(db, "ALTER TABLE agents ADD COLUMN user_id TEXT");

  // Migration: BYO agent columns
  addColumn(db, "ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'created'");
  addColumn(db, "ALTER TABLE agents ADD COLUMN endpoint_url TEXT");
  addColumn(db, "ALTER TABLE agents ADD COLUMN agent_url TEXT");
  addColumn(db, "ALTER TABLE agents ADD COLUMN connection_status TEXT DEFAULT 'pending'");
  addColumn(db, "ALTER TABLE agents ADD COLUMN last_heartbeat INTEGER");
  addColumn(db, "ALTER TABLE agents ADD COLUMN description TEXT");
  addColumn(db, "ALTER TABLE agents ADD COLUMN webhook_secret TEXT");
  addColumn(db, "ALTER TABLE agents ADD COLUMN webhook_events TEXT DEFAULT '[\"*\"]'");
  addColumn(db, "ALTER TABLE agents ADD COLUMN autopilot_enabled INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "ALTER TABLE agents ADD COLUMN autopilot_updated_at INTEGER");

  // Migration: Polymarket wallet preparation (server-side encrypted key storage)
  addColumn(db, "ALTER TABLE agents ADD COLUMN encrypted_private_key TEXT");
  addColumn(db, "ALTER TABLE agents ADD COLUMN encrypted_seed_phrase TEXT");
  addColumn(db, "ALTER TABLE agents ADD COLUMN polymarket_ready INTEGER DEFAULT 0");
  addColumn(db, "ALTER TABLE agents ADD COLUMN polymarket_status TEXT DEFAULT 'pending_funding'");

  // ── API Keys (BYO agent authentication) ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '["read","trade","analysis","config"]',
      rate_limit_tier TEXT NOT NULL DEFAULT 'standard',
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      last_used_at INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys(agent_id);
  `);

  // ── BYO Request Log (audit trail for API key usage) ────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS byo_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_byo_log_agent_time ON byo_request_log(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_byo_log_time ON byo_request_log(created_at DESC);
  `);

  // ── Webhook Delivery Log (audit trail for webhook events) ──────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_delivery_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      latency_ms INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_log_agent_time ON webhook_delivery_log(agent_id, created_at DESC);
  `);

  // ── BYO Onboarding Sessions ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS byo_onboarding_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER,
      agent_id TEXT,
      identity_name TEXT,
      identity_description TEXT,
      identity_avatar TEXT,
      agent_url TEXT,
      endpoint_url TEXT,
      webhook_events TEXT DEFAULT '["*"]',
      encrypted_wallet_bundle TEXT,
      wallet_downloaded_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_byo_onboarding_user ON byo_onboarding_sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_byo_onboarding_status ON byo_onboarding_sessions(status, expires_at);
  `);
  addColumn(db, "ALTER TABLE byo_onboarding_sessions ADD COLUMN encrypted_wallet_bundle TEXT");
  addColumn(db, "ALTER TABLE byo_onboarding_sessions ADD COLUMN wallet_downloaded_at INTEGER");

  // ── Chat History (persistent across sessions) ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at ASC);
  `);

  // ── Versions / Changelog ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      released_at TEXT NOT NULL,
      features TEXT NOT NULL DEFAULT '[]',
      fixes TEXT NOT NULL DEFAULT '[]',
      highlight TEXT
    );
  `);

  // Ensure locale columns exist (safe no-op on fresh dbs after CREATE TABLE above)
  addColumn(db, "ALTER TABLE versions ADD COLUMN highlight_es TEXT");
  addColumn(db, "ALTER TABLE versions ADD COLUMN highlight_fr TEXT");
  addColumn(db, "ALTER TABLE versions ADD COLUMN highlight_de TEXT");
  addColumn(db, "ALTER TABLE versions ADD COLUMN features_es TEXT");
  addColumn(db, "ALTER TABLE versions ADD COLUMN features_fr TEXT");
  addColumn(db, "ALTER TABLE versions ADD COLUMN features_de TEXT");
  addColumn(db, "ALTER TABLE versions ADD COLUMN fixes_es TEXT");
  addColumn(db, "ALTER TABLE versions ADD COLUMN fixes_fr TEXT");
  addColumn(db, "ALTER TABLE versions ADD COLUMN fixes_de TEXT");

  // Clean up stale version entries that were renumbered in the v1.x migration
  db.exec(`DELETE FROM versions WHERE version IN ('v0.9.0','v0.10.0','v0.11.0')`);

  // Seed all versions from the centralized releases-data (single source of truth)
  const { RELEASES } = require("./releases-data") as typeof import("./releases-data");
  const upsertVersion = db.prepare(`
    INSERT OR REPLACE INTO versions
      (version, released_at, features, fixes, highlight,
       highlight_es, highlight_fr, highlight_de,
       features_es, features_fr, features_de,
       fixes_es, fixes_fr, fixes_de)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of RELEASES) {
    upsertVersion.run(
      r.version, r.released_at,
      JSON.stringify(r.features.en), JSON.stringify(r.fixes.en), r.highlight.en,
      r.highlight.es, r.highlight.fr, r.highlight.de,
      JSON.stringify(r.features.es), JSON.stringify(r.features.fr), JSON.stringify(r.features.de),
      JSON.stringify(r.fixes.es), JSON.stringify(r.fixes.fr), JSON.stringify(r.fixes.de),
    );
  }
}
