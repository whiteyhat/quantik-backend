import { Router, Request, Response } from "express";
import { runCliWithWallet, CliError } from "../cli";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne, pgExec } from "../db/postgres";
import { tradeRateLimit } from "../infra/rateLimit";
import { getUserId, getUserIdAsync } from "../middleware/auth";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";
import { loadAgentWalletContext, loadAgentWalletContextWithDiag } from "../utils/agentKey";
import { insertExecutionRecord } from "../utils/executions";
import { executeManagedTrade } from "../services/tradeExecution";
import { emitNotification } from "../infra/socket";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerDirectionMap,
  normalizeExecutionDirection,
} from "../utils/executionDirection";

type TradeDirection = "YES" | "NO";

function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveRequestedDirection(body: Record<string, unknown>): TradeDirection | null {
  const explicitDirection = normalizeExecutionDirection(body["direction"]);
  if (explicitDirection) return explicitDirection;

  const side = typeof body["side"] === "string" ? body["side"].trim().toLowerCase() : null;
  if (side === "sell") return "NO";
  if (side === "buy") return "YES";
  return null;
}

const router = Router();

// Apply trade rate limit to all POST routes
router.use(tradeRateLimit);

// ── GET /api/trade ────────────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;

    let executions: any[];
    let priceRows: any[];

    if (isPgEnabled()) {
      executions = linkedAgent
        ? await pgQuery("SELECT * FROM executions WHERE agent_id = $1 ORDER BY executed_at DESC LIMIT 500", [linkedAgent.agentId])
        : await pgQuery("SELECT * FROM executions ORDER BY executed_at DESC LIMIT 500");

      priceRows = await pgQuery(
        `SELECT s.slug, s.probability FROM scanner_results s
         INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) t
         ON s.slug = t.slug AND s.scanned_at = t.latest`
      );
    } else {
      const db = getDb();
      executions = linkedAgent
        ? db.prepare("SELECT * FROM executions WHERE agent_id = ? ORDER BY executed_at DESC LIMIT 500").all(linkedAgent.agentId)
        : db.prepare("SELECT * FROM executions ORDER BY executed_at DESC LIMIT 500").all() as any[];

      priceRows = db.prepare(
        `SELECT s.slug, s.probability FROM scanner_results s
         INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) t
         ON s.slug = t.slug AND s.scanned_at = t.latest`
      ).all() as any[];
    }

    const livePrice = new Map(priceRows.map(r => [r.slug, r.probability]));
    const scannerDirections = await getLatestScannerDirectionMap();

    const tradeList = executions.map((execution) => {
      const scannerDirection = scannerDirections.get(execution.slug);
      const entryYes = getEntryYesPrice(execution, scannerDirection);
      const currentYes = livePrice.get(execution.slug) ?? entryYes;
      const metrics = calculateOpenExecutionMetrics(execution, currentYes, scannerDirection);

      let outcome = "OPEN";
      if (execution.pnl !== null) outcome = execution.pnl > 0 ? "WIN" : "LOSS";
      else if (execution.status === "failed") outcome = "LOSS";

      return {
        id: execution.id,
        slug: execution.slug,
        market: execution.slug.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        direction: metrics.direction,
        source: execution.source === "autopilot" ? "autopilot" : "manual",
        size: execution.amount,
        price: entryYes,
        outcome,
        timestamp: execution.executed_at,
        pnl: execution.pnl ?? metrics.pnl,
        orderId: execution.order_id,
        mode: execution.status,
      };
    });

    res.json({
      trades: tradeList,
      count: tradeList.length,
      winRate: tradeList.filter(t => t.outcome === "WIN").length / Math.max(tradeList.filter(t => t.outcome !== "OPEN").length, 1)
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/trade/execute ───────────────────────────────────
router.post("/execute", async (req: Request, res: Response) => {
  const userId = await getUserIdAsync(req);
  const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;

  try {
    const body = req.body as Record<string, unknown>;
    const requestedDirection = resolveRequestedDirection(body);
    const requestedTokenId =
      typeof body["tokenId"] === "string" && body["tokenId"].trim()
        ? body["tokenId"].trim()
        : null;
    const requestedSlug =
      typeof body["marketSlug"] === "string" && body["marketSlug"].trim()
        ? body["marketSlug"].trim()
        : null;
    const size = toFiniteNumber(body["size"]);

    if (requestedDirection == null || size == null || size <= 0 || (!requestedTokenId && !requestedSlug)) {
      res.status(400).json({
        error: "Missing required fields: size and one of tokenId/marketSlug, plus direction (or legacy side)",
      });
      return;
    }
    const walletDiag = linkedAgent ? await loadAgentWalletContextWithDiag(linkedAgent.agentId) : { context: null, error: "No agent linked to user" };
    const tradeSlug = requestedSlug ?? requestedTokenId ?? "";
    const result = await executeManagedTrade({
      userId,
      agentId: linkedAgent?.agentId ?? null,
      marketSlug: tradeSlug,
      direction: requestedDirection,
      source: "manual",
      sizeUsdc: size,
      requestedTokenId,
      quotedPrice: toFiniteNumber(body["price"]),
      netEv: typeof body["netEv"] === "number" ? body["netEv"] : null,
      evGrade: typeof body["evGrade"] === "string" ? body["evGrade"] : null,
      pipelineRunId: typeof body["pipelineRunId"] === "string" ? body["pipelineRunId"] : null,
      walletPrivateKey: walletDiag.context?.privateKey ?? null,
      walletError: walletDiag.error ?? undefined,
      emitUserId: getUserId(req),
    });

    if (!result.ok) {
      res.status(400).json({ error: result.error ?? "Trade execution failed" });
      return;
    }

    res.json(result.rawData);
  } catch (err: unknown) {
    if (req.body && typeof req.body === "object") {
      const body = req.body as Record<string, unknown>;
      const requestedDirection = resolveRequestedDirection(body);
      const requestedSize = toFiniteNumber(body["size"]);
      const tokenId = body["tokenId"];
      if ((tokenId != null || body["marketSlug"] != null) && requestedDirection != null && requestedSize != null && requestedSize > 0) {
        try {
          await insertExecutionRecord({
            userId,
            agentId: linkedAgent?.agentId ?? null,
            slug: typeof body["marketSlug"] === "string" ? body["marketSlug"] : String(tokenId),
            side: "buy",
            direction: requestedDirection,
            source: "manual",
          amount: requestedSize,
          executedAt: Date.now(),
          status: "failed",
          fillPrice: toFiniteNumber(body["price"]) ?? 0.5,
          pipelineRunId: typeof body["pipelineRunId"] === "string" ? body["pipelineRunId"] : null,
        });
      } catch {
        // Do not mask the original trade error.
      }
      }
    }
    handleCliError(res, err);
  }
});

// ── POST /api/trade/cancel ────────────────────────────────────
router.post("/cancel", async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const orderId = body["orderId"];
    if (!orderId) {
      res.status(400).json({ error: "Missing required field: orderId" });
      return;
    }
    const userId = await getUserIdAsync(req);
    const linked = userId ? await loadLinkedAgentForUser(userId) : null;
    const walletDiag = linked ? await loadAgentWalletContextWithDiag(linked.agentId) : { context: null, error: "No agent linked to user" };
    if (!walletDiag.context?.privateKey) {
      res.status(400).json({ error: walletDiag.error ?? "No wallet configured." });
      return;
    }
    const data = await runCliWithWallet(["clob", "cancel", String(orderId)], walletDiag.context.privateKey);
    res.json(data);
  } catch (err: unknown) {
    handleCliError(res, err);
  }
});

