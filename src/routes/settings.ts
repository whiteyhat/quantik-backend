import { Router, Request, Response } from "express";
import { getSettings, setPaperMode } from "../db/queries";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery, pgExec } from "../db/postgres";
import { encrypt, decrypt, isEncryptionEnabled } from "../infra/encryption";
import { krakenAuthTest, type KrakenCredentials } from "../kraken/cli";
import { getKrakenTradingMode, setKrakenTradingMode, type KrakenTradingMode } from "../config/chain";
import { requireAdmin, isAdminRequest } from "../middleware/guards";

const router = Router();

// These settings are platform-wide, so every change is operator-only.
// Reads stay open but hide credentials and contact details from non-operators.

// ── GET /api/v1/settings (& /paper-mode alias) ───────────────
async function getPaperModeHandler(_req: Request, res: Response) {
  const settings = await getSettings();
  res.json({ paperMode: settings.paper_mode });
}
router.get("/settings", getPaperModeHandler);
router.get("/settings/paper-mode", getPaperModeHandler);

// ── POST /api/v1/settings/paper-mode ─────────────────────────
router.post("/settings/paper-mode", requireAdmin, async (req: Request, res: Response) => {
  const body: any = req.body;
  if (typeof body?.enabled !== "boolean") {
    res.status(400).json({ error: "Body must be { enabled: boolean }" });
    return;
  }
  const updated = await setPaperMode(body.enabled);
  res.json({ paperMode: updated.paper_mode });
});

// ── GET /api/v1/settings/telegram ────────────────────────────
router.get("/settings/telegram", async (req: Request, res: Response) => {
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

    const hasToken = !!(settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN);
    if (!isAdminRequest(req)) {
      res.json({ chatId: "", botToken: hasToken ? "********" : "", hasToken });
      return;
    }

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
router.post("/settings/telegram", requireAdmin, async (req: Request, res: Response) => {
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

// ── Kraken credential helpers ───────────────────────────────────

async function getKvValue(key: string): Promise<string | null> {
  if (isPgEnabled()) {
    const rows = await pgQuery<{ value: string }>(
      "SELECT value FROM settings_kv WHERE key = $1", [key]
    );
    return rows[0]?.value ?? null;
  }
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings_kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

async function setKvValue(key: string, value: string): Promise<void> {
  if (isPgEnabled()) {
    await pgExec(
      "INSERT INTO settings_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value]
    );
  } else {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings_kv (key, value) VALUES (?, ?)").run(key, value);
  }
}

async function deleteKvValue(key: string): Promise<void> {
  if (isPgEnabled()) {
    await pgExec("DELETE FROM settings_kv WHERE key = $1", [key]);
  } else {
    const db = getDb();
    db.prepare("DELETE FROM settings_kv WHERE key = ?").run(key);
  }
}

/** Load decrypted Kraken credentials from settings_kv, or null if not set. */
export async function loadKrakenCredentials(): Promise<KrakenCredentials | null> {
  const [encKey, encSecret] = await Promise.all([
    getKvValue("kraken_api_key"),
    getKvValue("kraken_api_secret"),
  ]);
  if (!encKey || !encSecret) return null;

  try {
    const encrypted = isEncryptionEnabled();
    return {
      apiKey: encrypted ? decrypt(encKey) : encKey,
      apiSecret: encrypted ? decrypt(encSecret) : encSecret,
    };
  } catch {
    console.warn("[Kraken] Failed to decrypt stored credentials — may need re-entry");
    return null;
  }
}

// ── GET /api/v1/settings/kraken ─────────────────────────────────
router.get("/settings/kraken", async (req: Request, res: Response) => {
  try {
    const [encKey, storedMode] = await Promise.all([
      getKvValue("kraken_api_key"),
      getKvValue("kraken_trading_mode"),
    ]);

    // Sync runtime mode from DB on load
    if (storedMode === "live" || storedMode === "paper") {
      setKrakenTradingMode(storedMode);
    }

    const hasCredentials = !!encKey;
    let apiKeyPrefix = "";
    if (hasCredentials && isAdminRequest(req)) {
      try {
        const plainKey = isEncryptionEnabled() ? decrypt(encKey!) : encKey!;
        apiKeyPrefix = plainKey.slice(0, 8) + "...";
      } catch {
        apiKeyPrefix = "(encrypted)";
      }
    }

    res.json({
      hasCredentials,
      apiKeyPrefix,
      tradingMode: getKrakenTradingMode(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/settings/kraken ────────────────────────────────
// Save Kraken API credentials (encrypted at rest)
router.post("/settings/kraken", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = req.body as { apiKey?: string; apiSecret?: string };

    if (!apiKey || !apiSecret) {
      res.status(400).json({ error: "Both apiKey and apiSecret are required" });
      return;
    }

    // Encrypt before storing
    const encrypted = isEncryptionEnabled();
    const storedKey = encrypted ? encrypt(apiKey) : apiKey;
    const storedSecret = encrypted ? encrypt(apiSecret) : apiSecret;

    await Promise.all([
      setKvValue("kraken_api_key", storedKey),
      setKvValue("kraken_api_secret", storedSecret),
    ]);

    res.json({
      success: true,
      apiKeyPrefix: apiKey.slice(0, 8) + "...",
      encrypted: isEncryptionEnabled(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/settings/kraken ──────────────────────────────
// Remove stored Kraken credentials
router.delete("/settings/kraken", requireAdmin, async (_req: Request, res: Response) => {
  try {
    await deleteKvValue("kraken_api_key");
    await deleteKvValue("kraken_api_secret");
    // Reset to paper mode when credentials are removed
    setKrakenTradingMode("paper");
    await setKvValue("kraken_trading_mode", "paper");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/settings/kraken/test ───────────────────────────
// Test Kraken credentials against the live API
router.post("/settings/kraken/test", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const creds = await loadKrakenCredentials();
    if (!creds) {
      res.status(400).json({ ok: false, error: "No Kraken credentials configured" });
      return;
    }

    const result = await krakenAuthTest(creds);
    res.json({ ok: true, result });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── PUT /api/v1/settings/kraken/mode ────────────────────────────
// Switch between paper and live trading mode
router.put("/settings/kraken/mode", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { mode } = req.body as { mode?: string };
    if (mode !== "paper" && mode !== "live") {
      res.status(400).json({ error: 'mode must be "paper" or "live"' });
      return;
    }

    // Live mode requires credentials
    if (mode === "live") {
      const creds = await loadKrakenCredentials();
      if (!creds) {
        res.status(400).json({ error: "Cannot switch to live mode without Kraken API credentials" });
        return;
      }
    }

    setKrakenTradingMode(mode as KrakenTradingMode);
    await setKvValue("kraken_trading_mode", mode);

    res.json({ tradingMode: mode });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
