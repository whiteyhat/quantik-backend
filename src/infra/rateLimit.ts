import { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { isRedisEnabled, getRedis } from "./redis";
import { isInternalRequest, internalOnBehalfOf } from "./internalAuth";

// ── Sliding Window Rate Limiter ───────────────────────────────────────────────
// Uses Redis sorted sets when REDIS_URL is set. Without Redis it keeps the
// window in process memory, which is exact while the API runs as one instance.

interface RateLimitConfig {
  windowMs: number;   // Time window in milliseconds
  max: number;        // Max requests per window
  keyPrefix: string;  // Redis key prefix
}

function getClientKey(req: Request, prefix: string): string {
  // Use Clerk user ID if available, fall back to IP (real client IP via trust proxy)
  let userId: string | null = null;
  try {
    userId = getAuth(req)?.userId ?? null;
  } catch {
    // Clerk middleware not mounted (tests, local dev without keys)
  }
  // Internal calls made for a user (chat tools) count against that user
  const onBehalfOf = internalOnBehalfOf(req);
  if (onBehalfOf) return `rl:${prefix}:user:${onBehalfOf}`;
  // BYO agents share an IP with their host; key them by agent instead
  const agentId = req.apiKeyAgent?.agentId;
  const identifier = userId ?? (agentId ? `agent:${agentId}` : null) ?? req.ip ?? "anonymous";
  return `rl:${prefix}:${identifier}`;
}

// ── In-memory window (no Redis) ──────────────────────────────────────────────

const memoryWindows = new Map<string, { hits: number[]; expiresAt: number }>();
let lastSweepAt = 0;

/** Requests already counted in this window; records the new one unless it's over the limit. */
export function hitMemoryWindow(key: string, config: RateLimitConfig, now: number): number {
  const windowStart = now - config.windowMs;
  const entry = memoryWindows.get(key);
  const hits = entry ? entry.hits.filter((t) => t > windowStart) : [];
  const count = hits.length;
  if (count < config.max) hits.push(now);
  memoryWindows.set(key, { hits, expiresAt: now + config.windowMs });

  // Drop idle clients once a minute so the map can't grow without bound
  if (now - lastSweepAt > 60_000) {
    lastSweepAt = now;
    for (const [k, v] of memoryWindows) if (v.expiresAt < now) memoryWindows.delete(k);
  }
  return count;
}

/** Sets rate-limit headers; sends 429 and returns true when over the limit. */
function rejectIfOverLimit(res: Response, config: RateLimitConfig, count: number, now: number): boolean {
  res.setHeader("X-RateLimit-Limit", config.max);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, config.max - count - 1));
  res.setHeader("X-RateLimit-Reset", Math.ceil((now + config.windowMs) / 1000));
  if (count < config.max) return false;

  const retryAfter = Math.ceil(config.windowMs / 1000);
  res.setHeader("Retry-After", retryAfter);
  res.status(429).json({
    success: false,
    error: "Too many requests",
    code: "RATE_LIMITED",
    retryAfter,
  });
  return true;
}

export function rateLimit(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // System self-calls (autopilot, relay fan-out) aren't user traffic;
    // calls made for a user are limited as that user (see getClientKey)
    if (isInternalRequest(req) && !internalOnBehalfOf(req)) {
      next();
      return;
    }
    const key = getClientKey(req, config.keyPrefix);
    const now = Date.now();

    if (!isRedisEnabled()) {
      if (!rejectIfOverLimit(res, config, hitMemoryWindow(key, config, now), now)) next();
      return;
    }


    const windowStart = now - config.windowMs;

    try {
      const redis = getRedis();
      const pipeline = redis.pipeline();

      // Remove expired entries
      pipeline.zremrangebyscore(key, 0, windowStart);
      // Count current window
      pipeline.zcard(key);
      // Add current request
      pipeline.zadd(key, now, `${now}:${Math.random()}`);
      // Set TTL
      pipeline.pexpire(key, config.windowMs);

      const results = await pipeline.exec();
      const count = (results?.[1]?.[1] as number) ?? 0;

      if (!rejectIfOverLimit(res, config, count, now)) next();
    } catch {
      // Redis error — fail open (allow request)
      next();
    }
  };
}

// ── Pre-configured Rate Limiters ──────────────────────────────────────────────

/** 60 chat messages per minute */
export const chatRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyPrefix: "chat",
});

/** 10 trade executions per minute */
export const tradeRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyPrefix: "trade",
});

/** 5 pipeline runs per minute */
export const pipelineRateLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyPrefix: "pipeline",
});

/** 300 general API requests per minute (one dashboard tab polls ~50/min) */
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  max: 300,
  keyPrefix: "api",
});