// ── POST /api/trade/cancel-all ────────────────────────────────
router.post("/cancel-all", async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdAsync(req);
    const linked = userId ? await loadLinkedAgentForUser(userId) : null;
    const walletDiag = linked ? await loadAgentWalletContextWithDiag(linked.agentId) : { context: null, error: "No agent linked to user" };
    if (!walletDiag.context?.privateKey) {
      res.status(400).json({ error: walletDiag.error ?? "No wallet configured." });
      return;
    }
    const data = await runCliWithWallet(["clob", "cancel-all"], walletDiag.context.privateKey);
    res.json(data);
  } catch (err: unknown) {
    handleCliError(res, err);
  }
});

// ── POST /api/trade/close-position ───────────────────────────
router.post("/close-position", async (req: Request, res: Response) => {
  try {
    const body = req.body as { executionId?: unknown };
    const executionId = Number(body.executionId);
    if (!Number.isInteger(executionId) || executionId <= 0) {
      res.status(400).json({ error: "executionId must be a positive integer" });
      return;
    }

    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;

    type ExecutionRecord = {
      id: number;
      user_id: string | null;
      agent_id: string | null;
      slug: string;
      side: string;
      direction: string | null;
      source: string | null;
      amount: number;
      fill_price: number | null;
      status: string;
      resolution_date: string | null;
    };

    let execution: ExecutionRecord | undefined;

    if (isPgEnabled()) {
      execution = await pgQueryOne<ExecutionRecord>(
        `SELECT id, user_id, agent_id, slug, side, direction, source, amount, fill_price, status, resolution_date
           FROM executions
          WHERE id = $1
            AND status IN ('placed', 'paper')
            AND pnl IS NULL`,
        [executionId]
      ) ?? undefined;
    } else {
      const db = getDb();
      execution = db.prepare(
        `SELECT id, user_id, agent_id, slug, side, direction, source, amount, fill_price, status, resolution_date
           FROM executions
          WHERE id = ?
            AND status IN ('placed', 'paper')
            AND pnl IS NULL`
      ).get(executionId) as ExecutionRecord | undefined;
    }

    if (!execution) {
      res.status(404).json({ error: "Open execution not found" });
      return;
    }

    const isOwner =
      (userId && execution.user_id === userId) ||
      (linkedAgent?.agentId && execution.agent_id === linkedAgent.agentId);
    if (!isOwner) {
      res.status(403).json({ error: "You can only close your own positions" });
      return;
    }

    let priceRow: { probability: number } | null | undefined;

    if (isPgEnabled()) {
      priceRow = await pgQueryOne<{ probability: number }>(
        `SELECT probability FROM scanner_results WHERE slug = $1 ORDER BY scanned_at DESC LIMIT 1`,
        [execution.slug]
      );
    } else {
      const db = getDb();
      priceRow = db.prepare(
        `SELECT probability FROM scanner_results WHERE slug = ? ORDER BY scanned_at DESC LIMIT 1`
      ).get(execution.slug) as { probability: number } | undefined;
    }

    const scannerDirection = (await getLatestScannerDirectionMap()).get(execution.slug);
    const currentYes = priceRow?.probability ?? getEntryYesPrice(execution, scannerDirection);
    const metrics = calculateOpenExecutionMetrics(execution, currentYes, scannerDirection);
    const realizedPnl = Math.round(metrics.pnl * 100) / 100;
    const now = Date.now();

    if (isPgEnabled()) {
      await pgExec(
        `UPDATE executions
            SET status = 'closed',
                pnl = $1,
                closed_at = $2,
                updated_at = $3
          WHERE id = $4`,
        [realizedPnl, now, now, execution.id]
      );
    } else {
      const db = getDb();
      db.prepare(
        `UPDATE executions
            SET status = 'closed',
                pnl = ?,
                closed_at = ?,
                updated_at = ?
          WHERE id = ?`
      ).run(realizedPnl, now, now, execution.id);
    }

    emitNotification(userId ?? execution.user_id ?? null, {
      id: `position-close-${execution.id}-${now}`,
      level: realizedPnl >= 0 ? "success" : "warning",
      title: "Position closed",
      message: `${execution.slug} closed at ${Math.round(metrics.currentTokenPrice * 100)}¢ for ${realizedPnl >= 0 ? "+" : ""}$${Math.abs(realizedPnl).toFixed(2)} P&L.`,
      category: "position",
      timestamp: now,
      action: {
        label: "Open market",
        href: `/market/${execution.slug}`,
      },
    });

    res.json({
      ok: true,
      executionId: execution.id,
      slug: execution.slug,
      direction: metrics.direction,
      size: execution.amount,
      entryPrice: metrics.entryTokenPrice,
      exitPrice: metrics.currentTokenPrice,
      pnl: realizedPnl,
      closedAt: now,
      status: "closed",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function handleCliError(res: Response, err: unknown): void {
  if (err instanceof CliError) {
    res.status(502).json({ error: err.message, stderr: err.stderr });
  } else {
    res.status(500).json({ error: String(err) });
  }
}

export default router;
