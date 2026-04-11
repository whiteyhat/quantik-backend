// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 Routes — On-Chain Identity, Reputation, Validation, Metadata
// ─────────────────────────────────────────────────────────────────────────────
// 5 REST endpoints for the ERC-8004 integration layer.
// All endpoints are non-blocking: failures return error JSON, never crash.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import {
  registerAgentIdentity,
  getAgentIdentity,
  buildAgentRegistrationJSON,
  getReputationSummary,
  isErc8004Configured,
  ERC8004_CONFIG,
} from "../erc8004";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne } from "../db/postgres";

const router = Router();

// ── POST /register — Register agent on ERC-8004 Identity Registry ──────────

router.post("/register", async (req, res) => {
  try {
    const { agentId } = req.body;
    if (!agentId || typeof agentId !== "string") {
      return res.status(400).json({ error: "agentId is required" });
    }
    if (!isErc8004Configured()) {
      return res
        .status(503)
        .json({ error: "ERC-8004 not configured — set env vars" });
    }
    const result = await registerAgentIdentity(agentId);
    res.json({
      ok: true,
      txHash: result.txHash,
      tokenId: result.tokenId,
      etherscanUrl: result.etherscanUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[erc8004] register failed:", message);
    res.status(500).json({ error: message });
  }
});

// ── GET /identity/:agentId — On-chain identity status ──────────────────────

router.get("/identity/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    const identity = await getAgentIdentity(agentId);
    if (!identity) {
      return res.status(404).json({ error: "Agent not found" });
    }
    res.json({
      ok: true,
      registered: identity.tokenId !== null,
      tokenId: identity.tokenId,
      registeredAt: identity.registeredAt,
      etherscanUrl: identity.etherscanUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ── GET /reputation/:agentId — On-chain reputation summary ─────────────────

router.get("/reputation/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    // Look up on-chain token ID from DB
    const agent = isPgEnabled()
      ? await pgQueryOne<{ erc8004_token_id: string | null }>(
          "SELECT erc8004_token_id FROM agents WHERE id = $1",
          [agentId]
        )
      : (getDb()
          .prepare("SELECT erc8004_token_id FROM agents WHERE id = ?")
          .get(agentId) as
          | { erc8004_token_id: string | null }
          | undefined);

    if (!agent || !agent.erc8004_token_id) {
      return res
        .status(404)
        .json({ error: "Agent not registered on ERC-8004" });
    }

    if (!isErc8004Configured()) {
      return res.status(503).json({ error: "ERC-8004 not configured" });
    }

    const summary = await getReputationSummary(agent.erc8004_token_id);
    res.json({
      ok: true,
      agentId,
      tokenId: agent.erc8004_token_id,
      ...summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ── GET /validations/:agentId — Validation records from DB ─────────────────

router.get("/validations/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    // Query from local DB (not on-chain — faster for listing)
    const rows = isPgEnabled()
      ? [] // pgQuery not needed for MVP — SQLite is primary
      : getDb()
          .prepare(
            "SELECT id, type, tx_hash, request_hash, pipeline_run_id, data, created_at FROM erc8004_validations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50"
          )
          .all(agentId);

    res.json({ ok: true, agentId, validations: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ── GET /metadata/:agentId — ERC-8004 registration JSON (agentURI) ─────────

router.get("/metadata/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = isPgEnabled()
      ? await pgQueryOne<{
          id: string;
          name: string;
          description: string | null;
          erc8004_token_id: string | null;
        }>(
          "SELECT id, name, description, erc8004_token_id FROM agents WHERE id = $1",
          [agentId]
        )
      : (getDb()
          .prepare(
            "SELECT id, name, description, erc8004_token_id FROM agents WHERE id = ?"
          )
          .get(agentId) as
          | {
              id: string;
              name: string;
              description: string | null;
              erc8004_token_id: string | null;
            }
          | undefined);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const json = buildAgentRegistrationJSON(agent) as Record<string, unknown>;

    // Populate registrations array if agent is registered on-chain
    if (agent.erc8004_token_id) {
      json.registrations = [
        {
          agentId: agent.erc8004_token_id,
          agentRegistry: `eip155:11155111:${ERC8004_CONFIG.identityRegistry}`,
        },
      ];
    }

    // Serve as JSON with correct content type for agentURI resolution
    res.setHeader("Content-Type", "application/json");
    res.json(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
