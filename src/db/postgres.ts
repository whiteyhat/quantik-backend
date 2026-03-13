import { Pool, PoolConfig } from "pg";

// ── PostgreSQL Connection Pool ────────────────────────────────────────────────
// Used for multi-tenant features (users, agents, chat).
// Legacy features still use SQLite via schema.ts until fully migrated.

let pool: Pool | null = null;

export function getPgPool(): Pool {
  if (!pool) {
    const config: PoolConfig = {
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };

    // Neon requires SSL
    if (process.env.DATABASE_URL?.includes("neon.tech")) {
      config.ssl = { rejectUnauthorized: false };
    }

    pool = new Pool(config);

    pool.on("error", (err) => {
      console.error("[postgres] Unexpected pool error:", err.message);
    });
  }
  return pool;
}

// ── Schema Migration ──────────────────────────────────────────────────────────

export async function migratePg(): Promise<void> {
  const db = getPgPool();

  // Helper: run a migration step, log and continue on failure so later steps
  // still execute.  Critical column ALTERs must not be blocked by unrelated
  // CREATE TABLE failures earlier in the chain.
  const safeQuery = async (label: string, sql: string) => {
    try {
      await db.query(sql);
    } catch (err) {
      console.error(`[postgres] Migration step "${label}" failed:`, (err as Error).message);
    }
  };

  // ── 1. Core tables (each in its own call so one failure can't block all) ───
  await safeQuery("create users", `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_id TEXT UNIQUE NOT NULL,
      email TEXT,
      agent_id UUID,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id);
  `);

  // CRITICAL: ensure agent_id column exists on users — must run even if the
  // table was created by an older migration without this column.
  await safeQuery("users.agent_id", `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id UUID
  `);

  await safeQuery("create agents", `
    CREATE TABLE IF NOT EXISTS agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
      user_id UUID,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deployed_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
  `);

  await safeQuery("create chat tables", `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      created_at BIGINT NOT NULL,
      last_message_at BIGINT NOT NULL,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES chat_sessions(id),
      role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
      content TEXT NOT NULL,
      metadata JSONB,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at ASC);
  `);

  await safeQuery("agents columns", `
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type TEXT NOT NULL DEFAULT 'created';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_url TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_url TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS connection_status TEXT DEFAULT 'pending';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_heartbeat BIGINT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_events TEXT DEFAULT '["*"]';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS autopilot_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS autopilot_updated_at BIGINT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS encrypted_private_key TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS encrypted_seed_phrase TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS polymarket_ready INTEGER DEFAULT 0;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS polymarket_status TEXT DEFAULT 'pending_funding';
  `);

  await safeQuery("create api_keys", `
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '["read","trade","analysis","config"]',
      rate_limit_tier TEXT NOT NULL DEFAULT 'standard',
      created_at BIGINT NOT NULL,
      revoked_at BIGINT,
      last_used_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys(agent_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, created_at DESC);
  `);

  await safeQuery("create byo tables", `
    CREATE TABLE IF NOT EXISTS byo_request_log (
      id BIGSERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      error TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_byo_log_agent_time ON byo_request_log(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_byo_log_time ON byo_request_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS webhook_delivery_log (
      id BIGSERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      latency_ms INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_log_agent_time ON webhook_delivery_log(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS byo_onboarding_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL,
      claimed_at BIGINT,
      agent_id TEXT,
      identity_name TEXT,
      identity_description TEXT,
      identity_avatar TEXT,
      agent_url TEXT,
      endpoint_url TEXT,
      webhook_events TEXT DEFAULT '["*"]',
      encrypted_wallet_bundle TEXT,
      wallet_downloaded_at BIGINT,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_byo_onboarding_user ON byo_onboarding_sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_byo_onboarding_status ON byo_onboarding_sessions(status, expires_at);
  `);

  await safeQuery("byo_onboarding columns", `
    ALTER TABLE byo_onboarding_sessions ADD COLUMN IF NOT EXISTS encrypted_wallet_bundle TEXT;
    ALTER TABLE byo_onboarding_sessions ADD COLUMN IF NOT EXISTS wallet_downloaded_at BIGINT;
  `);

  // ── Trading tables (with user_id for multi-tenancy) ─────────────────────────
  await safeQuery("trading tables", `
    -- Pipeline Runs
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      user_id UUID,
      market_slug TEXT,
      market_question TEXT,
      created_at BIGINT,
      completed_at BIGINT,
      decision TEXT,
      confidence REAL,
      aura_output JSONB,
      flux_output JSONB,
      oracle_output JSONB,
      edge_output JSONB,
      sigma_output JSONB,
      clause_output JSONB,
      lucifer_output JSONB,
      signal_state TEXT,
      alert_sent INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user ON pipeline_runs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_slug ON pipeline_runs(market_slug, created_at DESC);

    -- Trades
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      user_id UUID,
      order_id TEXT,
      market_slug TEXT,
      direction TEXT,
      size REAL,
      price REAL,
      net_ev REAL,
      ev_grade TEXT,
      status TEXT,
      created_at BIGINT,
      pipeline_run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, created_at DESC);

    -- Risk Configuration
    CREATE TABLE IF NOT EXISTS risk_configurations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_risk_config_user ON risk_configurations(user_id);

    CREATE TABLE IF NOT EXISTS agent_thresholds (
      id TEXT PRIMARY KEY,
      risk_configuration_id TEXT NOT NULL REFERENCES risk_configurations(id),
      agent_name TEXT NOT NULL,
      agent_status TEXT NOT NULL DEFAULT 'active',
      var_threshold REAL NOT NULL DEFAULT 0.05,
      auto_exec_enabled INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_circuit_breakers (
      id TEXT PRIMARY KEY,
      risk_configuration_id TEXT NOT NULL REFERENCES risk_configurations(id),
      panic_mode_enabled INTEGER NOT NULL DEFAULT 0,
      drawdown_limit_pct REAL NOT NULL DEFAULT 0.15,
      max_position_size_pct REAL NOT NULL DEFAULT 0.10,
      kelly_fraction_multiplier REAL NOT NULL DEFAULT 0.25,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    -- Panic Mode & Liquidation
    CREATE TABLE IF NOT EXISTS panic_mode_events (
      id TEXT PRIMARY KEY,
      user_id UUID,
      request_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pending_orders_count INTEGER NOT NULL DEFAULT 0,
      active_positions_count INTEGER NOT NULL DEFAULT 0,
      estimated_total_value REAL NOT NULL DEFAULT 0,
      initiated_at BIGINT NOT NULL,
      completed_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS liquidation_reports (
      id TEXT PRIMARY KEY,
      report_code TEXT NOT NULL,
      panic_mode_event_id TEXT NOT NULL REFERENCES panic_mode_events(id),
      status TEXT NOT NULL DEFAULT 'processing',
      completion_timestamp BIGINT,
      total_realized_value REAL,
      slippage_pct REAL,
      gas_execution_cost REAL,
      recovery_status TEXT
    );

    CREATE TABLE IF NOT EXISTS liquidation_line_items (
      id TEXT PRIMARY KEY,
      liquidation_report_id TEXT NOT NULL REFERENCES liquidation_reports(id),
      asset_symbol TEXT NOT NULL,
      asset_label TEXT NOT NULL,
      execution_price REAL NOT NULL,
      trigger_price REAL NOT NULL,
      size REAL NOT NULL,
      size_unit TEXT NOT NULL DEFAULT 'shares',
      pnl_impact REAL NOT NULL DEFAULT 0
    );

    -- Settings
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      paper_mode INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Paper Trades
    CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY,
      user_id UUID,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL,
      size REAL NOT NULL,
      price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      created_at BIGINT NOT NULL,
      settled_at BIGINT,
      pnl REAL
    );

    -- Paper Orders (L4 Execution Engine)
    CREATE TABLE IF NOT EXISTS paper_orders (
      id TEXT PRIMARY KEY,
      user_id UUID,
      slug TEXT NOT NULL,
      direction TEXT NOT NULL,
      size REAL NOT NULL,
      entry_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at BIGINT NOT NULL,
      filled_at BIGINT
    );

    -- Markets Cache
    CREATE TABLE IF NOT EXISTS markets_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      cached_at BIGINT NOT NULL
    );

    -- Orchestrator Candidates
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
      scored_at BIGINT NOT NULL,
      pipeline_triggered INTEGER DEFAULT 0,
      pipeline_triggered_at BIGINT
    );

    -- Orchestrator Scan State
    CREATE TABLE IF NOT EXISTS orchestrator_scan_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_at BIGINT NOT NULL DEFAULT 0,
      markets_scanned INTEGER NOT NULL DEFAULT 0,
      candidates_found INTEGER NOT NULL DEFAULT 0,
      scan_cycle INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO orchestrator_scan_state (id)
      VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- Market Volume Snapshots
    CREATE TABLE IF NOT EXISTS market_volume_snapshots (
      slug TEXT PRIMARY KEY,
      volume REAL NOT NULL,
      snapshot_at BIGINT NOT NULL
    );

    -- Market Price Snapshots
    CREATE TABLE IF NOT EXISTS market_price_snapshots (
      slug TEXT NOT NULL,
      yes_price REAL NOT NULL,
      snapshot_at BIGINT NOT NULL,
      PRIMARY KEY (slug, snapshot_at)
    );
  `);

  // ── Agent result tables ─────────────────────────────────────────────────────
  await safeQuery("agent result tables", `
    -- Aura Results
    CREATE TABLE IF NOT EXISTS aura_results (
      slug TEXT NOT NULL,
      scored_at BIGINT NOT NULL,
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
      is_mock INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (slug, scored_at)
    );

    -- Oracle Results
    CREATE TABLE IF NOT EXISTS oracle_results (
      market_slug TEXT PRIMARY KEY,
      scored_at BIGINT NOT NULL,
      raw_prob REAL NOT NULL,
      calibrated_prob REAL NOT NULL,
      market_implied REAL NOT NULL,
      confidence REAL NOT NULL,
      data_sufficiency REAL NOT NULL,
      bull_case TEXT NOT NULL,
      bear_case TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      cross_market_signals JSONB NOT NULL,
      cross_market_divergence INTEGER NOT NULL,
      arb_detected INTEGER NOT NULL,
      arb_details TEXT,
      whale_signal_p_yes REAL,
      days_to_resolution INTEGER NOT NULL,
      ensemble_variance REAL,
      longshot_adjusted INTEGER NOT NULL,
      resolved_correctly INTEGER,
      resolved_at BIGINT
    );

    -- Edge Results
    CREATE TABLE IF NOT EXISTS edge_results (
      "marketSlug" TEXT PRIMARY KEY,
      "scoredAt" BIGINT NOT NULL,
      gross_edge REAL NOT NULL,
      net_edge REAL NOT NULL,
      ev_grade TEXT NOT NULL,
      net_ev REAL NOT NULL,
      kelly_recommended REAL NOT NULL,
      fractional_kelly REAL NOT NULL,
      position_size REAL NOT NULL,
      kelly_multiplier REAL NOT NULL,
      time_decay_watch INTEGER NOT NULL,
      arb_opportunities JSONB NOT NULL,
      correlation_penalty REAL NOT NULL,
      corr_blocked INTEGER NOT NULL,
      direction TEXT NOT NULL,
      confidence REAL NOT NULL
    );

    -- Clause Results
    CREATE TABLE IF NOT EXISTS clause_results (
      "marketSlug" TEXT PRIMARY KEY,
      "scoredAt" BIGINT NOT NULL,
      "ambiguityScore" REAL NOT NULL,
      "riskLevel" TEXT NOT NULL,
      veto INTEGER NOT NULL,
      "ambiguityFlags" JSONB NOT NULL,
      technicality_risks JSONB NOT NULL,
      "resolutionCriteria" TEXT NOT NULL,
      "disputeHistory" INTEGER NOT NULL,
      urgent INTEGER NOT NULL,
      confidence REAL NOT NULL
    );

    -- Flux Results
    CREATE TABLE IF NOT EXISTS flux_results (
      "marketSlug" TEXT PRIMARY KEY,
      "scoredAt" BIGINT NOT NULL,
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

    -- Resolutions (L5 Monitoring)
    CREATE TABLE IF NOT EXISTS resolutions (
      id TEXT PRIMARY KEY,
      pipeline_run_id TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      predicted REAL NOT NULL,
      outcome INTEGER NOT NULL,
      brier_score REAL NOT NULL,
      signal_type TEXT,
      resolved_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resolutions_run_slug
      ON resolutions(pipeline_run_id, market_slug);

    -- Research Notes (Sigma synthesis)
    CREATE TABLE IF NOT EXISTS research_notes (
      "marketSlug" TEXT PRIMARY KEY,
      "scoredAt" BIGINT NOT NULL,
      composite_prob REAL NOT NULL,
      confidence REAL NOT NULL,
      confidence_interval JSONB NOT NULL,
      consistency_score REAL NOT NULL,
      recommended_direction TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      skip_reason TEXT,
      thesis TEXT NOT NULL,
      bear_case TEXT NOT NULL,
      bull_case TEXT NOT NULL,
      agent_weights JSONB NOT NULL,
      lucifer_da_score REAL,
      auto_synthesized INTEGER NOT NULL
    );

    -- Resolution Backfill Log
    CREATE TABLE IF NOT EXISTS resolution_backfill_log (
      slug TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      backfilled_at BIGINT NOT NULL,
      positions_found INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ── Scanner tables ─────────────────────────────────────────────────────────
  await safeQuery("scanner tables", `
    CREATE TABLE IF NOT EXISTS scanner_results (
      id SERIAL PRIMARY KEY,
      user_id UUID,
      slug TEXT NOT NULL,
      scanned_at BIGINT NOT NULL,
      sigma_confidence REAL,
      kelly_fraction REAL,
      recommendation TEXT,
      probability REAL,
      alert_sent INTEGER DEFAULT 0,
      pipeline_result TEXT,
      execution_status TEXT,
      execution_id INTEGER,
      UNIQUE(slug, scanned_at)
    );
    CREATE INDEX IF NOT EXISTS idx_scanner_slug_time ON scanner_results(slug, scanned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scanner_user ON scanner_results(user_id, scanned_at DESC);
  `);

  // ── Executions table (without agent_id index — column may not exist yet) ──
  await safeQuery("executions table", `
    CREATE TABLE IF NOT EXISTS executions (
      id SERIAL PRIMARY KEY,
      user_id UUID,
      agent_id UUID,
      slug TEXT NOT NULL,
      side TEXT NOT NULL,
      amount REAL NOT NULL,
      executed_at BIGINT NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT,
      fill_price REAL,
      pnl REAL
    );
    CREATE INDEX IF NOT EXISTS idx_executions_slug_time ON executions(slug, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_date ON executions(executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_user ON executions(user_id, executed_at DESC);
  `);

  // ── Ensure agent_id column exists BEFORE creating index on it ─────────────
  await safeQuery("executions.agent_id column", `ALTER TABLE executions ADD COLUMN IF NOT EXISTS agent_id UUID`);
  await safeQuery("executions.agent_id index", `CREATE INDEX IF NOT EXISTS idx_executions_agent ON executions(agent_id, executed_at DESC)`);

  await safeQuery("backfill executions.agent_id", `
    UPDATE executions
    SET agent_id = users.agent_id
    FROM users
    WHERE executions.user_id = users.id AND executions.agent_id IS NULL
      AND users.agent_id IS NOT NULL
  `);

  // ── Versions / Changelog ──────────────────────────────────────────────────
  await safeQuery("versions table", `
    CREATE TABLE IF NOT EXISTS versions (
      id SERIAL PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      released_at TEXT NOT NULL,
      features TEXT NOT NULL DEFAULT '[]',
      fixes TEXT NOT NULL DEFAULT '[]',
      highlight TEXT,
      highlight_es TEXT,
      highlight_fr TEXT,
      highlight_de TEXT,
      features_es TEXT,
      features_fr TEXT,
      features_de TEXT,
      fixes_es TEXT,
      fixes_fr TEXT,
      fixes_de TEXT
    );
  `);
  await safeQuery("versions locale columns", `
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS highlight_es TEXT;
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS highlight_fr TEXT;
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS highlight_de TEXT;
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS features_es TEXT;
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS features_fr TEXT;
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS features_de TEXT;
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS fixes_es TEXT;
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS fixes_fr TEXT;
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS fixes_de TEXT;
  `);

  console.log("[postgres] Migration complete — all tables ready");
}

// ── Query Helpers ─────────────────────────────────────────────────────────────

export async function pgQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPgPool().query(sql, params);
  return result.rows as T[];
}

export async function pgQueryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await pgQuery<T>(sql, params);
  return rows[0] ?? null;
}

export async function pgExec(sql: string, params: unknown[] = []): Promise<number> {
  const result = await getPgPool().query(sql, params);
  return result.rowCount ?? 0;
}

// ── Check if PostgreSQL is configured ─────────────────────────────────────────

export function isPgEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
