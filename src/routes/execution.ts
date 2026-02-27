// ── /api/execution — L4 Execution Engine routes ─────────────────

import { Router, Request, Response } from "express";
import { getPaperEngine, getFillMonitor } from "../execution";

const router = Router();

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

export default router;
