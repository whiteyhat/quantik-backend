/**
 * Holder Service — on-chain top-N holder snapshot for agent tokens.
 *
 * Responsibilities:
 * - getTopHolders: fetch all SPL token accounts for a mint, exclude treasury/Quantik wallets,
 *   sort by balance descending, return top N with pro-rata share calculation.
 * - calculateDistributionAmounts: compute per-wallet token amounts for the 30% holder allocation.
 *
 * Decisions honored:
 * - D-12: snapshot taken right before buyback execution (caller responsibility)
 * - D-13: pro-rata distribution by balance among top 10
 * - D-14: treasury wallet and Quantik platform wallet excluded from ranking
 */

import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getSolanaConnection } from "./dbcClient";
import { getTreasuryPublicKey } from "./treasuryService";

export interface HolderEntry {
  wallet: string;        // base58 wallet address
  balance: number;       // token balance (human-readable, 6 decimals normalized)
  shareOfTopTen: number; // fraction of total top-10 balance (0.0 to 1.0)
}

const QUANTIK_PLATFORM_WALLET = process.env.QUANTIK_PLATFORM_WALLET ?? "";

/**
 * Returns top-N holders for a given SPL token mint, excluding treasury and Quantik wallets.
 *
 * Uses TOKEN_PROGRAM_ID getProgramAccounts with memcmp filter on mint address.
 *
 * Per D-12: snapshot taken right before buyback execution (caller's responsibility to time it).
 * Per D-14: treasury wallet and Quantik platform wallet excluded from ranking.
 *
 * @param tokenMint - base58 SPL token mint address
 * @param topN - max holders to return (default 10 per D-13)
 */
export async function getTopHolders(
  tokenMint: string,
  topN: number = 10
): Promise<HolderEntry[]> {
  const connection = getSolanaConnection();
  const mintPubkey = new PublicKey(tokenMint);

  // Exclusion list: treasury wallet + Quantik platform wallet
  const exclusions = new Set<string>();
  try {
    exclusions.add(getTreasuryPublicKey());
  } catch {
    // TREASURY_ENCRYPTED_KEY not set in test/dev env — skip exclusion
  }
  if (QUANTIK_PLATFORM_WALLET) exclusions.add(QUANTIK_PLATFORM_WALLET);

  // Fetch all token accounts for this mint via getProgramAccounts
  // Filter: dataSize=165 (standard SPL token account) + mint at offset 0
  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 }, // SPL token account size
      {
        memcmp: {
          offset: 0, // mint pubkey is at bytes 0-31 in token account data
          bytes: mintPubkey.toBase58(),
        },
      },
    ],
  });

  // Parse token account data layout (165 bytes):
  //   0-31: mint address
  //  32-63: owner wallet address
  //  64-71: amount (u64, little-endian)
  const holders: { wallet: string; balance: number }[] = [];
  for (const account of accounts) {
    const data = account.account.data;

    const ownerBytes = data.slice(32, 64);
    const owner = new PublicKey(ownerBytes).toBase58();

    if (exclusions.has(owner)) continue;

    const amountBytes = data.slice(64, 72);
    const amountBigInt = Buffer.from(amountBytes).readBigUInt64LE(0);
    const balance = Number(amountBigInt) / 1_000_000; // 6 decimals

    if (balance > 0) {
      holders.push({ wallet: owner, balance });
    }
  }

  // Sort descending by balance, take top N
  holders.sort((a, b) => b.balance - a.balance);
  const top = holders.slice(0, topN);

  if (top.length === 0) return [];

  const totalBalance = top.reduce((sum, h) => sum + h.balance, 0);
  return top.map((h) => ({
    wallet: h.wallet,
    balance: h.balance,
    shareOfTopTen: totalBalance > 0 ? h.balance / totalBalance : 0,
  }));
}

/**
 * Calculates pro-rata token amounts for each holder given a total distribution amount.
 *
 * Per D-13: pro-rata by balance among top 10. If holder #1 holds 40% of the top-10
 * total balance, they receive 40% of the 30% allocation.
 *
 * @param holders - output from getTopHolders (with shareOfTopTen populated)
 * @param totalTokens - total tokens to distribute (i.e., tokensBought * 0.30)
 * @returns per-wallet distribution amounts (only entries where tokens > 0)
 */
export function calculateDistributionAmounts(
  holders: HolderEntry[],
  totalTokens: number
): { wallet: string; tokens: number }[] {
  return holders
    .map((h) => ({
      wallet: h.wallet,
      tokens: Math.floor(totalTokens * h.shareOfTopTen * 1_000_000) / 1_000_000, // 6 decimal precision
    }))
    .filter((h) => h.tokens > 0);
}
