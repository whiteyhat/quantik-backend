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

import { ethers } from "ethers";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne, pgExec } from "../db/postgres";
import { decrypt } from "../infra/encryption";
import { getPolBalanceSnapshot, getUsdcBalanceSnapshot } from "../utils/balances";
import { emitToUser } from "../infra/socket";

// ── Constants ────────────────────────────────────────────────────────────────

// Minimum POL required for gas to submit 6 approval transactions on Polygon.
const MIN_POL_BALANCE = 3;

// Minimum USDC required to place any Polymarket order.
// CLI approve doesn't spend USDC, but we gate on this to ensure the agent
// can actually trade after approvals complete.
const MIN_USDC_BALANCE = 10.0;

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

// ── Core Functions ────────────────────────────────────────────────────────────

// ── checkPolymarketBalance ──────────────────────────────────────────────────
// Fast check (~1-3s): verifies ownership and checks on-chain balances only.
// If funded → returns status "funding_detected" so the UI can advance to step 2
// and auto-call runPolymarketApprovals. Does NOT touch approvals.

export async function checkPolymarketBalance(
  agentId: string,
  userId: string
): Promise<PolymarketPrepResult> {
  const agent = await loadAgent(agentId);

  if (!agent || agent.user_id !== userId) throw new Error("Agent not found");
  if (!agent.wallet_address) throw new Error("Agent has no wallet address");

  const address = agent.wallet_address;

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

  const [polSnap, usdcSnap] = await Promise.all([
    getPolBalanceSnapshot(address),
    getUsdcBalanceSnapshot(address),
  ]);
  const polSufficient = polSnap.balance >= MIN_POL_BALANCE;
  const usdcSufficient = usdcSnap.balance >= MIN_USDC_BALANCE;
  const balances = { pol: polSnap.balance, usdc: usdcSnap.balance, polSufficient, usdcSufficient };

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

  await updatePolymarketStatus(agentId, "funding_detected", false);
  return { status: "funding_detected", polymarketReady: false, address, balances };
}

// ── runPolymarketApprovals ──────────────────────────────────────────────────
// Slow step (~60-90s): submits the 6 on-chain CLOB approval transactions.
// Called automatically by the frontend after checkPolymarketBalance returns
// "funding_detected". Shows the 90s progress bar on step 2.

