/**
 * Sentry Webhook Receiver + Telegram Error Forwarder
 *
 * Required env vars (set in Railway):
 *   SENTRY_WEBHOOK_SECRET  — HMAC signing secret from Sentry integration settings
 *                            (optional: validation is skipped when not set)
 *   TELEGRAM_BOT_TOKEN     — Bot token from @BotFather used to send alert messages
 */

import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { IncomingHttpHeaders } from "http";

export const sentryWebhookRouter = Router();

// ── Telegram config ────────────────────────────────────────────

const TELEGRAM_CHAT_ID = "-5238563355";
const TELEGRAM_API_BASE = "https://api.telegram.org";

// ── Sentry payload types ───────────────────────────────────────

interface SentryStackFrame {
  filename?: string;
  lineno?: number;
  function?: string;
  module?: string;
}

interface SentryException {
  values?: Array<{
    type?: string;
    value?: string;
    stacktrace?: {
      frames?: SentryStackFrame[];
    };
  }>;
}

interface SentryEvent {
  title?: string;
  culprit?: string;
  level?: string;
  environment?: string;
  project?: string;
  web_url?: string;
  url?: string;
  exception?: SentryException;
}

interface SentryWebhookPayload {
  action?: string;
  actor?: { id?: number; name?: string; type?: string };
  data?: {
    event?: SentryEvent;
    issue?: {
      title?: string;
      culprit?: string;
      level?: string;
      permalink?: string;
      project?: { slug?: string; name?: string };
      metadata?: { value?: string; type?: string };
    };
  };
  installation?: { uuid?: string };
}

// ── Helpers ────────────────────────────────────────────────────

function verifySignature(
  rawBody: string,
  headers: IncomingHttpHeaders,
  secret: string
): boolean {
  const signature = headers["sentry-hook-signature"];
  if (typeof signature !== "string") return false;

  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

function escapeMarkdown(text: string): string {
  // Escape Telegram Markdown special chars (v1): _ * ` [
  return text.replace(/([_*`[])/g, "\\$1");
}

function extractFirstFrame(
  exception: SentryException | undefined
): string | null {
  const frames =
    exception?.values?.[0]?.stacktrace?.frames;
  if (!frames || frames.length === 0) return null;

  // Sentry frames are innermost-last; take the last (most relevant) frame
  const frame = frames[frames.length - 1];
  const file = frame.filename ?? frame.module ?? "unknown";
  const line = frame.lineno != null ? String(frame.lineno) : "?";
  return `${file}:${line}`;
}

function buildTelegramMessage(payload: SentryWebhookPayload): string {
  const event = payload.data?.event;
  const issue = payload.data?.issue;

  const level = event?.level ?? issue?.level ?? "error";
  const project =
    event?.project ??
    issue?.project?.slug ??
    issue?.project?.name ??
    "unknown";
  const environment = event?.environment ?? "production";
  const title =
    event?.title ??
    issue?.title ??
    issue?.metadata?.type ??
    "Unknown error";
  const culprit = event?.culprit ?? issue?.culprit ?? "";
  const viewUrl =
    event?.web_url ?? event?.url ?? issue?.permalink ?? "";
  const topFrame = extractFirstFrame(event?.exception);

  const levelEmoji: Record<string, string> = {
    error: "🚨",
    warning: "⚠️",
    info: "ℹ️",
    debug: "🐛",
    fatal: "💀",
  };
  const emoji = levelEmoji[level] ?? "🚨";

  const lines: string[] = [
    `${emoji} *Sentry Alert — ${escapeMarkdown(level)}*`,
    `*${escapeMarkdown(project)}* · ${escapeMarkdown(environment)}`,
    "",
    escapeMarkdown(title),
  ];

  if (culprit) {
    lines.push(escapeMarkdown(culprit));
  }

  if (topFrame) {
    lines.push("");
    lines.push(`Top frame: \`${topFrame}\``);
  }

  if (viewUrl) {
    lines.push("");
    lines.push(`View: ${viewUrl}`);
  }

  return lines.join("\n");
}

async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[sentry-webhook] TELEGRAM_BOT_TOKEN not set — skipping Telegram notification");
    return;
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error(`[sentry-webhook] Telegram API error ${res.status}: ${detail}`);
    throw new Error(`Telegram API returned ${res.status}`);
  }
}

// ── Routes ─────────────────────────────────────────────────────

/**
 * GET /api/webhooks/sentry/health
 * Returns configuration status.
 */
sentryWebhookRouter.get("/health", (_req: Request, res: Response): void => {
  const configured =
    Boolean(process.env.SENTRY_WEBHOOK_SECRET) &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN);

  res.json({ ok: true, configured });
});

/**
 * POST /api/webhooks/sentry
 * Receives Sentry webhook events, validates HMAC, forwards to Telegram.
 */
sentryWebhookRouter.post(
  "/",
  async (req: Request, res: Response): Promise<void> => {
    // HMAC validation. Fails closed: without a secret nothing is accepted.
    const secret = process.env.SENTRY_WEBHOOK_SECRET;
    if (!secret) {
      res.status(503).json({ error: "Webhook not configured" });
      return;
    }
    const rawBody: string =
      typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

    if (!verifySignature(rawBody, req.headers, secret)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const payload = req.body as unknown;

    // Basic shape validation
    if (!payload || typeof payload !== "object") {
      res.status(400).json({ error: "Malformed payload: expected JSON object" });
      return;
    }

    const typed = payload as SentryWebhookPayload;

    if (!typed.data) {
      res.status(400).json({ error: "Malformed payload: missing data field" });
      return;
    }

    try {
      const message = buildTelegramMessage(typed);
      await sendTelegramMessage(message);
      res.json({ received: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      console.error("[sentry-webhook] Failed to forward alert:", message);
      res.status(500).json({ error: message });
    }
  }
);
