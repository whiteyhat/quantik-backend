// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 Reputation Service — On-Chain Feedback Submission & Querying
// ─────────────────────────────────────────────────────────────────────────────
// After each trade resolves, submit feedback with PnL-based value and trading
// tags to the ERC-8004 Reputation Registry on Sepolia.
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import { getReputationContract, isErc8004Configured } from "./config";

// ── Feedback Submission ─────────────────────────────────────────────────────

/**
 * Submit reputation feedback for an agent after trade execution.
 * @param agentTokenId - The on-chain ERC-8004 token ID for the agent
 * @param pnlBasisPoints - PnL in basis points (e.g., +500 = 5% profit, -200 = 2% loss)
 */
export async function submitFeedback(
  agentTokenId: string,
  pnlBasisPoints: number
): Promise<{ txHash: string }> {
  if (!isErc8004Configured()) {
    throw new Error("ERC-8004 not configured");
  }

  const tag1 = "successRate";
  const tag2 = "trading";
  const endpoint = `${
    process.env.BACKEND_URL || "https://api.quantik.fun"
  }/api/pipeline`;
  const feedbackURI = ""; // No IPFS for hackathon — empty string is valid
  const feedbackHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        agentId: agentTokenId,
        pnl: pnlBasisPoints,
        ts: Date.now(),
      })
    )
  );

  const contract = getReputationContract();
  const tx = await contract.giveFeedback(
    agentTokenId,
    pnlBasisPoints,
    0, // valueDecimals: 0 (basis points are already integer-scaled)
    tag1,
    tag2,
    endpoint,
    feedbackURI,
    feedbackHash
  );
  await tx.wait();

  return { txHash: tx.hash };
}

// ── Reputation Query ────────────────────────────────────────────────────────

/**
 * Get the aggregated reputation summary for an agent from the on-chain registry.
 */
export async function getReputationSummary(
  agentTokenId: string
): Promise<{ count: number; summaryValue: number; decimals: number }> {
  if (!isErc8004Configured()) {
    throw new Error("ERC-8004 not configured");
  }

  const contract = getReputationContract();
  const [count, summaryValue, decimals] = await contract.getSummary(
    agentTokenId,
    [], // clientAddresses: empty = all clients
    "successRate",
    "trading"
  );

  return {
    count: Number(count),
    summaryValue: Number(summaryValue),
    decimals: Number(decimals),
  };
}

// ── Reputation History ──────────────────────────────────────────────────────

/**
 * Get all feedback entries for an agent from the on-chain registry.
 */
export async function getReputationHistory(
  agentTokenId: string
): Promise<Array<{ index: number; value: number; decimals: number }>> {
  if (!isErc8004Configured()) {
    throw new Error("ERC-8004 not configured");
  }

  const contract = getReputationContract();
  const [feedbackIndices, , values, valueDecimals] =
    await contract.readAllFeedback(
      agentTokenId,
      [], // clientAddresses: empty = all clients
      "successRate",
      "trading",
      false // includeRevoked
    );

  const results: Array<{ index: number; value: number; decimals: number }> = [];
  for (let i = 0; i < feedbackIndices.length; i++) {
    results.push({
      index: Number(feedbackIndices[i]),
      value: Number(values[i]),
      decimals: Number(valueDecimals[i]),
    });
  }

  return results;
}
