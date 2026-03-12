// ── Polymarket Wallet Preparation Service ────────────────────────────────────
//
// Handles the full lifecycle of preparing an agent's wallet for Polymarket:
//   1. Encrypted private key storage (AES-256-GCM via infra/encryption.ts)
//   2. On-chain balance verification (POL for gas, USDC for trading)
//   3. Automated Polymarket CLOB approvals (6 on-chain txs via CLI)
//
// WHY THIS EXISTS:
// Previously, wallet generation was client-side — the user had to manually
// download the private key, fund the wallet, and run approvals themselves.
// By generating the wallet server-side and encrypting the key at rest, we can
// automatically run `polymarket approve set` (which submits all 6 required
// ERC-20 allowance approvals to the CTF Exchange, Neg Risk adapters, etc.)
// once the user funds the address. This removes every manual step beyond
// sending funds, letting agents start trading instantly.
//
// ENCRYPTION FLOW:
// On agent creation → generateWalletCredentials() → encrypt(privateKey) with
// AES-256-GCM (server master key + random IV per encryption) → store
// iv:ciphertext:authTag in DB. On verify → decrypt() in memory only →
// set POLYMARKET_PRIVATE_KEY env temporarily → CLI signs the 6 approve txs
// → clear env + null out key. The decrypted key never touches disk or logs.
//
// CLI INTEGRATION:
// The Polymarket CLI (`polymarket approve set`) submits these 6 approvals:
//   1. USDC → ConditionalTokens (CTF) contract
//   2. USDC → CTF Exchange
//   3. CTF → CTF Exchange (conditional token transfer)
//   4. USDC → Neg Risk CTF Exchange
//   5. CTF → Neg Risk CTF Exchange
//   6. Neg Risk CTF → Neg Risk CTF Exchange
// After running `approve set`, we run `approve check <address>` to verify
// all 6 passed. If any fail (e.g. insufficient gas), the status is set to
// 'approval_failed' and the user can retry.
//
// SECURITY:
// - Decrypted key exists ONLY in a local variable within try/finally
// - process.env.POLYMARKET_PRIVATE_KEY is saved/restored in a nested finally
// - Errors are sanitized — key material never appears in logs or responses
// - Ownership (user_id) is verified before any decryption occurs
// - Rate-limited at the route level (3/min per user)
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne, pgExec } from "../db/postgres";
import { decrypt } from "../infra/encryption";
import { getPolBalanceSnapshot, getUsdcBalanceSnapshot } from "../utils/balances";
import { runCli } from "../cli";

// ── Constants ────────────────────────────────────────────────────────────────

// Minimum POL required for gas to submit 6 approval transactions on Polygon.
const MIN_POL_BALANCE = 1;

// Minimum USDC required to place any Polymarket order.
// CLI approve doesn't spend USDC, but we gate on this to ensure the agent
// can actually trade after approvals complete.
const MIN_USDC_BALANCE = 10.0;

// Timeout for CLI approve commands (ms). The `approve set` command submits
// 6 on-chain transactions sequentially, each needing block confirmation.
// 120s is generous but prevents hanging indefinitely.
const CLI_APPROVE_TIMEOUT_MS = 120_000;

// ── Types ────────────────────────────────────────────────────────────────────

export type PolymarketStatus =
  | "pending_funding"   // Wallet created, waiting for user to deposit
  | "funding_detected"  // Balances sufficient, ready for approval
  | "approving"         // CLI approve set is running
  | "approval_failed"   // One or more approvals failed (retryable)
  | "ready";            // All 6 approvals verified, agent can trade

export interface PolymarketPrepResult {
  status: PolymarketStatus;
  polymarketReady: boolean;
  address: string;
  balances: {
    pol: number;
    usdc: number;
    polSufficient: boolean;
    usdcSufficient: boolean;
  };
  approvals?: {
    allPassed: boolean;
    details: unknown;
  };
  missingItems?: string[];
  error?: string;
}

// DB row shape for the fields we need
interface AgentWalletRow {
  id: string;
  user_id: string | null;
  wallet_address: string | null;
  encrypted_private_key: string | null;
  polymarket_ready: number;
  polymarket_status: string | null;
}

// ── Database Helpers ─────────────────────────────────────────────────────────
// Dual-mode (SQLite + Pg) following the project's established pattern.

async function loadAgent(agentId: string): Promise<AgentWalletRow | null> {
  if (isPgEnabled()) {
    return pgQueryOne<AgentWalletRow>(
      `SELECT id, user_id, wallet_address, encrypted_private_key,
              polymarket_ready, polymarket_status
       FROM agents WHERE id = $1`,
      [agentId]
    );
  }

  const db = getDb();
  return (
    db
      .prepare(
        `SELECT id, user_id, wallet_address, encrypted_private_key,
                polymarket_ready, polymarket_status
         FROM agents WHERE id = ?`
      )
      .get(agentId) as AgentWalletRow | undefined
  ) ?? null;
}

