import {
  buildCurveWithMarketCap,
  deriveDbcPoolAddress,
  TokenType,
  TokenDecimal,
  ActivationType,
  CollectFeeMode,
  BaseFeeMode,
  MigrationOption,
  MigrationFeeOption,
  TokenUpdateAuthorityOption,
  type FeeConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { Server as SocketIOServer } from "socket.io";
import { randomUUID } from "crypto";
import { decryptTreasuryKeypair, getTreasuryPublicKey } from "./treasuryService";
import { getDbcClient, getSolanaConnection } from "./dbcClient";
import { generateTokenImage, uploadTokenMetadata } from "./tokenImageGenerator";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne, pgExec } from "../db/postgres";

// USDC mint — use devnet address during development, mainnet for production
const USDC_MINT = new PublicKey(
  process.env.SOLANA_NETWORK === "mainnet-beta"
    ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

// Default Quantik agent codes — pass through symbol unchanged
const DEFAULT_AGENT_CODES = new Set(["AURA", "FLUX", "CLAUSE", "ORACLE", "EDGE", "LUCIFER", "SIGMA"]);

// ── generateTokenSymbol ────────────────────────────────────────────────────
// For default agents: returns agentCode unchanged.
// For BYO agents (agentCode is null or not in defaults): first 3-5 chars of name, uppercased.
export function generateTokenSymbol(agentName: string, agentCode: string | null): string {
  if (agentCode && DEFAULT_AGENT_CODES.has(agentCode.toUpperCase())) {
    return agentCode.toUpperCase();
  }
  const clean = agentName.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return clean.slice(0, 5);
}

// Standardized fee configuration constants — accessible for tests and DB writes
const CURVE_FEE_PARAMS: FeeConfig = {
  baseFeeParams: {
    baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
    feeSchedulerParam: {
      startingFeeBps: 200,   // 2% trading fee (per D standardized params)
      endingFeeBps: 200,     // constant — no decay
      numberOfPeriod: 0,
      totalDuration: 0,
    },
  },
  dynamicFeeEnabled: false,
  collectFeeMode: CollectFeeMode.QuoteToken,   // fees in USDC
  creatorTradingFeePercentage: 100,            // 100% of creator share to Quantik treasury
  poolCreationFee: 0,
  enableFirstSwapWithMinFee: false,
};

// ── buildCurveConfig ───────────────────────────────────────────────────────
// Returns standardized DBC curve parameters (locked by CONTEXT.md decisions).
// All parameters are fixed — no customization allowed per D-02.
// The return includes both the processed on-chain params AND the original fee
// params (under `fee`) so callers can inspect configuration values.
export function buildCurveConfig() {
  const curveParams = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPL,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.SIX,
      tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000,
      leftover: 0,
    },
    fee: CURVE_FEE_PARAMS,
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,         // CRITICAL: DAMM v2, NOT Raydium
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 100,  // Lock all LP
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Slot,
    initialMarketCap: 0.1,       // 0.1 USDC initial market cap
    migrationMarketCap: 50_000,  // 50K USDC migration threshold
  });

  // Attach original fee params and migration option so callers/tests can verify them
  return {
    ...curveParams,
    fee: CURVE_FEE_PARAMS,
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
  };
}

