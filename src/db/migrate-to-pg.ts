#!/usr/bin/env npx ts-node
/**
 * SQLite → PostgreSQL Data Migration
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx ts-node src/db/migrate-to-pg.ts
 *
 * This script:
 *   1. Reads all data from the local SQLite database
 *   2. Runs PG migrations (creates tables if needed)
 *   3. Inserts all rows into PostgreSQL using batch upserts
 *   4. Reports row counts for verification
 *
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING.
 */

import Database from "better-sqlite3";
import path from "path";
import { getPgPool, migratePg } from "./postgres";

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "quantik.db")
  : path.join(__dirname, "..", "..", "quantik.db");

// Tables to migrate with their PG primary key for ON CONFLICT
const TABLES: { name: string; conflict: string }[] = [
  { name: "pipeline_runs", conflict: "id" },
  { name: "pipeline_run_steps", conflict: "id" },
  { name: "trades", conflict: "id" },
  { name: "risk_configurations", conflict: "id" },
  { name: "agent_thresholds", conflict: "id" },
  { name: "global_circuit_breakers", conflict: "id" },
  { name: "panic_mode_events", conflict: "id" },
  { name: "liquidation_reports", conflict: "id" },
  { name: "liquidation_line_items", conflict: "id" },
  { name: "settings", conflict: "id" },
  { name: "settings_kv", conflict: "key" },
  { name: "paper_trades", conflict: "id" },
  { name: "paper_orders", conflict: "id" },
  { name: "markets_cache", conflict: "key" },
  { name: "orchestrator_candidates", conflict: "slug" },
  { name: "orchestrator_scan_state", conflict: "id" },
  { name: "market_volume_snapshots", conflict: "slug" },
  { name: "market_price_snapshots", conflict: "slug, snapshot_at" },
  { name: "aura_results", conflict: "slug, scored_at" },
  { name: "oracle_results", conflict: "market_slug" },
  { name: "edge_results", conflict: '"marketSlug"' },
  { name: "clause_results", conflict: '"marketSlug"' },
  { name: "flux_results", conflict: '"marketSlug"' },
  { name: "resolutions", conflict: "id" },
  { name: "research_notes", conflict: '"marketSlug"' },
  { name: "resolution_backfill_log", conflict: "slug" },
  { name: "scanner_results", conflict: "slug, scanned_at" },
  { name: "executions", conflict: "id" },
  { name: "versions", conflict: "version" },
  { name: "users", conflict: "id" },
  { name: "agents", conflict: "id" },
  { name: "chat_sessions", conflict: "id" },
  { name: "chat_messages", conflict: "id" },
];

// SQLite columns that need quoting in PG (camelCase)
const QUOTED_COLS = new Set([
  "marketSlug", "scoredAt", "ambiguityScore", "riskLevel",
  "ambiguityFlags", "resolutionCriteria", "disputeHistory",
]);

function quoteCol(col: string): string {
  return QUOTED_COLS.has(col) ? `"${col}"` : col;
}

async function migrateTable(
  sqliteDb: Database.Database,
  tableName: string,
  conflict: string
): Promise<number> {
  // Check if table exists in SQLite
  const tableExists = sqliteDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName);
  if (!tableExists) {
    console.log(`  [skip] ${tableName} — not in SQLite`);
    return 0;
  }

  const rows = sqliteDb.prepare(`SELECT * FROM ${tableName}`).all() as Record<string, unknown>[];
  if (rows.length === 0) {
    console.log(`  [skip] ${tableName} — 0 rows`);
    return 0;
  }

  const pg = getPgPool();
  const columns = Object.keys(rows[0]);
  const quotedColumns = columns.map(quoteCol);
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values: unknown[] = [];
    const valueClauses: string[] = [];

    for (let r = 0; r < batch.length; r++) {
      const row = batch[r];
      const placeholders: string[] = [];
      for (let c = 0; c < columns.length; c++) {
        const idx = r * columns.length + c + 1;
        placeholders.push(`$${idx}`);
        let val = row[columns[c]];
        // Convert SQLite JSON strings to objects for JSONB columns
        if (typeof val === "string" && (val.startsWith("{") || val.startsWith("["))) {
          try { val = JSON.parse(val as string); } catch {}
        }
        values.push(val);
      }
      valueClauses.push(`(${placeholders.join(", ")})`);
    }

    const sql = `
      INSERT INTO ${tableName} (${quotedColumns.join(", ")})
      VALUES ${valueClauses.join(", ")}
      ON CONFLICT (${conflict}) DO NOTHING
    `;

    const result = await pg.query(sql, values);
    inserted += result.rowCount ?? 0;
  }

  console.log(`  [done] ${tableName} — ${inserted}/${rows.length} rows inserted`);
  return inserted;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set. Set it to your PostgreSQL connection string.");
    process.exit(1);
  }

  console.log("[migrate] Opening SQLite database:", DB_PATH);
  const sqliteDb = new Database(DB_PATH, { readonly: true });

  console.log("[migrate] Running PostgreSQL migrations...");
  await migratePg();

  console.log("[migrate] Starting data migration...\n");

  let totalInserted = 0;
  let totalTables = 0;

  for (const { name, conflict } of TABLES) {
    try {
      const count = await migrateTable(sqliteDb, name, conflict);
      if (count > 0) totalTables++;
      totalInserted += count;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] ${name}: ${msg}`);
    }
  }

  sqliteDb.close();

  console.log(`\n[migrate] Done! ${totalInserted} rows across ${totalTables} tables.`);
  console.log("[migrate] Verify with: SELECT tablename, n_live_tup FROM pg_stat_user_tables ORDER BY tablename;");

  await getPgPool().end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