async function updatePolymarketStatus(
  agentId: string,
  status: PolymarketStatus,
  ready: boolean
): Promise<void> {
  const now = Date.now();

  if (isPgEnabled()) {
    await pgExec(
      `UPDATE agents
       SET polymarket_status = $1, polymarket_ready = $2, updated_at = $3
       WHERE id = $4`,
      [status, ready ? 1 : 0, now, agentId]
    );
  } else {
    const db = getDb();
    db.prepare(
      `UPDATE agents
       SET polymarket_status = ?, polymarket_ready = ?, updated_at = ?
       WHERE id = ?`
    ).run(status, ready ? 1 : 0, now, agentId);
  }
}

// ── Approval Result Parser ───────────────────────────────────────────────────
// The `polymarket approve check <address> -o json` command returns a JSON
// object with approval statuses. We parse it to determine if all 6 passed.

function parseApprovalResult(raw: unknown): { allPassed: boolean; details: unknown } {
  // The CLI returns JSON with -o json flag. Shape varies by CLI version,
  // but we check for an array of results or an object with boolean fields.
  if (!raw || typeof raw !== "object") {
    return { allPassed: false, details: raw };
  }

  // If it's an array, check every entry has approved/status = true
  if (Array.isArray(raw)) {
    const allPassed = raw.length >= 6 && raw.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        ((entry as Record<string, unknown>).approved === true ||
         (entry as Record<string, unknown>).status === true ||
         (entry as Record<string, unknown>).status === "approved")
    );
    return { allPassed, details: raw };
  }

  // If it's an object with boolean values, check all are true
  const values = Object.values(raw as Record<string, unknown>);
  if (values.length >= 6 && values.every((v) => v === true)) {
    return { allPassed: true, details: raw };
  }

  return { allPassed: false, details: raw };
}

// ── Build Missing Items List ─────────────────────────────────────────────────
// Returns human-readable strings describing what the user still needs to do.

function buildMissingItems(
  polBalance: number,
  usdcBalance: number,
  approvalResult?: { allPassed: boolean; details: unknown }
): string[] {
  const items: string[] = [];

  if (polBalance < MIN_POL_BALANCE) {
    items.push(
      `Low POL: ${polBalance.toFixed(4)} POL (need >${MIN_POL_BALANCE} for gas fees)`
    );
  }

  if (usdcBalance < MIN_USDC_BALANCE) {
    items.push(
      `Low USDC: $${usdcBalance.toFixed(2)} (need >$${MIN_USDC_BALANCE} for trading)`
    );
  }

  if (approvalResult && !approvalResult.allPassed) {
    // Try to extract specific missing approvals from the details
    const details = approvalResult.details;
    if (Array.isArray(details)) {
      details.forEach((entry: unknown, i: number) => {
        if (
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>).approved !== true &&
          (entry as Record<string, unknown>).status !== true &&
          (entry as Record<string, unknown>).status !== "approved"
        ) {
          const name = (entry as Record<string, unknown>).name ?? `Approval #${i + 1}`;
          const contract = (entry as Record<string, unknown>).contract ?? "";
          items.push(`Missing approval: ${name}${contract ? ` (${contract})` : ""}`);
        }
      });
    } else if (typeof details === "object" && details !== null) {
      for (const [key, val] of Object.entries(details as Record<string, unknown>)) {
        if (val !== true) {
          items.push(`Missing approval: ${key}`);
        }
      }
    }

    if (items.length === 0 || !items.some((i) => i.startsWith("Missing approval"))) {
      items.push("One or more Polymarket CLOB approvals did not complete");
    }
  }

  return items;
}

// ── Core Function ────────────────────────────────────────────────────────────
//
// verifyAndPreparePolymarket(agentId, userId)
//
// Called when the user clicks "Verify Readiness" on the manage-agent page.
// Checks funding, runs CLI approvals if funded, and returns detailed status.

