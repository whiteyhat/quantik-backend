import { Router, Request, Response } from "express";
import { getSettings, setPaperMode } from "../db/queries";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgExec } from "../db/postgres";

const router = Router();

// ── GET /api/v1/settings ──────────────────────────────────────
router.get("/settings", async (_req: Request, res: Response) => {
  const settings = await getSettings();
  res.json({ paperMode: settings.paper_mode });
});

// ── GET /api/v1/settings/paper-mode ──────────────────────────
router.get("/settings/paper-mode", async (_req: Request, res: Response) => {
  const settings = await getSettings();
  res.json({ paperMode: settings.paper_mode });
});

// ── POST /api/v1/settings/paper-mode ─────────────────────────
router.post("/settings/paper-mode", async (req: Request, res: Response) => {
  const body: any = req.body;
  if (typeof body?.enabled !== "boolean") {
    res.status(400).json({ error: "Body must be { enabled: boolean }" });
    return;
  }
  const updated = await setPaperMode(body.enabled);
  res.json({ paperMode: updated.paper_mode });
});

// ── GET /api/v1/settings/telegram ────────────────────────────
router.get("/settings/telegram", async (_req: Request, res: Response) => {
  try {
    let rows: {key: string; value: string}[];

    if (isPgEnabled()) {
      rows = await pgQuery<{key: string; value: string}>(
        "SELECT key, value FROM settings_kv WHERE key IN ('telegram_chat_id', 'telegram_bot_token')"
      );
    } else {
      const db = getDb();
      rows = db.prepare("SELECT key, value FROM settings_kv WHERE key IN ('telegram_chat_id', 'telegram_bot_token')").all() as any[];
    }

    const settings: any = {};
    rows.forEach(r => settings[r.key] = r.value);

    res.json({
      chatId: settings.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || "",
      botToken: settings.telegram_bot_token ? "********" : (process.env.TELEGRAM_BOT_TOKEN ? "********" : ""),
      hasToken: !!(settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN)
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/settings/telegram ───────────────────────────
router.post("/settings/telegram", async (req: Request, res: Response) => {
  try {
    const { chatId, botToken } = req.body as { chatId?: string; botToken?: string };

    if (isPgEnabled()) {
      if (chatId !== undefined) {
        await pgExec(
          "INSERT INTO settings_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          ["telegram_chat_id", chatId]
        );
      }
      if (botToken !== undefined && botToken !== "********") {
        await pgExec(
          "INSERT INTO settings_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          ["telegram_bot_token", botToken]
        );
      }
    } else {
      const db = getDb();
      if (chatId !== undefined) {
        db.prepare("INSERT OR REPLACE INTO settings_kv (key, value) VALUES ('telegram_chat_id', ?)").run(chatId);
      }
      if (botToken !== undefined && botToken !== "********") {
        db.prepare("INSERT OR REPLACE INTO settings_kv (key, value) VALUES ('telegram_bot_token', ?)").run(botToken);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
