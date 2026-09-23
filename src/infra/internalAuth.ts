import crypto from "crypto";
import type { Request } from "express";

// ── Internal self-calls ─────────────────────────────────────────────────────
// A few server paths call this API over HTTP (autopilot's FLUX check, chat
// tools running the pipeline). They carry a per-process random secret so the
// route guards can trust them. The secret never leaves this process.

const INTERNAL_TOKEN = crypto.randomBytes(32).toString("hex");
const INTERNAL_HEADER = "x-quantik-internal";
const ON_BEHALF_HEADER = "x-quantik-user";

/** Base URL for calling this same server process. */
export const SELF_BASE_URL = `http://localhost:${process.env.PORT || "3001"}`;

/** Headers for an internal call, optionally acting for an internal user id. */
export function internalHeaders(onBehalfOfUserId?: string | null): Record<string, string> {
  return {
    [INTERNAL_HEADER]: INTERNAL_TOKEN,
    ...(onBehalfOfUserId ? { [ON_BEHALF_HEADER]: onBehalfOfUserId } : {}),
  };
}

/** Constant-time string comparison that never throws on odd bytes. */
export function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isInternalRequest(req: Request): boolean {
  const provided = req.get(INTERNAL_HEADER);
  return !!provided && safeEqual(provided, INTERNAL_TOKEN);
}

/** The user an internal call acts for; null for external requests. */
export function internalOnBehalfOf(req: Request): string | null {
  return isInternalRequest(req) ? req.get(ON_BEHALF_HEADER) ?? null : null;
}
