import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { generateWalletCredentials } from "../wallet/generate";

const router = Router();

// ── POST /api/wallet/generate — Create a new EVM wallet via WDK ──────────────
// Stateless: generates wallet, returns credentials, stores NOTHING.
// The private key and seed phrase are returned once and never persisted.

router.post("/generate", async (_req: Request, res: Response) => {
  try {
    res.json(await generateWalletCredentials());
  } catch (err) {
    console.error("[wallet:generate] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to generate wallet" });
  }
});

router.get("/positions", async (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT slug, side, amount, fill_price, executed_at FROM executions WHERE status IN ('placed', 'paper') AND pnl IS NULL").all() as any[];

    const priceRows = db.prepare(
      `SELECT s.slug, s.probability FROM scanner_results s
       INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) latest
       ON s.slug = latest.slug AND s.scanned_at = latest.latest`
    ).all() as any[];
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
        pnlPct: entry > 0 ? pnl / e.amount : 0
      };
    });

    res.json(positions);
  } catch (err) {
    console.error("[wallet:positions] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/balance", async (_req, res) => {
  res.json({ balance: 0 }); // Placeholder
});

export default router;
