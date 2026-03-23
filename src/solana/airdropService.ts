/**
 * Airdrop Service — buyback execution and atomic token distribution (Phase 3, Plan 02)
 *
 * Responsibilities:
 * - executeBuyback: swap USDC → agent tokens on DAMM v2 pool with 3% slippage (D-08, D-09)
 * - executeAirdrop: atomic multi-instruction Solana transaction: 30% to top-10 holders + 70% to Quantik (D-15)
 * - runWeeklyBuyback: cron-callable orchestrator that runs the full P&L → audit → buyback → distribute cycle
 *
 * Decisions honored:
 * - D-08: Direct DAMM v2 pool swap (no Jupiter)
 * - D-09: 3% buyback slippage (minimumAmountOut = amountOut * 0.97)
 * - D-10: Single transaction per agent per week
 * - D-11: Retry 3x with 30s/2min/10min backoff; after 3 failures → buyback_failed
 * - D-12: Top-10 snapshot taken immediately before distribution
 * - D-13: 30% to holders pro-rata by balance, 70% to Quantik wallet
 * - D-14: Treasury and Quantik wallets excluded from holder rankings (holderService)
 * - D-15: Airdrop executes as single atomic multi-instruction transaction
 * - D-16: Called from WEEKLY_BUYBACK BullMQ queue (scheduler)
 * - D-18: Socket.IO events: distribution:start, distribution:complete, distribution:failed
 */

import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery } from "../db/postgres";
import { getSolanaConnection } from "./dbcClient";
import { getDbcClient } from "./dbcClient";
import { decryptTreasuryKeypair } from "./treasuryService";
import { getSwapQuote } from "./swapService";
import { getTopHolders, calculateDistributionAmounts } from "./holderService";
import {
  calculateWeeklyPnl,
  auditAgainstPolymarket,
  computeBuybackAmount,
  createDistributionRecord,
  updateDistributionStatus,
} from "./buybackService";
import { emitToAll } from "../infra/socket";

// ── Constants ──────────────────────────────────────────────────────────────

const QUANTIK_PLATFORM_WALLET = process.env.QUANTIK_PLATFORM_WALLET ?? "";

// D-11: Retry delays in milliseconds: 30s, 2min, 10min
const BUYBACK_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

// ── Types ──────────────────────────────────────────────────────────────────

interface MigratedAgent {
  agent_id: string;
  token_mint: string;
  damm_pool_address: string;
  token_symbol: string;
}

// ── Buyback Execution (D-08, D-09, D-11) ──────────────────────────────────

/**
 * Swaps USDC → agent tokens on the DAMM v2 pool using treasury keypair.
 *
 * D-09: 3% slippage — minimumAmountOut = Math.floor(amountOut * 0.97)
 * D-11: Retries 3x with exponential backoff before marking buyback_failed.
 *
 * On success: updates distribution record to 'distributing' with buyback tx sig.
 * On failure after 3 retries: updates distribution record to 'buyback_failed'.
 *
 * @param distributionId - treasury_distributions record id
 * @param dammPoolAddress - base58 DAMM v2 pool address for the agent token
 * @param buybackAmountUsdc - USDC amount to spend on buyback
 * @returns tokens received from the swap, or 0 on failure
 */
