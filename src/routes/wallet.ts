import { Router } from "express";
import { getDb } from "../db/schema";

const router = Router();

router.get("/positions", async (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT slug, side, amount, fill_price, executed_at FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL").all() as any[];

    const priceRows = db.prepare("SELECT slug, probability FROM scanner_results GROUP BY slug ORDER BY scanned_at DESC").all() as any[];
    const currentPrices = new Map(priceRows.map(r => [r.slug, r.probability]));

    const positions = rows.map(e => {
      const current = currentPrices.get(e.slug) ?? e.fill_price ?? 0.5;
      const entry = e.fill_price ?? 0.5;
      const shares = entry > 0 ? e.amount / entry : 0;
      const pnl = e.side === "buy" ? (current - entry) * shares : (entry - current) * shares;
      return {
        id: `pos-${e.slug}-${e.executed_at}`,
        slug: e.slug,
        market: e.slug.split("-").map((w: any) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        direction: e.side === "buy" ? "YES" : "NO",
        size: e.amount,
        entryPrice: entry,
        currentPrice: current,
        pnl: pnl,
        pnlPct: entry > 0 ? (pnl / e.amount) * 100 : 0
      };
    });

    res.json(positions);
  } catch (err) {
    console.error("[wallet:positions] error:", err);
    res.json([]);
  }
});

router.get("/balance", async (_req, res) => {
  res.json({ balance: 0 }); // Placeholder
});

export default router;
