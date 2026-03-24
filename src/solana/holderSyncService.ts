/**
 * Holder Sync Service — hourly cron job processor for solana_token_holders cache.
 *
 * Responsibilities:
 * - runHolderSync: fetch all migrated tokens, query getTopHolders() for each, upsertHolders(), emitHolderUpdate()
 * - upsertHolders: DELETE existing holders for mint, INSERT new rows in single transaction
 *
 * Per D-05: hourly cron job (solana:sync-holders)
 * Per D-06: cache in DB, frontend reads from cache, not live RPC
 * Per D-07: emit holders:updated Socket.IO event after each mint sync
 * Per D-14: treasury/Quantik wallets excluded — handled by getTopHolders() upstream
 */

import { v4 as uuidv4 } from "uuid";
import { getTopHolders, HolderEntry } from "./holderService";
import { getDb } from "../db/schema";
import { isPgEnabled, pgExec, pgQuery } from "../db/postgres";
import { emitHolderUpdate } from "../infra/socket";

interface MigratedToken {
  token_mint: string;
}

async function getMigratedTokens(): Promise<MigratedToken[]> {
  if (isPgEnabled()) {
    return pgQuery<MigratedToken>(
      "SELECT token_mint FROM solana_tokens WHERE status = 'migrated'",
      []
    );
  } else {
    const db = getDb();
    return db.prepare(
      "SELECT token_mint FROM solana_tokens WHERE status = 'migrated'"
    ).all() as MigratedToken[];
  }
}

export async function upsertHolders(mint: string, holders: HolderEntry[]): Promise<void> {
  const now = Date.now();
  const rows = holders.map((h, i) => ({
    id: uuidv4(),
    mint,
    wallet: h.wallet,
    balance: h.balance,
    percentage: h.shareOfTopTen * 100, // convert 0-1 to 0-100
    rank: i + 1,
    last_sync_time: now,
    created_at: now,
  }));

  if (isPgEnabled()) {
    // PostgreSQL: DELETE existing + batch INSERT
    await pgExec("DELETE FROM solana_token_holders WHERE mint = $1", [mint]);
    if (rows.length > 0) {
      const placeholders = rows
        .map(
          (_, i) =>
            `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8})`
        )
        .join(", ");
      const values = rows.flatMap((r) => [
        r.id,
        r.mint,
        r.wallet,
        r.balance,
        r.percentage,
        r.rank,
        r.last_sync_time,
        r.created_at,
      ]);
      await pgExec(
        `INSERT INTO solana_token_holders (id, mint, wallet, balance, percentage, rank, last_sync_time, created_at) VALUES ${placeholders}`,
        values
      );
    }
  } else {
    // SQLite: wrap DELETE + INSERT in transaction for atomicity
    const db = getDb();
    const deleteStmt = db.prepare("DELETE FROM solana_token_holders WHERE mint = ?");
    const insertStmt = db.prepare(
      "INSERT INTO solana_token_holders (id, mint, wallet, balance, percentage, rank, last_sync_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const tx = db.transaction(() => {
      deleteStmt.run(mint);
      for (const r of rows) {
        insertStmt.run(
          r.id,
          r.mint,
          r.wallet,
          r.balance,
          r.percentage,
          r.rank,
          r.last_sync_time,
          r.created_at
        );
      }
    });
    tx();
  }
}

export async function runHolderSync(): Promise<void> {
  const tokens = await getMigratedTokens();
  if (tokens.length === 0) {
    console.log("[holderSync] No migrated tokens to sync");
    return;
  }

  console.log(`[holderSync] Syncing holders for ${tokens.length} migrated token(s)`);

  for (const { token_mint: mint } of tokens) {
    try {
      const holders = await getTopHolders(mint, 10);
      await upsertHolders(mint, holders);

      emitHolderUpdate({
        mint,
        holders: holders.map((h, i) => ({
          rank: i + 1,
          wallet: h.wallet,
          balance: h.balance,
          percentage: h.shareOfTopTen * 100,
        })),
        updatedAt: Date.now(),
      });

      console.log(`[holderSync] Synced ${holders.length} holders for mint ${mint}`);
    } catch (err) {
      // Log and continue — don't let one mint failure stop others
      console.error(
        `[holderSync] Failed to sync mint ${mint}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
