#!/usr/bin/env npx ts-node
/**
 * SQLite → PostgreSQL Data Migration
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx ts-node src/db/migrate-to-pg.ts
 *
 * If your cloud Railway instance uses a DIFFERENT ENCRYPTION_KEY than your
 * local environment, pass the cloud key so wallet secrets are re-encrypted:
 *   TARGET_ENCRYPTION_KEY=<cloud-hex-key> DATABASE_URL=... npx ts-node src/db/migrate-to-pg.ts
 *
 * This script:
 *   1. Reads all data from the local SQLite database
 *   2. Runs PG migrations (creates tables if needed)
 *   3. Inserts all rows into PostgreSQL using batch upserts
 *   4. Re-encrypts wallet secrets for the target environment if keys differ
 *   5. Reports row counts for verification
 *
 * Safe to run multiple times — uses ON CONFLICT DO UPDATE for agents
 * (to sync wallet data) and ON CONFLICT DO NOTHING for other tables.
 */

import Database from "better-sqlite3";
import path from "path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { getPgPool, migratePg } from "./postgres";

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "quantik.db")
  : path.join(__dirname, "..", "..", "quantik.db");

// ── Wallet re-encryption helpers ──────────────────────────────
// When the cloud ENCRYPTION_KEY differs from the local one, wallet
// secrets must be decrypted with the source key and re-encrypted
// with the target key so the cloud backend can read them.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function resolveKeyBuffer(keyHex: string | undefined, label: string): Buffer | null {
  const trimmed = keyHex?.trim();
  if (trimmed && /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  // Fallback: derive from CLERK_SECRET_KEY (same logic as encryption.ts)
  const fallback = process.env.CLERK_SECRET_KEY?.trim();
  if (fallback) {
    console.log(`  [re-encrypt] ${label}: no explicit key, deriving from CLERK_SECRET_KEY`);
    return createHash("sha256").update(`quantik:runtime-encryption:${fallback}`).digest();
  }
  return null;
}

