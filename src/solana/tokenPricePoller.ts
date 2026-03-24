import { PublicKey } from "@solana/web3.js";
import {
  getPriceFromSqrtPrice,
  TokenDecimal,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgExec } from "../db/postgres";
import { getDbcClient, getSolanaConnection } from "./dbcClient";
import { emitTokenPriceUpdate } from "../infra/socket";

// ── Token Price Poller ────────────────────────────────────────────────────────
// Called every 30s by BullMQ (or setInterval fallback).
// Reads pool state from Meteora DBC / DAMM v2 and persists price snapshots.

interface PriceSnapshot {
  mint: string;
  price_usdc: number;
  source: "dbc" | "damm_v2";
  timestamp: number;
}

/**
 * Fetch current price from a Meteora DBC pool.
 * Uses getPriceFromSqrtPrice() from the DBC SDK — this is the canonical
 * approach for DBC virtual pools (both token and USDC have 6 decimals).
 */
async function fetchDbcPrice(
  dbcPoolAddress: string,
  mint: string
): Promise<number | null> {
  try {
    const client = getDbcClient();
    const poolState = await client.state.getPool(new PublicKey(dbcPoolAddress));
    if (!poolState) return null;

    // getPriceFromSqrtPrice returns a Decimal — convert to number.
    // Both base token (agent SPL token) and quote (USDC) use 6 decimals.
    const priceDecimal = getPriceFromSqrtPrice(
      poolState.sqrtPrice,
      TokenDecimal.SIX,
      TokenDecimal.SIX
    );

    const price = Number(priceDecimal.toString());
    if (!isFinite(price) || price <= 0) return null;
    return price;
  } catch (err) {
    console.error(
      `[tokenPricePoller] DBC price fetch failed for ${mint}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Fetch current price from a Meteora DAMM v2 pool.
 * After DBC → DAMM migration, reads vault token account balances via Solana RPC.
 * Price = quoteVaultBalance / baseVaultBalance (USDC per token).
 * Both vaults are stored in the solana_tokens.damm_vault_a/b columns if available;
 * otherwise falls back to deriving vault addresses from pool state accounts.
 *
 * Note: @meteora-ag/dynamic-amm-sdk is not installed — use raw RPC calls instead.
 */
async function fetchDammPrice(
  dammPoolAddress: string,
  mint: string
): Promise<number | null> {
  try {
    const connection = getSolanaConnection();
    const poolPubkey = new PublicKey(dammPoolAddress);

    // Fetch the DAMM v2 pool account data from chain.
    // DAMM v2 pool layout: first 8 bytes = discriminator, then fields.
    // tokenAVault and tokenBVault are stored at fixed offsets in the account.
    // Offset layout (from Meteora DAMM v2 IDL):
    //   8  (discriminator)
    //   32 (lpMint)
    //   32 (tokenAMint)
    //   32 (tokenBMint)
    //   32 (aVault)        ← offset 104
    //   32 (bVault)        ← offset 136
    const accountInfo = await connection.getAccountInfo(poolPubkey);
    if (!accountInfo) {
      console.error(`[tokenPricePoller] DAMM pool account not found: ${dammPoolAddress}`);
      return null;
    }

    const data = accountInfo.data;
    if (data.length < 168) {
      console.error(`[tokenPricePoller] DAMM pool account data too short: ${data.length} bytes`);
      return null;
    }

    // Extract vault pubkeys from pool account data
    const aVaultPubkey = new PublicKey(data.slice(104, 136));
    const bVaultPubkey = new PublicKey(data.slice(136, 168));

    // Fetch token account balances for both vaults
    const [aBalance, bBalance] = await Promise.all([
      connection.getTokenAccountBalance(aVaultPubkey),
      connection.getTokenAccountBalance(bVaultPubkey),
    ]);

    const tokenAmount = Number(aBalance.value.uiAmount ?? 0);
    const usdcAmount = Number(bBalance.value.uiAmount ?? 0);

    if (tokenAmount <= 0) {
      console.error(`[tokenPricePoller] DAMM pool vault A has zero balance for ${mint}`);
      return null;
    }

    return usdcAmount / tokenAmount;
  } catch (err) {
    console.error(
      `[tokenPricePoller] DAMM price fetch failed for ${mint}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Persist price snapshot to DB (SQLite or PostgreSQL) and emit Socket.IO event.
 */
function persistAndEmit(snapshot: PriceSnapshot): void {
  try {
    if (isPgEnabled()) {
      // PostgreSQL insert (fire-and-forget — do not block the poll loop)
      pgExec(
        "INSERT INTO solana_token_prices (mint, price_usdc, source, timestamp) VALUES ($1, $2, $3, $4)",
        [snapshot.mint, snapshot.price_usdc, snapshot.source, snapshot.timestamp]
      ).catch((err: unknown) =>
        console.error("[tokenPricePoller] PG insert failed:", err)
      );
    } else {
      const db = getDb();
      db.prepare(
        "INSERT INTO solana_token_prices (mint, price_usdc, source, timestamp) VALUES (?, ?, ?, ?)"
      ).run(snapshot.mint, snapshot.price_usdc, snapshot.source, snapshot.timestamp);
    }
  } catch (err) {
    console.error(
      "[tokenPricePoller] DB insert failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  emitTokenPriceUpdate({
    mint: snapshot.mint,
    price: snapshot.price_usdc,
    source: snapshot.source,
    timestamp: snapshot.timestamp,
  });
}

/**
 * Main polling function — called by BullMQ every 30s (or setInterval fallback).
 * Iterates all active solana_tokens, fetches current pool price, stores snapshot.
 */
export async function runTokenPricePoll(): Promise<void> {
  interface TokenRow {
    token_mint: string;
    dbc_pool_address: string;
    damm_pool_address: string | null;
    status: string;
  }

  let tokens: TokenRow[] = [];

  try {
    if (isPgEnabled()) {
      tokens = await pgQuery<TokenRow>(
        "SELECT token_mint, dbc_pool_address, damm_pool_address, status FROM solana_tokens",
        []
      );
    } else {
      const db = getDb();
      tokens = db
        .prepare(
          "SELECT token_mint, dbc_pool_address, damm_pool_address, status FROM solana_tokens"
        )
        .all() as TokenRow[];
    }
  } catch (err) {
    console.error(
      "[tokenPricePoller] Failed to load tokens:",
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  if (tokens.length === 0) return;

  const now = Date.now();

  for (const token of tokens) {
    const isMigrated =
      token.status === "migrated" && token.damm_pool_address !== null;
    const source: "dbc" | "damm_v2" = isMigrated ? "damm_v2" : "dbc";

    let price: number | null = null;

    if (isMigrated && token.damm_pool_address) {
      price = await fetchDammPrice(token.damm_pool_address, token.token_mint);
    } else {
      price = await fetchDbcPrice(token.dbc_pool_address, token.token_mint);
    }

    if (price !== null && price > 0) {
      persistAndEmit({
        mint: token.token_mint,
        price_usdc: price,
        source,
        timestamp: now,
      });
    }
  }

  console.log(
    `[tokenPricePoller] Polled ${tokens.length} token(s) at ${new Date(now).toISOString()}`
  );
}
