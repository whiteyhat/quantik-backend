// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 Validation Service — Request/Response Submission & Querying
// ─────────────────────────────────────────────────────────────────────────────
// Before trade execution, submit a validation request (trade intent commitment).
// After trade execution, submit a validation response (execution proof).
// Both artifacts are persisted on-chain AND in the local erc8004_validations table.
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import {
  getValidationContract,
  getSigner,
  isErc8004Configured,
} from "./config";
import { getDb } from "../db/schema";
import { isPgEnabled, pgExec } from "../db/postgres";

// ── Validation Request ──────────────────────────────────────────────────────

/**
 * Submit a validation request before trade execution.
 * Creates an on-chain commitment with a keccak256 hash of the trade intent.
 */
export async function submitValidationRequest(
  agentTokenId: string,
  agentId: string,
  pipelineRunId: string,
  tradeIntent: object
): Promise<{ txHash: string; requestHash: string }> {
  if (!isErc8004Configured()) {
    throw new Error("ERC-8004 not configured");
  }

  const requestURI = ""; // No IPFS for hackathon — empty string is valid
  const requestHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        agentId: agentTokenId,
        pipelineRunId,
        intent: tradeIntent,
        ts: Date.now(),
      })
    )
  );

  // Get signer address as validator
  const signer = getSigner();
  const validatorAddress = await signer.getAddress();

  // Call validationRequest on-chain
  const contract = getValidationContract();
  const tx = await contract.validationRequest(
    validatorAddress,
    agentTokenId,
    requestURI,
    requestHash
  );
  await tx.wait();

  // Persist to local DB (dual-mode)
  const id = uuidv4();
  const now = Date.now();

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO erc8004_validations (id, agent_id, type, tx_hash, request_hash, pipeline_run_id, data, created_at)
       VALUES ($1, $2, 'request', $3, $4, $5, $6, $7)`,
      [
        id,
        agentId,
        tx.hash,
        requestHash,
        pipelineRunId,
        JSON.stringify(tradeIntent),
        now,
      ]
    );
  } else {
    getDb()
      .prepare(
        `INSERT INTO erc8004_validations (id, agent_id, type, tx_hash, request_hash, pipeline_run_id, data, created_at)
         VALUES (?, ?, 'request', ?, ?, ?, ?, ?)`
      )
      .run(id, agentId, tx.hash, requestHash, pipelineRunId, JSON.stringify(tradeIntent), now);
  }

  return { txHash: tx.hash, requestHash };
}

// ── Validation Response ─────────────────────────────────────────────────────

/**
 * Submit a validation response after trade execution.
 * Records the execution proof on-chain with a pass/fail status.
 */
export async function submitValidationResponse(
  requestHash: string,
  agentId: string,
  pipelineRunId: string,
  success: boolean,
  executionProof: object
): Promise<{ txHash: string }> {
  if (!isErc8004Configured()) {
    throw new Error("ERC-8004 not configured");
  }

  const response = success ? 100 : 0; // 0=failed, 100=passed per spec
  const responseURI = "";
  const responseHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        requestHash,
        success,
        proof: executionProof,
        ts: Date.now(),
      })
    )
  );
  const tag = "trade_execution";

  // Call validationResponse on-chain
  const contract = getValidationContract();
  const tx = await contract.validationResponse(
    requestHash,
    response,
    responseURI,
    responseHash,
    tag
  );
  await tx.wait();

  // Persist to local DB (dual-mode)
  const id = uuidv4();
  const now = Date.now();

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO erc8004_validations (id, agent_id, type, tx_hash, request_hash, pipeline_run_id, data, created_at)
       VALUES ($1, $2, 'response', $3, $4, $5, $6, $7)`,
      [
        id,
        agentId,
        tx.hash,
        requestHash,
        pipelineRunId,
        JSON.stringify(executionProof),
        now,
      ]
    );
  } else {
    getDb()
      .prepare(
        `INSERT INTO erc8004_validations (id, agent_id, type, tx_hash, request_hash, pipeline_run_id, data, created_at)
         VALUES (?, ?, 'response', ?, ?, ?, ?, ?)`
      )
      .run(id, agentId, tx.hash, requestHash, pipelineRunId, JSON.stringify(executionProof), now);
  }

  return { txHash: tx.hash };
}

// ── Validation Query ────────────────────────────────────────────────────────

/**
 * Get the on-chain validation status for a specific request hash.
 */
export async function getValidationStatus(
  requestHash: string
): Promise<{
  validatorAddress: string;
  agentId: string;
  response: number;
  tag: string;
  lastUpdate: number;
} | null> {
  if (!isErc8004Configured()) {
    throw new Error("ERC-8004 not configured");
  }

  const contract = getValidationContract();
  const [validatorAddress, agentId, response, , tag, lastUpdate] =
    await contract.getValidationStatus(requestHash);

  // If validatorAddress is zero address, no validation exists
  if (validatorAddress === ethers.ZeroAddress) return null;

  return {
    validatorAddress,
    agentId: agentId.toString(),
    response: Number(response),
    tag,
    lastUpdate: Number(lastUpdate),
  };
}

/**
 * Get all validation request hashes for an agent from the on-chain registry.
 */
export async function getAgentValidations(
  agentTokenId: string
): Promise<string[]> {
  if (!isErc8004Configured()) {
    throw new Error("ERC-8004 not configured");
  }

  const contract = getValidationContract();
  const hashes: string[] = await contract.getAgentValidations(agentTokenId);
  return hashes;
}