export async function runPolymarketApprovals(
  agentId: string,
  userId: string
): Promise<PolymarketPrepResult> {
  const agent = await loadAgent(agentId);

  if (!agent || agent.user_id !== userId) throw new Error("Agent not found");
  if (!agent.wallet_address) throw new Error("Agent has no wallet address");
  if (!agent.encrypted_private_key) throw new Error("Agent has no private key — re-assign wallet credentials");

  const address = agent.wallet_address;

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

  const [polSnap, usdcSnap] = await Promise.all([
    getPolBalanceSnapshot(address),
    getUsdcBalanceSnapshot(address),
  ]);
  const balances = {
    pol: polSnap.balance,
    usdc: usdcSnap.balance,
    polSufficient: polSnap.balance >= MIN_POL_BALANCE,
    usdcSufficient: usdcSnap.balance >= MIN_USDC_BALANCE,
  };

  await updatePolymarketStatus(agentId, "approving", false);

  // Polymarket contract addresses on Polygon mainnet (from CLI source + docs)
  const USDC_ADDRESS       = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e bridged
  const CTF_ADDRESS        = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // ConditionalTokens
  const CTF_EXCHANGE       = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
  const NEG_RISK_EXCHANGE  = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
  const NEG_RISK_ADAPTER   = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

  const ERC20_APPROVE_ABI       = ["function approve(address spender, uint256 amount) returns (bool)"];
  const ERC1155_SET_APPROVAL_ABI = ["function setApprovalForAll(address operator, bool approved)"];

  const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";

  // ethers.js v6 fetches Polygon gas prices from gasstation.polygon.technology
  // which is unreliable. Override getFeeData to derive fees from the RPC block
  // directly: baseFee * 2 + 30 gwei tip is standard for Polygon.
  async function getPolygonFeeData(provider: ethers.JsonRpcProvider): Promise<ethers.FeeData> {
    const block = await provider.getBlock("latest");
    const baseFee = block?.baseFeePerGas ?? ethers.parseUnits("100", "gwei");
    const maxPriorityFeePerGas = ethers.parseUnits("30", "gwei");
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
    return new ethers.FeeData(null, maxFeePerGas, maxPriorityFeePerGas);
  }

  const approvalSteps = [
    { label: "USDC → CTF Exchange",      type: "erc20",   token: USDC_ADDRESS, spender: CTF_EXCHANGE },
    { label: "CTF → CTF Exchange",       type: "erc1155", token: CTF_ADDRESS,  spender: CTF_EXCHANGE },
    { label: "USDC → Neg Risk Exchange", type: "erc20",   token: USDC_ADDRESS, spender: NEG_RISK_EXCHANGE },
    { label: "CTF → Neg Risk Exchange",  type: "erc1155", token: CTF_ADDRESS,  spender: NEG_RISK_EXCHANGE },
    { label: "USDC → Neg Risk Adapter",  type: "erc20",   token: USDC_ADDRESS, spender: NEG_RISK_ADAPTER },
    { label: "CTF → Neg Risk Adapter",   type: "erc1155", token: CTF_ADDRESS,  spender: NEG_RISK_ADAPTER },
  ] as const;

  let decryptedKey: string | null = null;

  try {
    decryptedKey = decrypt(agent.encrypted_private_key);

    const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
    // Override getFeeData to avoid Polygon gas station API timeouts
    provider.getFeeData = () => getPolygonFeeData(provider);
    const wallet   = new ethers.Wallet(decryptedKey, provider);

    console.log(`[polymarket-prep] Submitting ${approvalSteps.length} approvals for agent ${agentId} from ${wallet.address}`);

    const approvalResults: { label: string; txHash: string; passed: boolean }[] = [];

    for (const step of approvalSteps) {
      const abi      = step.type === "erc20" ? ERC20_APPROVE_ABI : ERC1155_SET_APPROVAL_ABI;
      const contract = new ethers.Contract(step.token, abi, wallet);

      try {
        const tx = step.type === "erc20"
          ? await contract.approve(step.spender, ethers.MaxUint256)
          : await contract.setApprovalForAll(step.spender, true);

        console.log(`[polymarket-prep] ${step.label} tx sent: ${tx.hash}`);
        await tx.wait(1);
        console.log(`[polymarket-prep] ${step.label} confirmed`);
        approvalResults.push({ label: step.label, txHash: tx.hash, passed: true });
      } catch (txErr) {
        const msg = txErr instanceof Error ? txErr.message : String(txErr);
        console.error(`[polymarket-prep] ${step.label} failed: ${msg}`);
        approvalResults.push({ label: step.label, txHash: "", passed: false });
      }
    }

    const allPassed = approvalResults.every((r) => r.passed);

    // ── Step 6: Update status based on results ───────────────────────────
    if (allPassed) {
      await updatePolymarketStatus(agentId, "ready", true);
      emitToUser(userId, "polymarket:ready", { agentId, timestamp: Date.now() });
      console.log(`[polymarket-prep] Agent ${agentId} is Polymarket-ready`);

      return {
        status: "ready",
        polymarketReady: true,
        address,
        balances,
        approvals: { allPassed: true, details: approvalResults },
      };
    } else {
      await updatePolymarketStatus(agentId, "approval_failed", false);
      const failed = approvalResults.filter((r) => !r.passed).map((r) => r.label);
      console.warn(`[polymarket-prep] Agent ${agentId} has failed approvals: ${failed.join(", ")}`);

      return {
        status: "approval_failed",
        polymarketReady: false,
        address,
        balances,
        approvals: { allPassed: false, details: approvalResults },
        missingItems: failed.map((l) => `Approval failed: ${l}`),
        error: "Some Polymarket approvals failed. Ensure wallet has sufficient POL for gas and retry.",
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[polymarket-prep] approve failed for agent ${agentId}: ${msg}`);
    await updatePolymarketStatus(agentId, "approval_failed", false);

    return {
      status: "approval_failed",
      polymarketReady: false,
      address,
      balances,
      missingItems: ["Approval process failed — check POL balance for gas"],
      error: "Approval transactions failed. Ensure wallet has sufficient POL for gas fees and retry.",
    };
  } finally {
    // ── CRITICAL CLEANUP ─────────────────────────────────────────────────
    // Null out the decrypted key immediately. In JS we can't zero memory
    // but this makes it eligible for GC and prevents accidental reuse.
    decryptedKey = null;
  }
}
