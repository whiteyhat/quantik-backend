import { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { getUserIdAsync } from "./auth";
import { isInternalRequest } from "../infra/internalAuth";

// ── Route guards ─────────────────────────────────────────────────────────────
// clerkAuth runs globally but never blocks. These guards are what actually
// keep signed-out visitors (and non-operators) away from real actions.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 401 unless the request carries a signed-in Clerk session (or is an internal self-call). */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (isInternalRequest(req)) {
    next();
    return;
  }
  getUserIdAsync(req)
    .then((userId) => {
      if (!userId) {
        res.status(401).json({ error: "Sign in required", code: "UNAUTHORIZED" });
        return;
      }
      next();
    })
    .catch(next);
}

if (!process.env.ADMIN_USER_IDS?.trim()) {
  console.warn("[guards] ADMIN_USER_IDS is empty: panic mode and platform settings are locked for everyone");
}

/** Clerk user IDs allowed to change platform-wide state, from ADMIN_USER_IDS. */
function adminUserIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

function clerkUserId(req: Request): string | null {
  try {
    return getAuth(req)?.userId ?? null;
  } catch {
    return null;
  }
}

export function isAdminRequest(req: Request): boolean {
  const clerkId = clerkUserId(req);
  return !!clerkId && adminUserIds().has(clerkId);
}

/**
 * Platform-wide controls (global settings, panic mode, circuit breakers).
 * Fails closed: with ADMIN_USER_IDS unset, nobody can use them.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!clerkUserId(req)) {
    res.status(401).json({ error: "Sign in required", code: "UNAUTHORIZED" });
    return;
  }
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "Only Quantik operators can change this", code: "FORBIDDEN" });
    return;
  }
  next();
}

/** Applies a guard to state-changing methods only; reads pass through. */
export function forWrites(guard: RequestHandler): RequestHandler {
  return (req, res, next) => (SAFE_METHODS.has(req.method) ? next() : guard(req, res, next));
}
