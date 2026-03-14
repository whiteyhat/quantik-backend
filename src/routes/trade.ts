import { Router, Request, Response } from "express";
import { runCliWithWallet, CliError } from "../cli";
import { getDb } from "../db/schema";
import { tradeRateLimit } from "../infra/rateLimit";
import { getUserId, getUserIdAsync } from "../middleware/auth";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";
import { loadAgentWalletContext } from "../utils/agentKey";
import { insertExecutionRecord } from "../utils/executions";
import { executeManagedTrade } from "../services/tradeExecution";
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
    const db = getDb();
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    const executions = linkedAgent
      ? db.prepare("SELECT * FROM executions WHERE agent_id = ? ORDER BY executed_at DESC LIMIT 500").all(linkedAgent.agentId)
      : db.prepare("SELECT * FROM executions ORDER BY executed_at DESC LIMIT 500").all() as any[];

    const priceRows = db.prepare(
      `SELECT s.slug, s.probability FROM scanner_results s
       INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) t
       ON s.slug = t.slug AND s.scanned_at = t.latest`
    ).all() as any[];
    const livePrice = new Map(priceRows.map(r => [r.slug, r.probability]));
    const scannerDirections = getLatestScannerDirectionMap();

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
    const walletContext = linkedAgent ? await loadAgentWalletContext(linkedAgent.agentId).catch(() => null) : null;
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
      walletPrivateKey: walletContext?.privateKey ?? null,
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
    const walletContext = linked ? await loadAgentWalletContext(linked.agentId).catch(() => null) : null;
    if (!walletContext?.privateKey) {
      res.status(400).json({ error: "No wallet configured." });
      return;
    }
    const data = await runCliWithWallet(["clob", "cancel", String(orderId)], walletContext.privateKey);
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
    const walletContext = linked ? await loadAgentWalletContext(linked.agentId).catch(() => null) : null;
    if (!walletContext?.privateKey) {
      res.status(400).json({ error: "No wallet configured." });
      return;
    }
    const data = await runCliWithWallet(["clob", "cancel-all"], walletContext.privateKey);
    res.json(data);
  } catch (err: unknown) {
    handleCliError(res, err);
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
