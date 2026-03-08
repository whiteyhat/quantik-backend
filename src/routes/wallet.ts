import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { generateWalletCredentials } from "../wallet/generate";
import { getUsdcBalanceSnapshot } from "../utils/balances";

const router = Router();

async function getRequiredUserId(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdAsync(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return userId;
}

async function loadWalletAddressForUser(userId: string): Promise<string | null> {
  if (isPgEnabled()) {
    const user = await pgQueryOne<{ agent_id: string | null }>(
      "SELECT agent_id FROM users WHERE id = $1",
      [userId]
    );
    if (!user?.agent_id) return null;

    const agent = await pgQueryOne<{ wallet_address: string | null }>(
      "SELECT wallet_address FROM agents WHERE id = $1",
      [user.agent_id]
    );
    return agent?.wallet_address ?? null;
  }

  const db = getDb();
  const user = db.prepare("SELECT agent_id FROM users WHERE id = ?").get(userId) as { agent_id: string | null } | undefined;
  if (!user?.agent_id) return null;

  const agent = db.prepare("SELECT wallet_address FROM agents WHERE id = ?").get(user.agent_id) as { wallet_address: string | null } | undefined;
  return agent?.wallet_address ?? null;
}

// ── POST /api/wallet/generate — Create a new EVM wallet via WDK ──────────────
// Stateless: generates wallet, returns credentials, stores NOTHING.
// The private key and seed phrase are returned once and never persisted.

router.post("/generate", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;
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

router.get("/balance", async (req, res) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const address = await loadWalletAddressForUser(userId);
    if (!address) {
      res.json({
        balance: 0,
        address: null,
        status: "no_wallet",
        liveBalanceAvailable: false,
        message: "No wallet assigned to this agent yet.",
      });
      return;
    }

    const snapshot = await getUsdcBalanceSnapshot(address);
    res.json({
      balance: snapshot.balance,
      address,
      status: snapshot.status === "live" ? "live" : "unavailable",
      liveBalanceAvailable: snapshot.status === "live",
      message: snapshot.status === "live"
        ? (snapshot.balance > 0
            ? "Live on-chain USDC balance available."
            : "Wallet created but no on-chain USDC balance detected yet.")
        : "Unable to read the on-chain USDC balance right now.",
    });
  } catch (err) {
    console.error("[wallet:balance] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
