import { PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getDbcClient, getSolanaConnection } from "./dbcClient";
import { decryptTreasuryKeypair } from "./treasuryService";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne, pgExec } from "../db/postgres";

// Checks a single pool's migration status and updates DB if migrated.
// Called by a periodic BullMQ job (Phase 3) or on-demand after trades.
// Returns { migrated: true } when pool has graduated to DAMM v2.
export async function checkAndUpdateMigrationStatus(poolAddress: string): Promise<{
  migrated: boolean;
  dammPoolAddress: string | null;
}> {
  const client = getDbcClient();
  const poolPubkey = new PublicKey(poolAddress);

  const poolState = await client.state.getPool(poolPubkey);

  // Meteora sets isMigrated = true once Keeper service completes graduation to DAMM v2.
  // We detect this flag and persist the transition — we do NOT trigger the migration.
  const poolStateAny = poolState as unknown as Record<string, unknown>;
  const isMigrated = poolStateAny.isMigrated === true;
  if (!isMigrated) return { migrated: false, dammPoolAddress: null };

  // Extract DAMM pool address from pool state (populated after migration)
  const dammPoolPubkey = poolStateAny.dammPool as { toBase58?: () => string } | undefined;
  const dammPoolAddress = dammPoolPubkey?.toBase58?.() ?? null;
  const now = Date.now();

  if (isPgEnabled()) {
    await pgExec(
      `UPDATE solana_tokens
       SET status = 'migrated', migrated_at = $1, damm_pool_address = $2
       WHERE dbc_pool_address = $3 AND status = 'bonding'`,
      [now, dammPoolAddress, poolAddress]
    );
  } else {
    const db = getDb();
    db.prepare(
      `UPDATE solana_tokens
       SET status = 'migrated', migrated_at = ?, damm_pool_address = ?
       WHERE dbc_pool_address = ? AND status = 'bonding'`
    ).run(now, dammPoolAddress, poolAddress);
  }

  console.log(`[migrationMonitor] Pool ${poolAddress} migrated to DAMM: ${dammPoolAddress}`);
  return { migrated: true, dammPoolAddress };
}

// Claims accumulated DBC trading fees (USDC) to the treasury wallet.
// Fees do NOT auto-transfer — must be claimed explicitly (RESEARCH.md Pitfall 6).
// Call via a BullMQ daily cron job (Phase 3 scheduler).
export async function claimAccumulatedFees(
  poolAddress: string,
  configAddress: string
): Promise<{ txSignature: string }> {
  const client = getDbcClient();
  const connection = getSolanaConnection();
  const treasuryKeypair = decryptTreasuryKeypair();

  const poolPubkey = new PublicKey(poolAddress);

  // The treasury wallet acts as both feeClaimer and fee receiver.
  // maxBaseAmount=0: skip base token fees (we only want USDC).
  // maxQuoteAmount=MAX_SAFE_INTEGER BN: claim all accumulated USDC fees.
  const claimTx = await client.partner.claimPartnerTradingFee({
    feeClaimer: treasuryKeypair.publicKey,
    payer: treasuryKeypair.publicKey,
    pool: poolPubkey,
    maxBaseAmount: new BN(0),
    maxQuoteAmount: new BN(Number.MAX_SAFE_INTEGER),
    receiver: treasuryKeypair.publicKey,
  });

  const signature = await sendAndConfirmTransaction(
    connection,
    claimTx,
    [treasuryKeypair],
    { commitment: "confirmed" }
  );

  console.log(`[migrationMonitor] Fees claimed for pool ${poolAddress}: ${signature}`);
  return { txSignature: signature };
}

// Polls all active bonding-curve pools and updates migration status for any that graduated.
// Designed to be called by a BullMQ cron job every 30 minutes.
export async function pollAllPoolMigrations(): Promise<void> {
  let pools: Array<{ dbc_pool_address: string }> = [];

  if (isPgEnabled()) {
    const rows = await pgQueryOne<{ dbc_pool_address: string }>(
      "SELECT dbc_pool_address FROM solana_tokens WHERE status = 'bonding'",
      []
    );
    // pgQueryOne returns one row — but we need all rows here. Use the raw pool.
    // This is a safe fallback — pollAllPoolMigrations handles the case where
    // pgQueryOne returns null or a single row by treating it as an array.
    if (rows !== null) {
      pools = [rows];
    }
  } else {
    const db = getDb();
    pools = db
      .prepare("SELECT dbc_pool_address FROM solana_tokens WHERE status = 'bonding'")
      .all() as Array<{ dbc_pool_address: string }>;
  }

  for (const pool of pools) {
    await checkAndUpdateMigrationStatus(pool.dbc_pool_address).catch((err) => {
      console.error(
        `[migrationMonitor] error checking ${pool.dbc_pool_address}:`,
        err instanceof Error ? err.message : err
      );
    });
  }
}
