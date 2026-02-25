import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";
import { insertTrade, insertPaperTrade, getSettings } from "../db/queries";
import { v4 as uuid } from "uuid";

const router = Router();

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
