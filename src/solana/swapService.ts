import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getDbcClient, getSolanaConnection } from "./dbcClient";
import type { SwapQuoteResult as SdkSwapQuoteResult } from "@meteora-ag/dynamic-bonding-curve-sdk";

export interface SwapQuoteResult {
  amountIn: string;          // BN as string (smallest units, 6 decimals)
  amountOut: string;         // BN as string (tokens or USDC output)
  minimumAmountOut: string;  // BN after 2% slippage applied
  tradingFee: string;        // trading fee amount (same units as input)
  side: "buy" | "sell";
}

// Returns swap quote from Meteora DBC pool.
// amount: USDC for buy side (USDC→tokens), token amount for sell side (tokens→USDC).
// CRITICAL: Always uses slippageBps=200 (2%). Never passes BN(0) as minimumAmountOut.
export async function getSwapQuote(
  poolAddress: string,
  amount: number,
  side: "buy" | "sell"
): Promise<SwapQuoteResult> {
  const client = getDbcClient();
  const poolPubkey = new PublicKey(poolAddress);

  const poolState = await client.state.getPool(poolPubkey);
  const configState = await client.state.getPoolConfig(poolState.config);

  // USDC has 6 decimals on Solana. Token also has 6 decimals (TokenDecimal.SIX in buildCurveConfig).
  const amountIn = new BN(Math.floor(amount * 1_000_000));

  // sell: base→quote (tokens→USDC), buy: quote→base (USDC→tokens)
  const swapBaseForQuote = side === "sell";

  const quote: SdkSwapQuoteResult = client.pool.swapQuote({
    virtualPool: poolState,
    config: configState,
    swapBaseForQuote,
    amountIn,
    slippageBps: 200,                     // 2% slippage — always enforced, never 0
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false, // standard path (non-first-swap discount)
    currentPoint: new BN(0),
  });

  return {
    amountIn: amountIn.toString(),
    amountOut: (quote as unknown as { outputAmount: { toString: () => string } }).outputAmount.toString(),
    minimumAmountOut: quote.minimumAmountOut.toString(),
    tradingFee: (quote as unknown as { tradingFee: { toString: () => string } }).tradingFee.toString(),
    side,
  };
}

export interface SwapTransactionParams {
  poolAddress: string;
  amountIn: string;           // BN string from getSwapQuote
  minimumAmountOut: string;   // BN string from getSwapQuote (includes 2% slippage)
  side: "buy" | "sell";
  ownerPublicKey: string;     // user's wallet base58 address — they sign this tx
}

// Builds a swap transaction serialized as base64.
// User's wallet must sign it on the frontend (non-custodial per D-10).
// minimumAmountOut must come from getSwapQuote — never pass raw BN(0).
export async function buildSwapTransaction(
  params: SwapTransactionParams
): Promise<string> {
  const {
    poolAddress,
    amountIn,
    minimumAmountOut,
    side,
    ownerPublicKey,
  } = params;

  const client = getDbcClient();
  const connection = getSolanaConnection();

  const poolPubkey = new PublicKey(poolAddress);
  const ownerPubkey = new PublicKey(ownerPublicKey);
  const swapBaseForQuote = side === "sell"; // sell: tokens→USDC, buy: USDC→tokens

  const swapTx = await client.pool.swap({
    pool: poolPubkey,
    owner: ownerPubkey,
    amountIn: new BN(amountIn),
    minimumAmountOut: new BN(minimumAmountOut),
    swapBaseForQuote,
    referralTokenAccount: null,
  });

  // Set recent blockhash — required for transaction validity
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  swapTx.recentBlockhash = blockhash;
  swapTx.feePayer = ownerPubkey;

  // Serialize WITHOUT requiring all signatures — user wallet will sign on the frontend
  return swapTx.serialize({ requireAllSignatures: false }).toString("base64");
}