export async function executeBuyback(
  distributionId: string,
  dammPoolAddress: string,
  buybackAmountUsdc: number
): Promise<number> {
  let lastError: Error = new Error("Unknown buyback error");

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Get swap quote from DAMM v2 pool (DBC SDK's getSwapQuote uses 2% slippage internally,
      // but for buybacks we apply 3% to amountOut per D-09)
      const quote = await getSwapQuote(dammPoolAddress, buybackAmountUsdc, "buy");

      // D-09: override to 3% slippage for buyback market buys
      const minimumAmountOut = Math.floor(Number(quote.amountOut) * 0.97);
      const amountIn = new BN(quote.amountIn);
      const minAmountOut = new BN(minimumAmountOut);

      const treasuryKeypair = decryptTreasuryKeypair();
      const client = getDbcClient();
      const connection = getSolanaConnection();

      const poolPubkey = new PublicKey(dammPoolAddress);

      // Build swap transaction — treasury wallet is the signer/owner
      const swapTx = await client.pool.swap({
        pool: poolPubkey,
        owner: treasuryKeypair.publicKey,
        amountIn,
        minimumAmountOut: minAmountOut,
        swapBaseForQuote: false, // buy: quote→base (USDC→tokens)
        referralTokenAccount: null,
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      swapTx.recentBlockhash = blockhash;
      swapTx.feePayer = treasuryKeypair.publicKey;

      const sig = await sendAndConfirmTransaction(connection, swapTx, [treasuryKeypair], {
        commitment: "confirmed",
        maxRetries: 3,
      });

      // Estimate tokens received: use amountOut from quote (actual may differ slightly due to slippage)
      const tokensReceived = Number(quote.amountOut) / 1_000_000;

      await updateDistributionStatus(distributionId, {
        status: "distributing",
        buyback_tx_signature: sig,
        tokens_bought: tokensReceived,
      });

      console.log(`[airdropService] Buyback succeeded: sig=${sig}, tokensReceived=${tokensReceived}`);
      return tokensReceived;

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[airdropService] Buyback attempt ${attempt + 1}/3 failed:`, lastError.message);

      if (attempt < 2) {
        // Wait before next retry
        await new Promise((resolve) => setTimeout(resolve, BUYBACK_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // All 3 attempts failed — mark buyback_failed (D-11)
  await updateDistributionStatus(distributionId, {
    status: "buyback_failed",
    failure_reason: lastError.message,
  });

  return 0;
}

// ── Airdrop Execution (D-13, D-15) ────────────────────────────────────────

/**
 * Distributes bought tokens atomically to top-10 holders (30%) and Quantik wallet (70%).
 *
 * D-13: 30% to holders pro-rata by balance. 70% to QUANTIK_PLATFORM_WALLET.
 * D-15: Single atomic Solana transaction (all-or-nothing). One tx fee.
 *
 * Creates ATAs for recipients that don't have one yet (same atomic tx).
 *
 * @param distributionId - treasury_distributions record id
 * @param tokenMint - base58 SPL token mint address
 * @param tokensBought - total tokens received from buyback swap
 * @param holders - top-10 holder entries (from getTopHolders)
 */
export async function executeAirdrop(
  distributionId: string,
  tokenMint: string,
  tokensBought: number,
  holders: Awaited<ReturnType<typeof getTopHolders>>
): Promise<boolean> {
  try {
    if (!QUANTIK_PLATFORM_WALLET) {
      throw new Error("QUANTIK_PLATFORM_WALLET env var not set — cannot execute airdrop");
    }

    const treasuryKeypair = decryptTreasuryKeypair();
    const connection = getSolanaConnection();
    const mintPubkey = new PublicKey(tokenMint);

    // Treasury's ATA for the agent token (receives tokens from buyback swap)
    const treasuryAta = getAssociatedTokenAddressSync(mintPubkey, treasuryKeypair.publicKey);

    // D-13: 30% to holders, 70% to Quantik wallet
    const holderAllocation = tokensBought * 0.30;
    const quantikAllocation = tokensBought * 0.70;

    const holderAmounts = calculateDistributionAmounts(holders, holderAllocation);
    const holderTotal = holderAmounts.reduce((sum, h) => sum + h.tokens, 0);

    // Build atomic transaction with all transfers
    const tx = new Transaction();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = treasuryKeypair.publicKey;

    // Helper: ensure ATA exists or add creation instruction
    const ensureAta = async (ownerPubkey: PublicKey): Promise<PublicKey> => {
      const ata = getAssociatedTokenAddressSync(mintPubkey, ownerPubkey);
      try {
        await getAccount(connection, ata, "confirmed");
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
          // Add creation instruction to the same atomic tx
          tx.add(
            createAssociatedTokenAccountInstruction(
              treasuryKeypair.publicKey, // payer
              ata,                       // new ATA address
              ownerPubkey,               // owner
              mintPubkey,                // mint
            )
          );
        } else {
          throw err;
        }
      }
      return ata;
    };

    // Add holder transfer instructions (30% pro-rata)
    for (const { wallet, tokens } of holderAmounts) {
      const recipientPubkey = new PublicKey(wallet);
      const recipientAta = await ensureAta(recipientPubkey);
      const rawAmount = BigInt(Math.floor(tokens * 1_000_000));

      tx.add(
        createTransferInstruction(
          treasuryAta,     // source: treasury's ATA
          recipientAta,    // destination: holder's ATA
          treasuryKeypair.publicKey, // owner of source ATA
          rawAmount,
          [],
          TOKEN_PROGRAM_ID
        )
      );
    }

    // Add Quantik wallet transfer instruction (70%)
    const quantikPubkey = new PublicKey(QUANTIK_PLATFORM_WALLET);
    const quantikAta = await ensureAta(quantikPubkey);
    const quantikRawAmount = BigInt(Math.floor(quantikAllocation * 1_000_000));

    tx.add(
      createTransferInstruction(
        treasuryAta,
        quantikAta,
        treasuryKeypair.publicKey,
        quantikRawAmount,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    // D-15: send single atomic transaction — all succeed or all fail
    const sig = await sendAndConfirmTransaction(connection, tx, [treasuryKeypair], {
      commitment: "confirmed",
      maxRetries: 3,
    });

    await updateDistributionStatus(distributionId, {
      status: "complete",
      holder_distribution_tx_signature: sig,
      quantik_wallet_tokens: quantikAllocation,
      holder_tokens: holderTotal,
      completed_at: Date.now(),
    });

    console.log(`[airdropService] Airdrop complete: sig=${sig}, holders=${holderAmounts.length}, holderTokens=${holderTotal}, quantikTokens=${quantikAllocation}`);
    return true;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[airdropService] Airdrop failed:", message);
    await updateDistributionStatus(distributionId, {
      status: "buyback_failed",
      failure_reason: `airdrop: ${message}`,
    });
    return false;
  }
}

// ── Weekly Buyback Orchestrator (D-16) ─────────────────────────────────────

/**
 * Main cron processor: runs the full P&L → audit → buyback → distribute cycle
 * for all tokenized agents with migrated DAMM v2 pools.
 *
 * Called from BullMQ WEEKLY_BUYBACK queue (Friday midnight UTC) and legacy setInterval.
 * Emits Socket.IO events for distribution:start, distribution:complete, distribution:failed (D-18).
 */
export async function runWeeklyBuyback(): Promise<void> {
  console.log("[airdropService] Starting weekly buyback cycle...");

  // Determine the current week window (Friday-to-Friday UTC)
  const now = Date.now();
  const weekEnd = now;
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;

  // Query all agents with migrated DAMM v2 pools
  let agents: MigratedAgent[];

  if (isPgEnabled()) {
    const rows = await pgQuery<MigratedAgent>(
      `SELECT agent_id, token_mint, damm_pool_address, token_symbol
       FROM solana_tokens
       WHERE status = 'migrated' AND damm_pool_address IS NOT NULL`
    );
    agents = rows;
  } else {
    const db = getDb();
    agents = db.prepare(
      `SELECT agent_id, token_mint, damm_pool_address, token_symbol
       FROM solana_tokens
       WHERE status = 'migrated' AND damm_pool_address IS NOT NULL`
    ).all() as MigratedAgent[];
  }

  if (agents.length === 0) {
    console.log("[airdropService] No migrated agents found — skipping weekly buyback");
    return;
  }

  console.log(`[airdropService] Processing ${agents.length} eligible agent(s)...`);

  for (const agent of agents) {
    const { agent_id, token_mint, damm_pool_address, token_symbol } = agent;

    try {
      // Step 1: Calculate weekly P&L
      const weeklyPnl = await calculateWeeklyPnl(agent_id, weekStart, weekEnd);
      const buybackAmount = computeBuybackAmount(weeklyPnl);

      if (buybackAmount === 0) {
        // D-05/D-06: losing week or below $10 threshold — skip buyback, record as skipped
        const skipId = await createDistributionRecord(
          agent_id, token_mint, weekStart, weekEnd, weeklyPnl, 0
        );
        await updateDistributionStatus(skipId, { status: "skipped" });
        console.log(`[airdropService] Agent ${agent_id} skipped — weeklyPnl=${weeklyPnl}, buyback=0`);
        continue;
      }

      // Step 2: Audit against Polymarket (D-03, D-07)
      const audit = await auditAgainstPolymarket(agent_id, weekStart, weekEnd, weeklyPnl);

      if (!audit.passed) {
        const auditFailId = await createDistributionRecord(
          agent_id, token_mint, weekStart, weekEnd, weeklyPnl, buybackAmount
        );
        await updateDistributionStatus(auditFailId, {
          status: "audit_failed",
          audit_status: "failed",
          audit_discrepancy_pct: audit.discrepancyPct,
          failure_reason: `Audit failed: discrepancy=${audit.discrepancyPct.toFixed(2)}%`,
        });

        // D-18: distribution:failed event
        emitToAll("distribution:failed", {
          agentId: agent_id,
          tokenSymbol: token_symbol,
          reason: `P&L audit failed (discrepancy: ${audit.discrepancyPct.toFixed(2)}%)`,
        });

        console.error(`[airdropService] Audit failed for agent ${agent_id}: discrepancy=${audit.discrepancyPct}%`);
        continue;
      }

      // Step 3: Create distribution record (status='pending')
      const distributionId = await createDistributionRecord(
        agent_id, token_mint, weekStart, weekEnd, weeklyPnl, buybackAmount
      );
      await updateDistributionStatus(distributionId, { audit_status: "passed" });

      // D-18: distribution:start event
      emitToAll("distribution:start", {
        agentId: agent_id,
        tokenSymbol: token_symbol,
        buybackAmountUsdc: buybackAmount,
      });

      console.log(`[airdropService] Starting buyback for agent ${agent_id}: $${buybackAmount} USDC`);

      // Step 4: Execute buyback (USDC → tokens on DAMM v2)
      const tokensBought = await executeBuyback(distributionId, damm_pool_address, buybackAmount);

      if (tokensBought === 0) {
        // D-18: distribution:failed event (executeBuyback already updated status)
        emitToAll("distribution:failed", {
          agentId: agent_id,
          tokenSymbol: token_symbol,
          reason: "Buyback execution failed after 3 retries",
        });
        continue;
      }

      // Step 5: Snapshot top holders right before distribution (D-12)
      const holders = await getTopHolders(token_mint, 10);

      if (holders.length === 0) {
        console.warn(`[airdropService] No holders found for ${token_symbol} — sending all to Quantik wallet`);
      }

      // Step 6: Execute atomic airdrop (30% holders, 70% Quantik)
      const airdropSuccess = await executeAirdrop(distributionId, token_mint, tokensBought, holders);

      if (!airdropSuccess) {
        // D-18: distribution:failed event (executeAirdrop already updated status)
        emitToAll("distribution:failed", {
          agentId: agent_id,
          tokenSymbol: token_symbol,
          reason: "Airdrop transaction failed",
        });
        continue;
      }

      // D-18: distribution:complete event
      emitToAll("distribution:complete", {
        agentId: agent_id,
        tokenSymbol: token_symbol,
        tokensBought,
        holderCount: holders.length,
      });

      console.log(`[airdropService] Weekly buyback complete for ${token_symbol}: tokensBought=${tokensBought}, holders=${holders.length}`);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[airdropService] Unexpected error for agent ${agent_id}:`, message);

      emitToAll("distribution:failed", {
        agentId: agent_id,
        tokenSymbol: token_symbol,
        reason: `Unexpected error: ${message}`,
      });
    }
  }

  console.log("[airdropService] Weekly buyback cycle complete.");
}
