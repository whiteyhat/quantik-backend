/**
 * alerts.ts — Telegram webhook + alert status routes
 */

import { Router, Request, Response } from "express";
import { handleCallback, sendStatusUpdate } from "../alerts/telegramAlert";
import { getDb } from "../db/schema";

const router = Router();

// ── POST /api/alerts/telegram/callback ───────────────────────────────────
router.post("/telegram/callback", async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const cbq  = body["callback_query"] as Record<string, unknown> | undefined;

    if (!cbq) { res.json({ ok: true }); return; }

    const data = cbq["data"] as string | undefined;
    const id   = cbq["id"]   as string | undefined;

    if (!data || !id) { res.status(400).json({ error: "Missing callback data" }); return; }

    // ACK immediately so Telegram removes the loading spinner
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: id }),
      }
    );

    handleCallback(data).catch((err) =>
      console.error("[alerts] handleCallback error:", err)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[alerts] callback error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/alerts/status ────────────────────────────────────────────────
router.get("/status", (req: Request, res: Response) => {
  try {
    const db   = getDb();
    const slug = typeof req.query.slug === "string" ? req.query.slug : null;

    let rows;
    if (slug) {
      rows = db.prepare(`
        SELECT pr.id, pr.market_slug AS slug, pr.market_question AS question,
               pr.confidence, pr.signal_state, pr.alert_sent, pr.created_at
        FROM pipeline_runs pr
        WHERE pr.alert_sent != 0 AND pr.market_slug = ?
        ORDER BY pr.created_at DESC
        LIMIT 1
      `).all(slug);
    } else {
      rows = db.prepare(`
        SELECT pr.id, pr.market_slug AS slug, pr.market_question AS question,
               pr.confidence, pr.signal_state, pr.alert_sent, pr.created_at
        FROM pipeline_runs pr
        WHERE pr.alert_sent != 0
        ORDER BY pr.created_at DESC
        LIMIT 25
      `).all();
    }

    const muteRow   = db.prepare("SELECT value FROM settings_kv WHERE key = 'mute_until'").get() as { value: string } | undefined;
    const mutedUntil = muteRow ? parseInt(muteRow.value, 10) : 0;
    const isMuted    = mutedUntil > Date.now();

    // Check if Telegram is configured
    const tgRows = db.prepare("SELECT key, value FROM settings_kv WHERE key IN ('telegram_chat_id', 'telegram_bot_token')").all() as { key: string; value: string }[];
    const tgSettings: Record<string, string> = {};
    tgRows.forEach(r => tgSettings[r.key] = r.value);
    const telegramConfigured = !!(tgSettings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN);

    res.json({ alerts: rows, muted: isMuted, mutedUntil: isMuted ? mutedUntil : null, telegramConfigured });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/alerts/mute ─────────────────────────────────────────────────
router.post("/mute", async (req: Request, res: Response) => {
  try {
    const { seconds = 3600 } = req.body as { seconds?: number };
    const db        = getDb();
    const muteUntil = Date.now() + seconds * 1000;
    db.prepare("INSERT OR REPLACE INTO settings_kv (key, value) VALUES ('mute_until', ?)").run(String(muteUntil));
    await sendStatusUpdate(`🔕 Alerts muted for ${Math.round(seconds / 60)} minutes`);
    res.json({ ok: true, mutedUntil: muteUntil });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/alerts/mute ───────────────────────────────────────────────
router.delete("/mute", async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM settings_kv WHERE key = 'mute_until'").run();
    await sendStatusUpdate("🔔 Alerts unmuted");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/alerts/test ─────────────────────────────────────────────────
router.post("/test", async (_req: Request, res: Response) => {
  try {
    const ok = await sendStatusUpdate(
      `🧪 <b>Quantik Alert Engine</b> — ping OK\n${new Date().toISOString()}`
    );
    res.json({ ok, sent: ok });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
