/**
 * alerts.ts — Telegram webhook + alert status routes
 */

import { Router, Request, Response } from "express";
import { safeEqual } from "../infra/internalAuth";
import { handleCallback, sendStatusUpdate } from "../alerts/telegramAlert";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgQueryOne, pgExec } from "../db/postgres";
import { requireAdmin } from "../middleware/guards";

const router = Router();

// ── POST /api/alerts/telegram/callback ───────────────────────────────────
router.post("/telegram/callback", async (req: Request, res: Response) => {
  // Telegram echoes the secret set via setWebhook(secret_token) in this header.
  // Fails closed: with no secret configured, nothing is accepted.
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const provided = req.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!webhookSecret || !safeEqual(provided, webhookSecret)) {
    res.status(401).json({ error: "Invalid webhook secret" });
    return;
  }
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
router.get("/status", async (req: Request, res: Response) => {
  try {
    const slug = typeof req.query.slug === "string" ? req.query.slug : null;

    let rows: any[];
    let mutedUntil = 0;
    let tgSettings: Record<string, string> = {};

    if (isPgEnabled()) {
      if (slug) {
        rows = await pgQuery(`
          SELECT pr.id, pr.market_slug AS slug, pr.market_question AS question,
                 pr.confidence, pr.signal_state, pr.alert_sent, pr.created_at
          FROM pipeline_runs pr
          WHERE pr.alert_sent != 0 AND pr.market_slug = $1
          ORDER BY pr.created_at DESC
          LIMIT 1
        `, [slug]);
      } else {
        rows = await pgQuery(`
          SELECT pr.id, pr.market_slug AS slug, pr.market_question AS question,
                 pr.confidence, pr.signal_state, pr.alert_sent, pr.created_at
          FROM pipeline_runs pr
          WHERE pr.alert_sent != 0
          ORDER BY pr.created_at DESC
          LIMIT 25
        `);
      }

      const muteRow = await pgQueryOne<{ value: string }>(
        "SELECT value FROM settings_kv WHERE key = 'mute_until'"
      );
      mutedUntil = muteRow ? parseInt(muteRow.value, 10) : 0;

      const tgRows = await pgQuery<{ key: string; value: string }>(
        "SELECT key, value FROM settings_kv WHERE key IN ('telegram_chat_id', 'telegram_bot_token')"
      );
      tgRows.forEach(r => tgSettings[r.key] = r.value);
    } else {
      const db = getDb();

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

      const muteRow = db.prepare("SELECT value FROM settings_kv WHERE key = 'mute_until'").get() as { value: string } | undefined;
      mutedUntil = muteRow ? parseInt(muteRow.value, 10) : 0;

      const tgRows = db.prepare("SELECT key, value FROM settings_kv WHERE key IN ('telegram_chat_id', 'telegram_bot_token')").all() as { key: string; value: string }[];
      tgRows.forEach(r => tgSettings[r.key] = r.value);
    }

    const isMuted = mutedUntil > Date.now();
    const telegramConfigured = !!(tgSettings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN);

    res.json({ alerts: rows, muted: isMuted, mutedUntil: isMuted ? mutedUntil : null, telegramConfigured });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/alerts/mute ─────────────────────────────────────────────────
router.post("/mute", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { seconds = 3600 } = req.body as { seconds?: number };
    const muteUntil = Date.now() + seconds * 1000;

    if (isPgEnabled()) {
      await pgExec(
        "INSERT INTO settings_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        ["mute_until", String(muteUntil)]
      );
    } else {
      const db = getDb();
      db.prepare("INSERT OR REPLACE INTO settings_kv (key, value) VALUES ('mute_until', ?)").run(String(muteUntil));
    }

    await sendStatusUpdate(`🔕 Alerts muted for ${Math.round(seconds / 60)} minutes`);
    res.json({ ok: true, mutedUntil: muteUntil });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/alerts/mute ───────────────────────────────────────────────
router.delete("/mute", requireAdmin, async (_req: Request, res: Response) => {
  try {
    if (isPgEnabled()) {
      await pgExec("DELETE FROM settings_kv WHERE key = 'mute_until'");
    } else {
      const db = getDb();
      db.prepare("DELETE FROM settings_kv WHERE key = 'mute_until'").run();
    }
    await sendStatusUpdate("🔔 Alerts unmuted");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/alerts/test ─────────────────────────────────────────────────
router.post("/test", requireAdmin, async (_req: Request, res: Response) => {
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