export async function verifyAndPreparePolymarket(
  agentId: string,
  userId: string
): Promise<PolymarketPrepResult> {
  // ── Step 1: Load agent and verify ownership ────────────────────────────
  const agent = await loadAgent(agentId);

  if (!agent || agent.user_id !== userId) {
    throw new Error("Agent not found");
  }

  if (!agent.wallet_address) {
    throw new Error("Agent has no wallet address");
  }

  if (!agent.encrypted_private_key) {
    throw new Error("Agent has no encrypted private key");
  }

  const address = agent.wallet_address;

  // ── Step 2: Return early if already ready ──────────────────────────────
  if (agent.polymarket_ready === 1) {
    const [polSnap, usdcSnap] = await Promise.all([
      getPolBalanceSnapshot(address),
      getUsdcBalanceSnapshot(address),
    ]);

    return {
      status: "ready",
      polymarketReady: true,
      address,
      balances: {
        pol: polSnap.balance,
        usdc: usdcSnap.balance,
        polSufficient: polSnap.balance >= MIN_POL_BALANCE,
        usdcSufficient: usdcSnap.balance >= MIN_USDC_BALANCE,
      },
    };
  }

  // ── Step 3: Check on-chain balances ────────────────────────────────────
  const [polSnap, usdcSnap] = await Promise.all([
    getPolBalanceSnapshot(address),
    getUsdcBalanceSnapshot(address),
  ]);

  const polSufficient = polSnap.balance >= MIN_POL_BALANCE;
  const usdcSufficient = usdcSnap.balance >= MIN_USDC_BALANCE;

  const balances = {
    pol: polSnap.balance,
    usdc: usdcSnap.balance,
    polSufficient,
    usdcSufficient,
  };

  // ── Step 4: If not funded, return pending status ───────────────────────
  if (!polSufficient || !usdcSufficient) {
    await updatePolymarketStatus(agentId, "pending_funding", false);

    return {
      status: "pending_funding",
      polymarketReady: false,
      address,
      balances,
      missingItems: buildMissingItems(polSnap.balance, usdcSnap.balance),
    };
  }

  // ── Step 5: Funded — run Polymarket CLI approvals ──────────────────────
  // This is the critical section: we decrypt the private key, set it as an
  // env var for the CLI, run the 6 approval transactions, then immediately
  // clear everything. The key NEVER touches disk or logs.

  await updatePolymarketStatus(agentId, "approving", false);

  let decryptedKey: string | null = null;
  const originalEnvKey = process.env.POLYMARKET_PRIVATE_KEY;

  try {
    // Decrypt the stored private key in memory
    decryptedKey = decrypt(agent.encrypted_private_key);

    // Set the env var that the Polymarket CLI reads for signing transactions.
    // This is the only way the CLI accepts a private key — via env.
    process.env.POLYMARKET_PRIVATE_KEY = decryptedKey;

    // Run `polymarket approve set` — submits all 6 approval transactions.
    // Each tx is an ERC-20 approve(spender, maxUint256) call to the
    // relevant Polymarket contracts on Polygon.
    console.log(`[polymarket-prep] Running approve set for agent ${agentId}`);

    try {
      await runCli(["approve", "set"]);
    } catch (approveErr) {
      // Log sanitized error (never include key material)
      const msg = approveErr instanceof Error ? approveErr.message : String(approveErr);
      console.error(`[polymarket-prep] approve set failed for agent ${agentId}: ${msg}`);

      await updatePolymarketStatus(agentId, "approval_failed", false);

      return {
        status: "approval_failed",
        polymarketReady: false,
        address,
        balances,
        missingItems: ["Polymarket approval transactions failed — check POL balance for gas"],
        error: "Approval transactions failed. Ensure wallet has sufficient POL for gas fees and retry.",
      };
    }

    // Run `polymarket approve check <address>` — verifies all 6 approvals.
    // Returns JSON with the status of each approval.
    console.log(`[polymarket-prep] Running approve check for agent ${agentId}`);

    let checkResult: unknown;
    try {
      checkResult = await runCli(["approve", "check", address]);
    } catch (checkErr) {
      const msg = checkErr instanceof Error ? checkErr.message : String(checkErr);
      console.error(`[polymarket-prep] approve check failed for agent ${agentId}: ${msg}`);

      await updatePolymarketStatus(agentId, "approval_failed", false);

      return {
        status: "approval_failed",
        polymarketReady: false,
        address,
        balances,
        missingItems: ["Could not verify approval status — retry to check again"],
        error: "Approval verification failed. Try again.",
      };
    }

    // ── Step 6: Parse results and update status ──────────────────────────
    const approvalResult = parseApprovalResult(checkResult);

    if (approvalResult.allPassed) {
      await updatePolymarketStatus(agentId, "ready", true);
      console.log(`[polymarket-prep] Agent ${agentId} is Polymarket-ready`);

      return {
        status: "ready",
        polymarketReady: true,
        address,
        balances,
        approvals: approvalResult,
      };
    } else {
      await updatePolymarketStatus(agentId, "approval_failed", false);
      console.warn(`[polymarket-prep] Agent ${agentId} has incomplete approvals`);

      return {
        status: "approval_failed",
        polymarketReady: false,
        address,
        balances,
        approvals: approvalResult,
        missingItems: buildMissingItems(polSnap.balance, usdcSnap.balance, approvalResult),
        error: "Some Polymarket approvals are incomplete. Retry or check gas balance.",
      };
    }
  } finally {
    // ── CRITICAL CLEANUP ─────────────────────────────────────────────────
    // Always restore the original env var and destroy the decrypted key,
    // even if an unexpected error occurs above.

    if (originalEnvKey !== undefined) {
      process.env.POLYMARKET_PRIVATE_KEY = originalEnvKey;
    } else {
      delete process.env.POLYMARKET_PRIVATE_KEY;
    }

    // Null out the local reference. In JS/TS we can't truly zero memory
    // (no SecureString), but nulling ensures no accidental reuse and makes
    // the string eligible for GC immediately.
    decryptedKey = null;
  }
}
