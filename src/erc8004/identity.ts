// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 Identity Service — Agent On-Chain Registration & URI Management
// ─────────────────────────────────────────────────────────────────────────────
// Registers Quantik agents on the ERC-8004 Identity Registry (Sepolia).
// Each agent receives a unique tokenId (ERC-721 NFT) linked to its agentURI.
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import { getIdentityContract, isErc8004Configured, ERC8004_CONFIG } from "./config";
import { getReputationSummary } from "./reputation";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne, pgExec, dualExec } from "../db/postgres";

// ── Types ───────────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  avatar_emoji: string;
  erc8004_token_id: string | null;
  erc8004_tx_hash: string | null;
  erc8004_registered_at: number | null;
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Register an agent on the ERC-8004 Identity Registry.
 * Calls `register(agentURI)` on-chain and stores the returned tokenId in the DB.
 */
export async function registerAgentIdentity(
  agentId: string
): Promise<{ txHash: string; tokenId: string; etherscanUrl: string }> {
  if (!isErc8004Configured()) {
    throw new Error(
      "ERC-8004 not configured — set ERC8004_PRIVATE_KEY and registry addresses"
    );
  }

  // Load agent from DB (dual-mode)
  const agent = isPgEnabled()
    ? await pgQueryOne<AgentRow>(
        "SELECT id, name, description, avatar_emoji, erc8004_token_id, erc8004_tx_hash, erc8004_registered_at FROM agents WHERE id = $1",
        [agentId]
      )
    : (getDb()
        .prepare(
          "SELECT id, name, description, avatar_emoji, erc8004_token_id, erc8004_tx_hash, erc8004_registered_at FROM agents WHERE id = ?"
        )
        .get(agentId) as AgentRow | undefined) ?? null;

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Construct agentURI pointing to our metadata endpoint
  const agentURI = `${
    process.env.BACKEND_URL || "https://api.quantik.fun"
  }/api/erc8004/metadata/${agentId}`;

  // Call register() on Identity Registry
  const contract = getIdentityContract();
  const tx = await contract.register(agentURI);
  const receipt = await tx.wait();

  // Extract tokenId from the ERC-721 Transfer event (mint: from=0x0).
  // The on-chain contract's registration event uses a non-standard signature,
  // but the standard ERC-721 Transfer(address,address,uint256) is always emitted
  // on mint and reliably carries the tokenId in topics[3].
  const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
  let tokenId: string | null = null;

  for (const log of receipt?.logs ?? []) {
    if (
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[1] === ethers.zeroPadValue("0x00", 32) && // from = zero address (mint)
      log.topics.length >= 4
    ) {
      tokenId = BigInt(log.topics[3]).toString();
      break;
    }
  }

  if (!tokenId) {
    throw new Error(
      "Registration tx succeeded but no Transfer (mint) event found in receipt"
    );
  }

  // Update agent in DB (dual-mode)
  const now = Date.now();
  if (isPgEnabled()) {
    await pgExec(
      "UPDATE agents SET erc8004_token_id = $1, erc8004_tx_hash = $2, erc8004_registered_at = $3 WHERE id = $4",
      [tokenId, tx.hash, now, agentId]
    );
  } else {
    getDb()
      .prepare(
        "UPDATE agents SET erc8004_token_id = ?, erc8004_tx_hash = ?, erc8004_registered_at = ? WHERE id = ?"
      )
      .run(tokenId, tx.hash, now, agentId);
  }

  // Sync initial reputation score (will be 0 for a fresh agent — but shows "0 pts" instead of "—")
  try {
    const summary = await getReputationSummary(tokenId);
    await dualExec(
      "UPDATE agents SET erc8004_reputation_score = $1 WHERE id = $2",
      [summary.summaryValue, agentId]
    );
  } catch {
    // Non-critical — fresh agents may have no reputation data yet
    // Set to 0 so the card shows "0 pts" instead of "—"
    await dualExec(
      "UPDATE agents SET erc8004_reputation_score = 0 WHERE id = $1",
      [agentId]
    ).catch(() => {});
  }

  return {
    txHash: tx.hash,
    tokenId,
    etherscanUrl: `https://sepolia.etherscan.io/tx/${tx.hash}`,
  };
}

// ── Identity Query ──────────────────────────────────────────────────────────

/**
 * Get the on-chain identity status for an agent (from DB cache).
 */
export async function getAgentIdentity(
  agentId: string
): Promise<{
  tokenId: string | null;
  registeredAt: number | null;
  etherscanUrl: string | null;
} | null> {
  const agent = isPgEnabled()
    ? await pgQueryOne<AgentRow>(
        "SELECT id, name, description, avatar_emoji, erc8004_token_id, erc8004_tx_hash, erc8004_registered_at FROM agents WHERE id = $1",
        [agentId]
      )
    : (getDb()
        .prepare(
          "SELECT id, name, description, avatar_emoji, erc8004_token_id, erc8004_tx_hash, erc8004_registered_at FROM agents WHERE id = ?"
        )
        .get(agentId) as AgentRow | undefined) ?? null;

  if (!agent) return null;

  return {
    tokenId: agent.erc8004_token_id,
    registeredAt: agent.erc8004_registered_at,
    etherscanUrl: agent.erc8004_tx_hash
      ? `https://sepolia.etherscan.io/tx/${agent.erc8004_tx_hash}`
      : agent.erc8004_token_id
        ? `https://sepolia.etherscan.io/address/${ERC8004_CONFIG.identityRegistry}`
        : null,
  };
}

// ── Registration JSON Builder ───────────────────────────────────────────────

/**
 * Build the ERC-8004 agent registration JSON (served at the agentURI endpoint).
 * The `registrations` array is populated dynamically by the route handler after
 * reading `erc8004_token_id` from the DB.
 */
export function buildAgentRegistrationJSON(agent: {
  id: string;
  name: string;
  description?: string | null;
}): object {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: `Quantik Agent - ${agent.name}`,
    description:
      agent.description ||
      "7-agent AI trading swarm specializing in prediction market analysis with adversarial stress testing and Kelly criterion position sizing",
    image: `${
      process.env.FRONTEND_URL || "https://quantik.fun"
    }/agents/${agent.id}-avatar.png`,
    services: [
      {
        type: "web",
        endpoint: process.env.FRONTEND_URL || "https://quantik.fun",
      },
      {
        type: "api",
        endpoint: `${
          process.env.BACKEND_URL || "https://api.quantik.fun"
        }/api`,
      },
    ],
    x402Support: false,
    active: true,
    registrations: [],
    supportedTrust: ["reputation", "crypto-economic"],
  };
}
