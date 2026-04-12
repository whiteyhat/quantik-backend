import { Router } from "express";
import { krakenPaperBuy, krakenPaperSell, krakenPaperBalance, krakenTicker, KrakenCliError } from "../kraken/cli";
import { executeKrakenTrade } from "../kraken/execution";
import type { KrakenTradeSignal } from "../kraken/execution";

const router = Router();

// POST /api/kraken/trade — Execute a paper trade
router.post("/trade", async (req, res) => {
  try {
    const { pair, direction, amount } = req.body;
    if (!pair || !direction || !amount) {
      res.status(400).json({ error: "Missing required fields: pair, direction, amount" });
      return;
    }
    if (!["BUY", "SELL"].includes(direction)) {
      res.status(400).json({ error: "direction must be BUY or SELL" });
      return;
    }
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }

    const signal: KrakenTradeSignal = { pair: String(pair).toUpperCase(), direction, amount: numAmount, assetClass: "crypto" };
    const result = await executeKrakenTrade(signal);
    res.json({ status: "ok", data: result });
  } catch (err: unknown) {
    const message = err instanceof KrakenCliError ? err.message : err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/kraken/portfolio — Paper portfolio balance
router.get("/portfolio", async (_req, res) => {
  try {
    const balance = await krakenPaperBalance();
    res.json({ status: "ok", data: balance });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/kraken/ticker/:pair — Current ticker data
router.get("/ticker/:pair", async (req, res) => {
  try {
    const pair = req.params.pair.toUpperCase();
    const ticker = await krakenTicker(pair);
    res.json({ status: "ok", data: ticker });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
