import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQuery, pgQueryOne } from "../db/postgres";
import { generateWalletCredentials } from "../wallet/generate";
import { getUsdcBalanceSnapshot } from "../utils/balances";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";
import { fetchMarketBySlug } from "../utils/market-fetch";
import {
  calculateOpenExecutionMetrics,
  getEntryYesPrice,
  getLatestScannerDirectionMap,
} from "../utils/executionDirection";

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

router.get("/positions", async (req, res) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const linkedAgent = await loadLinkedAgentForUser(userId);
    if (!linkedAgent) {
      res.json([]);
      return;
    }

    type ExecutionPositionRow = {
      id: number;
      slug: string;
      side: string | null;
      direction: string | null;
      source: string | null;
      amount: number;
      fill_price: number | null;
      status: string;
      executed_at: number;
      resolution_date: string | null;
    };

    type ScannerPriceRow = {
      slug: string;
      probability: number;
    };

    let rows: ExecutionPositionRow[];
    let priceRows: ScannerPriceRow[];

    if (isPgEnabled()) {
      rows = await pgQuery<ExecutionPositionRow>(
        `SELECT id, slug, side, direction, source, amount, fill_price, status, executed_at, resolution_date
           FROM executions
          WHERE agent_id = $1
            AND status IN ('placed', 'paper')
            AND pnl IS NULL
          ORDER BY executed_at DESC`,
        [linkedAgent.agentId]
      );
      priceRows = await pgQuery<ScannerPriceRow>(
        `SELECT s.slug, s.probability
           FROM scanner_results s
           INNER JOIN (
             SELECT slug, MAX(scanned_at) AS latest
               FROM scanner_results
              GROUP BY slug
           ) latest
             ON s.slug = latest.slug
            AND s.scanned_at = latest.latest`
      );
    } else {
      const db = getDb();
      rows = db.prepare(
        `SELECT id, slug, side, direction, source, amount, fill_price, status, executed_at, resolution_date
           FROM executions
          WHERE agent_id = ?
            AND status IN ('placed', 'paper')
            AND pnl IS NULL
          ORDER BY executed_at DESC`
      ).all(linkedAgent.agentId) as ExecutionPositionRow[];
      priceRows = db.prepare(
        `SELECT s.slug, s.probability FROM scanner_results s
         INNER JOIN (SELECT slug, MAX(scanned_at) AS latest FROM scanner_results GROUP BY slug) latest
         ON s.slug = latest.slug AND s.scanned_at = latest.latest`
      ).all() as ScannerPriceRow[];
    }

    const currentPrices = new Map(priceRows.map(r => [r.slug, r.probability]));
    const scannerDirections = await getLatestScannerDirectionMap();

    const marketMeta = new Map<string, Awaited<ReturnType<typeof fetchMarketBySlug>> | null>();
    await Promise.all(
      rows.map(async (row) => {
        if (marketMeta.has(row.slug)) return;
        try {
          marketMeta.set(row.slug, await fetchMarketBySlug(row.slug));
        } catch {
          marketMeta.set(row.slug, null);
        }
      })
    );

    const positions = rows.map(e => {
      const scannerDirection = scannerDirections.get(e.slug);
      const currentYes = currentPrices.get(e.slug) ?? getEntryYesPrice(e, scannerDirection);
      const metrics = calculateOpenExecutionMetrics(e, currentYes, scannerDirection);
      const meta = marketMeta.get(e.slug);
      const fallbackMarket = e.slug.split("-").map((w: any) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      return {
        id: String(e.id),
        executionId: e.id,
        slug: e.slug,
        market: meta?.question ?? fallbackMarket,
        question: meta?.question ?? fallbackMarket,
        tokenId: meta?.token_id ?? null,
        yesTokenId: meta?.yes_token_id ?? null,
        noTokenId: meta?.no_token_id ?? null,
        direction: metrics.direction,
        size: e.amount,
        entryPrice: metrics.entryTokenPrice,
        currentPrice: metrics.currentTokenPrice,
        pnl: metrics.pnl,
        pnlPct: e.amount > 0 ? metrics.pnl / e.amount : 0,
        source: e.source === "autopilot" ? "autopilot" : "manual",
        resolutionDate: e.resolution_date ?? meta?.resolution_date ?? null,
        executedAt: e.executed_at,
        status: e.status,
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
