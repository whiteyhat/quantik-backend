import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";

const router = Router();

const WALLET_ADDRESS =
  process.env.WALLET_ADDRESS ||
  "0x7EE996AbE9355a126F010EfF93487e84b2cE4b53";

// GET /api/wallet/balance
router.get("/balance", async (_req: Request, res: Response) => {
  try {
    const data = await runCli(["clob", "balance", "--asset-type", "collateral"]);
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