// ── createToken ────────────────────────────────────────────────────────────
// Creates SPL token + DBC pool. Treasury wallet signs everything.
// Emits Socket.IO progress to userId room. Returns DB token record on success.
export async function createToken(
  agentId: string,
  userId: string,
  io: SocketIOServer,
  agentName: string,
  agentCode: string | null,
  avatarEmoji: string
): Promise<{ tokenMint: string; poolAddress: string; configAddress: string }> {
  // Idempotency: check if already tokenized
  let existing: { token_mint: string } | null = null;
  if (isPgEnabled()) {
    existing = await pgQueryOne<{ token_mint: string }>(
      "SELECT token_mint FROM solana_tokens WHERE agent_id = $1",
      [agentId]
    );
  } else {
    const db = getDb();
    existing = db.prepare("SELECT token_mint FROM solana_tokens WHERE agent_id = ?").get(agentId) as { token_mint: string } | null;
  }
  if (existing) throw new Error(`Agent already tokenized: ${existing.token_mint}`);

  const emit = (step: string, progress: number): void => {
    io.to(userId).emit("token:progress", { step, progress });
  };

  emit("creating_token", 10);

  // Step 1: Generate token image + upload metadata to Pinata
  const symbol = generateTokenSymbol(agentName, agentCode);
  const imageBuffer = await generateTokenImage(avatarEmoji, agentName);
  emit("creating_token", 20);

  const metadataUri = await uploadTokenMetadata({
    name: agentName,
    symbol,
    description: `${agentName} agent token — trade on Quantik bonding curve`,
    imageBuffer,
  });
  emit("creating_token", 35);

  // Step 2: Build curve config
  const curveConfig = buildCurveConfig();
  const treasuryKeypair = decryptTreasuryKeypair();
  const client = getDbcClient();
  const connection = getSolanaConnection();

  // Step 3: Create DBC config account
  const configKeypair = Keypair.generate();
  emit("launching_curve", 50);

  const configTx = await client.partner.createConfig({
    config: configKeypair.publicKey,
    feeClaimer: treasuryKeypair.publicKey,
    leftoverReceiver: treasuryKeypair.publicKey,
    payer: treasuryKeypair.publicKey,
    quoteMint: USDC_MINT,
    ...curveConfig,
  });
  await sendAndConfirmTransaction(connection, configTx, [treasuryKeypair, configKeypair], { commitment: "confirmed" });
  emit("launching_curve", 65);

  // Step 4: Create DBC pool (creates the SPL token mint internally)
  // Uses client.pool.createPool — correct service per SDK v2 architecture
  const baseMintKeypair = Keypair.generate();
  const poolTx = await client.pool.createPool({
    config: configKeypair.publicKey,
    baseMint: baseMintKeypair.publicKey,
    payer: treasuryKeypair.publicKey,
    poolCreator: treasuryKeypair.publicKey,
    name: agentName,
    symbol,
    uri: metadataUri,
  });
  await sendAndConfirmTransaction(connection, poolTx, [treasuryKeypair, baseMintKeypair], { commitment: "confirmed" });
  emit("confirming", 85);

  // Step 5: Derive pool address deterministically from config + baseMint
  const poolAddress = deriveDbcPoolAddress(USDC_MINT, baseMintKeypair.publicKey, configKeypair.publicKey);

  const tokenMint = baseMintKeypair.publicKey.toBase58();
  const poolAddressStr = poolAddress.toBase58();
  const configAddressStr = configKeypair.publicKey.toBase58();
  const treasuryPubkey = getTreasuryPublicKey();
  const now = Date.now();
  const id = randomUUID();

  // Step 6: Persist to DB
  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO solana_tokens
        (id, agent_id, token_mint, dbc_pool_address, dbc_config_address, status,
         token_name, token_symbol, metadata_uri, treasury_wallet_pubkey,
         total_supply, initial_reserve_usdc, migration_threshold_usdc, fee_bps, created_at)
       VALUES ($1,$2,$3,$4,$5,'bonding',$6,$7,$8,$9,1000000,0.1,50000,200,$10)`,
      [id, agentId, tokenMint, poolAddressStr, configAddressStr, agentName, symbol, metadataUri, treasuryPubkey, now]
    );
  } else {
    const db = getDb();
    db.prepare(
      `INSERT INTO solana_tokens
        (id, agent_id, token_mint, dbc_pool_address, dbc_config_address, status,
         token_name, token_symbol, metadata_uri, treasury_wallet_pubkey,
         total_supply, initial_reserve_usdc, migration_threshold_usdc, fee_bps, created_at)
       VALUES (?,?,?,?,?,'bonding',?,?,?,?,1000000,0.1,50000,200,?)`
    ).run(id, agentId, tokenMint, poolAddressStr, configAddressStr, agentName, symbol, metadataUri, treasuryPubkey, now);
  }

  emit("confirming", 100);
  io.to(userId).emit("token:created", {
    tokenMint,
    poolAddress: poolAddressStr,
    explorerUrl: `https://solscan.io/token/${tokenMint}${process.env.SOLANA_NETWORK !== "mainnet-beta" ? "?cluster=devnet" : ""}`,
  });

  return { tokenMint, poolAddress: poolAddressStr, configAddress: configAddressStr };
}
