import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";
import { insertTrade, insertPaperTrade, getSettings } from "../db/queries";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";

const router = Router();

// ── GET /api/trade ────────────────────────────────────────────
router.get("/", (req: Request, res: Response) => {
  try {
    const db = getDb();
    const executions = db.prepare("SELECT * FROM executions ORDER BY executed_at DESC LIMIT 500").all() as any[];
    
    const priceRows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as any[];
    const livePrice = new Map(priceRows.map(r => [r.slug, r.probability]));

    const tradeList = executions.map(e => {
      const entry = e.fill_price ?? 0.5;
      const current = livePrice.get(e.slug) ?? entry;
      const shares = entry > 0 ? e.amount / entry : 0;
      const pnl = e.side === "buy" ? (current - entry) * shares : (entry - current) * shares;
      
      let outcome = "OPEN";
      if (e.pnl !== null) outcome = e.pnl > 0 ? "WIN" : "LOSS";
      else if (e.status === "failed") outcome = "LOSS";

      return {
        id: e.id,
        slug: e.slug,
        market: e.slug.split("-").map((w: any) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        direction: e.side === "buy" ? "YES" : "NO",
        size: e.amount,
        price: entry,
        outcome,
        timestamp: e.executed_at,
        pnl: e.pnl ?? pnl,
        orderId: e.order_id,
        mode: e.status,
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
  try {
    const { tokenId, side, price, size } = req.body as Record<string, unknown>;

    if (
      tokenId == null ||
      side == null ||
      price == null ||
      size == null
    ) {
      res
        .status(400)
        .json({ error: "Missing required fields: tokenId, side, price, size" });
      return;
    }

    const settings = getSettings();

    if (settings.paper_mode) {
      // ── Paper trade ────────────────────────────────────────
      const paperId = `PAPER-${uuid()}`;

      insertPaperTrade({
        id: paperId,
        market_id: String(tokenId),
        side: String(side),
        size: Number(size),
        price: Number(price),
        status: "submitted",
        created_at: Date.now(),
        settled_at: null,
        pnl: null,
      });

      res.json({
        orderId: paperId,
        status: "submitted",
        paper: true,
        tokenId,
        side,
        price: Number(price),
        size: Number(size),
      });
      return;
    }

    // ── Real trade ─────────────────────────────────────────
    const rawData = await runCli([
      "clob",
      "create-order",
      "--token-id", String(tokenId),
      "--side", String(side),
      "--price", String(price),
      "--size", String(size),
    ]);

    const data =
      rawData !== null && typeof rawData === "object"
        ? (rawData as Record<string, unknown>)
        : {};

    const orderId =
      typeof data["orderID"] === "string"
        ? data["orderID"]
        : typeof data["order_id"] === "string"
        ? data["order_id"]
        : null;

    const body = req.body as Record<string, unknown>;

    insertTrade({
      id: uuid(),
      order_id: orderId,
      market_slug: typeof body["marketSlug"] === "string" ? body["marketSlug"] : "",
      direction: String(side),
      size: Number(size),
      price: Number(price),
      net_ev:
        typeof body["netEv"] === "number" ? body["netEv"] : null,
      ev_grade:
        typeof body["evGrade"] === "string" ? body["evGrade"] : null,
      status: "submitted",
      created_at: Date.now(),
      pipeline_run_id:
        typeof body["pipelineRunId"] === "string"
          ? body["pipelineRunId"]
          : null,
    });

    res.json(rawData);
  } catch (err: unknown) {
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
    const data = await runCli(["clob", "cancel", String(orderId)]);
    res.json(data);
  } catch (err: unknown) {
    handleCliError(res, err);
  }
});

// ── POST /api/trade/cancel-all ────────────────────────────────
router.post("/cancel-all", async (_req: Request, res: Response) => {
  try {
    const data = await runCli(["clob", "cancel-all"]);
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
