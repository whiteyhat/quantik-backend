// ── /api/execution — L4 Execution Engine routes ─────────────────

import { Router, Request, Response } from "express";
import { getPaperEngine, getFillMonitor } from "../execution";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne } from "../db/postgres";
import { getUserIdAsync } from "../middleware/auth";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";

const router = Router();

type ExecutionSource = "autopilot" | "manual";

interface OwnedAgentRow {
  id: string;
}

async function loadOwnedAgentId(agentId: string, userId: string): Promise<string | null> {
  if (isPgEnabled()) {
    const row = await pgQueryOne<OwnedAgentRow>(
      `SELECT id
       FROM agents
       WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    );
    return row?.id ?? null;
  }

  const db = getDb();
  const row = db.prepare(
    `SELECT id
     FROM agents
     WHERE id = ? AND user_id = ?`
  ).get(agentId, userId) as OwnedAgentRow | undefined;
  return row?.id ?? null;
}

// ── POST /api/execution/order — place paper order ───────────────
router.post("/order", (req: Request, res: Response) => {
  try {
    const { slug, direction, sizeUsdc } = req.body as Record<string, unknown>;

    if (!slug || !direction || sizeUsdc == null) {
      res
        .status(400)
        .json({ error: "Missing required fields: slug, direction, sizeUsdc" });
      return;
    }

    const dir = String(direction).toUpperCase();
    if (dir !== "YES" && dir !== "NO") {
      res.status(400).json({ error: "direction must be YES or NO" });
      return;
    }

    const engine = getPaperEngine();
    const order = engine.placePaperOrder(
      String(slug),
      dir as "YES" | "NO",
      Number(sizeUsdc)
    );

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/execution/orders — list open orders ────────────────
router.get("/orders", (_req: Request, res: Response) => {
  try {
    const engine = getPaperEngine();
    res.json(engine.getOpenOrders());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/execution/orders/:id — get order status ────────────
router.get("/orders/:id", (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const monitor = getFillMonitor();
    const order = monitor.getOrderStatus(id);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/execution/orders/:id — cancel order ─────────────
router.delete("/orders/:id", (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const engine = getPaperEngine();
    engine.cancelOrder(id);
    res.json({ cancelled: true, id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});


// ── POST /api/execution/dry-run — preview order without placing it ──
router.post("/dry-run", (req: Request, res: Response) => {
  try {
    const { slug, side, amount } = req.body as Record<string, unknown>;

    if (!slug || !side || amount == null) {
      res.status(400).json({ error: "Missing required fields: slug, side, amount" });
      return;
    }

    const dir = String(side).toUpperCase();
    if (dir !== "YES" && dir !== "NO") {
      res.status(400).json({ error: "side must be YES or NO" });
      return;
    }

    const size = Number(amount);
    const PAPER_TRADING = process.env.PAPER_TRADING !== "false";

    const cliArgs = [
      "clob", "create-order",
      "--token", String(slug),
      "--side", dir,
      "--price", "0.5",
      "--size", String(size),
    ];

    res.json({
      dry_run: true,
      would_execute: `polymarket ${cliArgs.join(" ")}`,
      slug: String(slug),
      side: dir,
      amount: size,
      execution_mode: PAPER_TRADING ? "paper" : "live",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/execution/log — autopilot execution history ────────
router.get("/log", async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdAsync(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const sourceParam = typeof req.query.source === "string" ? req.query.source : null;
    const source = sourceParam === "autopilot" || sourceParam === "manual"
      ? sourceParam
      : undefined;
    const requestedAgentId = typeof req.query.agentId === "string" ? req.query.agentId : null;

    let agentId = requestedAgentId;
    if (agentId) {
      const ownedAgentId = await loadOwnedAgentId(agentId, userId);
      if (!ownedAgentId) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      agentId = ownedAgentId;
    } else {
      agentId = (await loadLinkedAgentForUser(userId))?.agentId ?? null;
    }

    if (!agentId) {
      res.json({ ok: true, count: 0, log: [] });
      return;
    }

    let rows: unknown[];
    if (isPgEnabled()) {
      const params: Array<string | number> = [agentId];
      const where = ["agent_id = $1"];
      let paramIndex = 2;

      if (source) {
        where.push(`source = $${paramIndex}`);
        params.push(source);
        paramIndex += 1;
      }

      params.push(limit);
      rows = await pgQuery(
        `SELECT *
         FROM executions
         WHERE ${where.join(" AND ")}
         ORDER BY executed_at DESC
         LIMIT $${paramIndex}`,
        params
      );
    } else {
      const db = getDb();
      rows = source
        ? db.prepare(
            `SELECT *
             FROM executions
             WHERE agent_id = ? AND source = ?
             ORDER BY executed_at DESC
             LIMIT ?`
          ).all(agentId, source, limit)
        : db.prepare(
            `SELECT *
             FROM executions
             WHERE agent_id = ?
             ORDER BY executed_at DESC
             LIMIT ?`
          ).all(agentId, limit);
    }

    res.json({ ok: true, count: rows.length, log: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
