import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";
import { insertTrade } from "../db/queries";
import { v4 as uuid } from "uuid";

const router = Router();

// POST /api/trade/execute
router.post("/execute", async (req: Request, res: Response) => {
  try {
    const { tokenId, side, price, size } = req.body;
    if (!tokenId || !side || price == null || size == null) {
      res.status(400).json({ error: "Missing required fields: tokenId, side, price, size" });
      return;
    }

    const data = await runCli([
      "clob",
      "create-order",
      "--token-id", String(tokenId),
      "--side", String(side),
      "--price", String(price),
      "--size", String(size),
    ]);

    // Log trade to DB
    insertTrade({
      id: uuid(),
      order_id: data?.orderID || data?.order_id || null,
      market_slug: req.body.marketSlug || "",
      direction: side,
      size: Number(size),
      price: Number(price),
      net_ev: req.body.netEv ?? null,
      ev_grade: req.body.evGrade ?? null,
      status: "submitted",
      created_at: Date.now(),
      pipeline_run_id: req.body.pipelineRunId ?? null,
    });

    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// POST /api/trade/cancel
router.post("/cancel", async (req: Request, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      res.status(400).json({ error: "Missing required field: orderId" });
      return;
    }
    const data = await runCli(["clob", "cancel", String(orderId)]);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// POST /api/trade/cancel-all
router.post("/cancel-all", async (_req: Request, res: Response) => {
  try {
    const data = await runCli(["clob", "cancel-all"]);
    res.json(data);
  } catch (err) {
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
