import { clerkMiddleware, requireAuth, getAuth } from "@clerk/express";
import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQueryOne, pgExec } from "../db/postgres";

const clerkEnabled = !!(process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

// Clerk middleware — verifies JWT and attaches auth to req (no-op when keys missing)
export const clerkAuth = clerkEnabled
  ? clerkMiddleware()
  : (_req: Request, _res: Response, next: NextFunction) => next();

// Require authentication — returns 401 if no valid session
export const requireClerkAuth = clerkEnabled
  ? requireAuth()
  : (_req: Request, _res: Response, next: NextFunction) => next();

// In-memory cache: clerk_id -> internal user id (avoids DB lookup per request)
const userIdCache = new Map<string, string>();

// Ensure user exists in our DB — creates if first login
export function ensureUser(req: Request, _res: Response, next: NextFunction) {
  const auth = getAuth(req);
  if (!auth?.userId) return next();

  // Fast path: cached
  if (userIdCache.has(auth.userId)) return next();

  if (isPgEnabled()) {
    // Async PostgreSQL path
    ensureUserPg(auth.userId).then(() => next()).catch(() => next());
  } else {
    // Sync SQLite path
    ensureUserSqlite(auth.userId);
    next();
  }
}

function ensureUserSqlite(clerkId: string): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM users WHERE clerk_id = ?")
    .get(clerkId) as { id: string } | undefined;

  if (existing) {
    userIdCache.set(clerkId, existing.id);
  } else {
    const id = uuidv4();
    db.prepare(
      "INSERT INTO users (id, clerk_id, created_at) VALUES (?, ?, ?)"
    ).run(id, clerkId, Date.now());
    userIdCache.set(clerkId, id);
  }
}

async function ensureUserPg(clerkId: string): Promise<void> {
  const existing = await pgQueryOne<{ id: string }>(
    "SELECT id FROM users WHERE clerk_id = $1", [clerkId]
  );

  if (existing) {
    userIdCache.set(clerkId, existing.id);
  } else {
    const id = uuidv4();
    await pgExec(
      "INSERT INTO users (id, clerk_id, created_at) VALUES ($1, $2, $3)",
      [id, clerkId, Date.now()]
    );
    userIdCache.set(clerkId, id);
  }
}

// Helper to get the internal user ID from a Clerk-authenticated request
export function getUserId(req: Request): string | null {
  const auth = getAuth(req);
  if (!auth?.userId) return null;

  // Fast path: cached
  const cached = userIdCache.get(auth.userId);
  if (cached) return cached;

  // Fallback: sync SQLite lookup (PG users should always be cached by ensureUser)
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM users WHERE clerk_id = ?")
    .get(auth.userId) as { id: string } | undefined;

  if (row) userIdCache.set(auth.userId, row.id);
  return row?.id ?? null;
}

// Async version of getUserId for routes that are fully async
export async function getUserIdAsync(req: Request): Promise<string | null> {
  const auth = getAuth(req);
  if (!auth?.userId) return null;

  const cached = userIdCache.get(auth.userId);
  if (cached) return cached;

  if (isPgEnabled()) {
    const row = await pgQueryOne<{ id: string }>(
      "SELECT id FROM users WHERE clerk_id = $1", [auth.userId]
    );
    if (row) userIdCache.set(auth.userId, row.id);
    return row?.id ?? null;
  }

  return getUserId(req);
}
