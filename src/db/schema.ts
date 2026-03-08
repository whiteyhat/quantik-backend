import Database from "better-sqlite3";
import path from "path";

// Use persistent volume on Railway (/data) — falls back to project root locally
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "quantik.db")
  : path.join(__dirname, "..", "..", "quantik.db");

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

    CREATE TABLE IF NOT EXISTS settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
  try { db.exec("ALTER TABLE aura_results ADD COLUMN is_mock INTEGER NOT NULL DEFAULT 0"); } catch {}

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
      slug TEXT NOT NULL,
      side TEXT NOT NULL,
      amount REAL NOT NULL,
      executed_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT,
      fill_price REAL,
      pnl REAL DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_executions_slug_time ON executions(slug, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_date ON executions(executed_at DESC);
  `);

  // Dedup executions + unique index per slug per day
  try {
    db.exec(`DELETE FROM executions WHERE rowid NOT IN (SELECT MIN(rowid) FROM executions GROUP BY slug, DATE(executed_at/1000, 'unixepoch'))`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_executions_slug_day ON executions (slug, DATE(executed_at/1000, 'unixepoch'))`);
  } catch (e) { console.log("[schema] executions index:", e); }

  // Add execution columns to scanner_results if missing
  try { db.exec("ALTER TABLE scanner_results ADD COLUMN execution_status TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE scanner_results ADD COLUMN execution_id INTEGER DEFAULT NULL"); } catch {}

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
  try { db.exec("ALTER TABLE agents ADD COLUMN user_id TEXT"); } catch {}

  // Migration: BYO agent columns
  try { db.exec("ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'created'"); } catch {}
  try { db.exec("ALTER TABLE agents ADD COLUMN endpoint_url TEXT"); } catch {}
  try { db.exec("ALTER TABLE agents ADD COLUMN connection_status TEXT DEFAULT 'pending'"); } catch {}
  try { db.exec("ALTER TABLE agents ADD COLUMN last_heartbeat INTEGER"); } catch {}
  try { db.exec("ALTER TABLE agents ADD COLUMN description TEXT"); } catch {}
  try { db.exec("ALTER TABLE agents ADD COLUMN webhook_secret TEXT"); } catch {}
  try { db.exec("ALTER TABLE agents ADD COLUMN webhook_events TEXT DEFAULT '[\"*\"]'"); } catch {}

  // ── API Keys (BYO agent authentication) ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '["read","trade","analysis"]',
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

  const insertVersion = db.prepare(`
    INSERT OR IGNORE INTO versions (version, released_at, features, fixes, highlight)
    VALUES (?, ?, ?, ?, ?)
  `);

  const VERSION_SEED = [
    {
      version: "v0.0.1", released_at: "2026-02-27", highlight: "Project initialized",
      features: ["Quantik autonomous Polymarket trading platform","Layer 0–5 architecture (data → signal → execution → monitoring)","Next.js 15 frontend on Vercel","Node/Express backend on Railway","SQLite database with 20+ tables"],
      fixes: []
    },
    {
      version: "v0.1.0", released_at: "2026-02-27", highlight: "All 5 frontend layers shipped",
      features: ["L1: Dashboard with live market scanner feed","L2: Signal Generation — RecentSignals wired to /api/signals","L3: Risk panel — circuit breaker, live exposure","L4: Execute Trade wired to /api/execution/order","L5: PerformancePanel, Brier scores, attribution, drift status","Market page full rebuild — live pipeline log, chart, Terminal X design"],
      fixes: ["Cypress catches TypeError crashes + market page error state","Agent output normalization","circuitBreaker API response normalization"]
    },
    {
      version: "v0.2.0", released_at: "2026-02-28", highlight: "Relay chat + Autopilot dashboard",
      features: ["Relay SSE streaming — TTFT ~250ms, word-by-word tokens","Autopilot dashboard — scanner feed, execution log, P&L ticker","RelayChat with model badge, latency, agent chips, glassmorphism","Always-visible suggested follow-up question pills","Relay typing indicator"],
      fixes: ["PipelineLog rewrite — reliable queue drainer, no stale closures","Chart uses clobTokenIds[0] as tokenId","SSE event parsing in runPipeline","Relay system prompt — 50-word limit, humanizer enforced"]
    },
    {
      version: "v0.3.0", released_at: "2026-02-28", highlight: "All 7 specialist agents live",
      features: ["GAP-1: Real agents in scanner (Oracle, Edge, Sigma, Clause, Aura, Flux)","GAP-2: Performance endpoint with Brier scores","GAP-3: PnL settler (30-min cycle)","GAP-4: Relay pre-warm + heartbeat","GAP-5: Market scoring pipeline","GAP-6: Circuit breaker hardening","Lucifer dynamic per-market devil's advocate analysis","Order ID + Polymarket verification link in alerts"],
      fixes: ["Flux CLI-only orderbook (removed broken CLOB API fallback)","Scanner INSERT OR REPLACE","Agent field mappings (fractional_kelly, riskLevel, confidence)","Relay: never echo raw JSON in responses"]
    },
    {
      version: "v0.4.0", released_at: "2026-03-01", highlight: "CI gate — 69 tests block every deploy",
      features: ["Backend: 8 real API contract tests gate Railway deploys","Frontend: Cypress Tier1 (37 tests) + Tier2 (24 tests) gate Vercel deploys","SSE mock pattern with ReadableStream stub","/api/execution/log endpoint","Scanner market coverage expanded"],
      fixes: ["CI: jest flag --testPathPattern removed in jest 30","Markets GET /:slug normalizes tokenId from Gamma","Price-history returns flat array from CLOB REST API"]
    },
    {
      version: "v0.5.0", released_at: "2026-03-01", highlight: "Full autonomous pipeline with real agents",
      features: ["Scanner sorts by liquidity (not volume)","Sports/esports markets excluded from scanner","Oracle runs via direct import (no HTTP self-call)","GNews RSS integration for Aura — real-time news, no API key","Synthesized Kelly when Kelly=0 via oracle divergence","Real yesPrice in market_price alert field","FAILED ❌ / LIVE ✅ status labels in alerts"],
      fixes: ["Edge INSERT OR REPLACE + correlation timeout","Sigma weighted confidence (Oracle×3, Clause×2, Edge×2, Flux×1, Aura×1)","CLI stdout capture (polymarket prints errors to stdout)","Duplicate -o json flag removed","Price rounded to 2dp for CLOB tick size (0.01 minimum)"]
    },
    {
      version: "v0.6.0", released_at: "2026-03-02", highlight: "Persistent SQLite on Railway volume",
      features: ["Railway persistent volume (/data/quantik.db)","Simulated P&L for paper trades (entry vs current scanner price)","fill_price stored at execution time","CLOB balance health endpoint /api/clob/balance","CLOB allowances set at startup (max_uint256)"],
      fixes: ["Portfolio summary reads from executions table (not missing trades table)","Trade history returns real executions as trades[]","TS2869 nullish unreachable errors in marketScanner"]
    },
    {
      version: "v0.7.0", released_at: "2026-03-02", highlight: "First live trade placed on Polymarket CLOB",
      features: ["Market orders (FOK) — fills immediately at market price, no stale bids","USDC.e live wallet funded ($247.59 on Polygon)","BET_NO correctly buys NO token (clobTokenIds[1])","Attribution dashboard reads from executions table","Version changelog system in sidebar"],
      fixes: ["safeBigInt guard — no more 0x crash on RPC empty response","Flux CLI orderbook→book (correct subcommand)","Removed 4 dead RPCs (polygon-rpc.com, maticvigil, meowrpc, omniatech)","Fixed scanner_results query (removed nonexistent yes_price column)","pnlSettler SQL string literals (single-quotes for status values)"]
    }
  ];

  for (const v of VERSION_SEED) {
    insertVersion.run(v.version, v.released_at, JSON.stringify(v.features), JSON.stringify(v.fixes), v.highlight ?? null);
  }
}