function decryptWith(encryptedStr: string, key: Buffer): string {
  const parts = encryptedStr.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const iv = Buffer.from(parts[0], "base64");
  const encrypted = parts[1];
  const authTag = Buffer.from(parts[2], "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function encryptWith(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${encrypted}:${authTag.toString("base64")}`;
}

/** Re-encrypt a value from source key to target key. Returns null if input is empty. */
function reEncrypt(value: unknown, sourceKey: Buffer, targetKey: Buffer): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const plaintext = decryptWith(value, sourceKey);
    return encryptWith(plaintext, targetKey);
  } catch (err) {
    console.warn(`  [re-encrypt] Failed to re-encrypt a wallet field: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// Columns in the agents table that contain encrypted wallet secrets
const ENCRYPTED_AGENT_COLS = new Set(["encrypted_private_key", "encrypted_seed_phrase"]);

// Columns to upsert when an agent already exists in PG (wallet + status fields)
const AGENT_UPSERT_COLS = new Set([
  "wallet_address",
  "encrypted_private_key",
  "encrypted_seed_phrase",
  "polymarket_ready",
  "polymarket_status",
  "updated_at",
]);

// Tables to migrate with their PG primary key for ON CONFLICT
const TABLES: { name: string; conflict: string }[] = [
  { name: "pipeline_runs", conflict: "id" },
  { name: "pipeline_run_steps", conflict: "id" },
  { name: "trades", conflict: "id" },
  { name: "risk_configurations", conflict: "id" },
  { name: "agent_thresholds", conflict: "id" },
  { name: "global_circuit_breakers", conflict: "id" },
  { name: "circuit_breaker_state", conflict: "id" },
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
  "ambiguityFlags", "resolutionCriteria", "disputeHistory", "window",
]);

function quoteCol(col: string): string {
  return QUOTED_COLS.has(col) ? `"${col}"` : col;
}

async function migrateTable(
  sqliteDb: Database.Database,
  tableName: string,
  conflict: string,
  reEncryptKeys: { source: Buffer; target: Buffer } | null
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

  const isAgents = tableName === "agents";
  const needsReEncrypt = isAgents && reEncryptKeys !== null;

  const pg = getPgPool();
  const columns = Object.keys(rows[0]);
  const quotedColumns = columns.map(quoteCol);
  const BATCH_SIZE = 500;
  let inserted = 0;

  // For agents table: build ON CONFLICT DO UPDATE to sync wallet fields
  let conflictClause: string;
  if (isAgents) {
    const updateSets = columns
      .filter((col) => AGENT_UPSERT_COLS.has(col))
      .map((col) => `${quoteCol(col)} = EXCLUDED.${quoteCol(col)}`);
    conflictClause = updateSets.length > 0
      ? `ON CONFLICT (${conflict}) DO UPDATE SET ${updateSets.join(", ")}`
      : `ON CONFLICT (${conflict}) DO NOTHING`;
  } else {
    conflictClause = `ON CONFLICT (${conflict}) DO NOTHING`;
  }

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
        // Re-encrypt wallet secrets for the target environment
        if (needsReEncrypt && ENCRYPTED_AGENT_COLS.has(columns[c]) && val) {
          const reEncrypted = reEncrypt(val, reEncryptKeys!.source, reEncryptKeys!.target);
          if (reEncrypted) {
            val = reEncrypted;
          }
        }
        values.push(val);
      }
      valueClauses.push(`(${placeholders.join(", ")})`);
    }

    const sql = `
      INSERT INTO ${tableName} (${quotedColumns.join(", ")})
      VALUES ${valueClauses.join(", ")}
      ${conflictClause}
    `;

    const result = await pg.query(sql, values);
    inserted += result.rowCount ?? 0;
  }

  console.log(`  [done] ${tableName} — ${inserted}/${rows.length} rows ${isAgents ? "upserted" : "inserted"}`);
  return inserted;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set. Set it to your PostgreSQL connection string.");
    process.exit(1);
  }

  // ── Resolve re-encryption keys ─────────────────────────────────
  // SOURCE = local ENCRYPTION_KEY (used to encrypt data in SQLite)
  // TARGET = TARGET_ENCRYPTION_KEY or ENCRYPTION_KEY on the cloud side
  const sourceKey = resolveKeyBuffer(process.env.ENCRYPTION_KEY, "source");
  const targetKeyHex = process.env.TARGET_ENCRYPTION_KEY?.trim();
  const targetKey = targetKeyHex ? resolveKeyBuffer(targetKeyHex, "target") : sourceKey;

  let reEncryptKeys: { source: Buffer; target: Buffer } | null = null;
  if (sourceKey && targetKey) {
    if (sourceKey.equals(targetKey)) {
      console.log("[migrate] Source and target encryption keys match — no re-encryption needed.");
    } else {
      console.log("[migrate] TARGET_ENCRYPTION_KEY differs from local — wallet secrets will be re-encrypted.");
      reEncryptKeys = { source: sourceKey, target: targetKey };
    }
  } else if (!sourceKey) {
    console.warn("[migrate] WARNING: No local ENCRYPTION_KEY found. Encrypted wallet fields will be copied as-is.");
    console.warn("         If the cloud uses a different key, wallet decryption will fail.");
    console.warn("         Set TARGET_ENCRYPTION_KEY to re-encrypt for the cloud environment.");
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
      const count = await migrateTable(sqliteDb, name, conflict, reEncryptKeys);
      if (count > 0) totalTables++;
      totalInserted += count;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] ${name}: ${msg}`);
    }
  }

  // ── Reconcile user IDs ──────────────────────────────────────────
  // When a user logs into prod before migration, they get a new internal ID.
  // The migrated data (agents, executions) still references the old SQLite ID.
  // Fix by remapping all references to the prod-created user ID.
  console.log("\n[migrate] Reconciling user IDs...");
  const sqliteUsers = new Database(DB_PATH, { readonly: true })
    .prepare("SELECT id, clerk_id FROM users")
    .all() as Array<{ id: string; clerk_id: string }>;

  const pg = getPgPool();
  for (const su of sqliteUsers) {
    const pgUser = (await pg.query(
      "SELECT id FROM users WHERE clerk_id = $1", [su.clerk_id]
    )).rows[0] as { id: string } | undefined;

    if (pgUser && pgUser.id !== su.id) {
      // Prod user exists with different ID — remap references
      const r1 = await pg.query("UPDATE agents SET user_id = $1 WHERE user_id = $2", [pgUser.id, su.id]);
      const r2 = await pg.query("UPDATE executions SET user_id = $1 WHERE user_id = $2", [pgUser.id, su.id]);
      // Link agent_id if the SQLite user had one
      if (su.clerk_id) {
        const sqliteAgentId = new Database(DB_PATH, { readonly: true })
          .prepare("SELECT agent_id FROM users WHERE id = ?").get(su.id) as { agent_id: string | null } | undefined;
        if (sqliteAgentId?.agent_id) {
          await pg.query("UPDATE users SET agent_id = $1 WHERE id = $2", [sqliteAgentId.agent_id, pgUser.id]);
        }
      }
      console.log(`  [remap] ${su.clerk_id}: ${su.id} -> ${pgUser.id} (agents: ${r1.rowCount}, executions: ${r2.rowCount})`);
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
