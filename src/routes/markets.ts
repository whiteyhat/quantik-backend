import { Router, Request, Response } from "express";
import { runCli, CliError } from "../cli";

const router = Router();

function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : (v ?? "");
}

// GET /api/markets?search=QUERY&limit=20
router.get("/", async (req: Request, res: Response) => {
  try {
    const args = ["markets", "list"];
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const limit = typeof req.query.limit === "string" ? req.query.limit : undefined;
    if (search) args.push("--search", search);
    if (limit) args.push("--limit", limit);
    const data = await runCli(args);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// GET /api/markets/:slug
router.get("/:slug", async (req: Request, res: Response) => {
  try {
    const data = await runCli(["markets", "get", param(req, "slug")]);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// GET /api/markets/:tokenId/book
router.get("/:tokenId/book", async (req: Request, res: Response) => {
  try {
    const data = await runCli(["clob", "book", param(req, "tokenId")]);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// GET /api/markets/:tokenId/price-history?interval=1d&fidelity=30
router.get("/:tokenId/price-history", async (req: Request, res: Response) => {
  try {
    const args = ["clob", "price-history", param(req, "tokenId")];
    const interval = typeof req.query.interval === "string" ? req.query.interval : undefined;
    const fidelity = typeof req.query.fidelity === "string" ? req.query.fidelity : undefined;
    if (interval) args.push("--interval", interval);
    if (fidelity) args.push("--fidelity", fidelity);
    const data = await runCli(args);
    res.json(data);
  } catch (err) {
    handleCliError(res, err);
  }
});

// GET /api/markets/:tokenId/spread
router.get("/:tokenId/spread", async (req: Request, res: Response) => {
  try {
    const data = await runCli(["clob", "spread", param(req, "tokenId")]);
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
