import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";

const router = Router();

const WALLET_ADDRESS =
  process.env.WALLET_ADDRESS ||
  "0x7EE996AbE9355a126F010EfF93487e84b2cE4b53";

// BUG 4 fix: Module-level cache for wallet balance (5-min TTL)
let walletCache: { value: any; fetchedAt: number } | null = null;
const WALLET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// GET /api/wallet/balance
router.get("/balance", async (_req: Request, res: Response) => {
  try {
    if (walletCache && Date.now() - walletCache.fetchedAt < WALLET_CACHE_TTL) {
      console.log("[wallet:cache] hit");
      res.json(walletCache.value);
      return;
    }
    console.log("[wallet:cache] miss");
    const data = await runCli(["clob", "balance", "--asset-type", "collateral"]);
    walletCache = { value: data, fetchedAt: Date.now() };
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// GET /api/wallet/positions
router.get("/positions", async (_req: Request, res: Response) => {
  try {
    const data = await runCli(["data", "positions", WALLET_ADDRESS]);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// GET /api/wallet/orders
router.get("/orders", async (_req: Request, res: Response) => {
  try {
    const data = await runCli(["clob", "orders"]);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// GET /api/wallet/trades
router.get("/trades", async (_req: Request, res: Response) => {
  try {
    const data = await runCli(["clob", "trades"]);
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
