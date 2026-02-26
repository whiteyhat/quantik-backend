import { Router, Request, Response } from "express";
import { getSettings, setPaperMode } from "../db/queries";

const router = Router();

// ── GET /api/v1/settings ──────────────────────────────────────
router.get("/settings", (_req: Request, res: Response) => {
  const settings = getSettings();
  res.json({ paperMode: settings.paper_mode });
});

// ── GET /api/v1/settings/paper-mode ──────────────────────────
router.get("/settings/paper-mode", (_req: Request, res: Response) => {
  const settings = getSettings();
  res.json({ paperMode: settings.paper_mode });
});

// ── POST /api/v1/settings/paper-mode ─────────────────────────
router.post("/settings/paper-mode", (req: Request, res: Response) => {
  const body: unknown = req.body;

  if (
    body === null ||
    typeof body !== "object" ||
    !("enabled" in body) ||
    typeof (body as Record<string, unknown>)["enabled"] !== "boolean"
  ) {
    res.status(400).json({ error: "Body must be { enabled: boolean }" });
    return;
  }

  const enabled = (body as { enabled: boolean }).enabled;
  const updated = setPaperMode(enabled);
  res.json({ paperMode: updated.paper_mode });
});

export default router;
