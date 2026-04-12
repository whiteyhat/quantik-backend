import { Request, Response, NextFunction } from "express";
import { isRedisEnabled, getRedis } from "./redis";

// ── Redis-backed Sliding Window Rate Limiter ──────────────────────────────────
// Uses Redis sorted sets for precise sliding window rate limiting.
// Falls back to no-op when Redis is not configured.

interface RateLimitConfig {
  windowMs: number;   // Time window in milliseconds
  max: number;        // Max requests per window
  keyPrefix: string;  // Redis key prefix
}

function getClientKey(req: Request, prefix: string): string {
  // Use Clerk user ID if available, fall back to IP
  const userId = (req as unknown as { auth?: { userId?: string } }).auth?.userId;
  const identifier = userId ?? req.ip ?? "anonymous";
  return `rl:${prefix}:${identifier}`;
}

export function rateLimit(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isRedisEnabled()) {
      next();
      return;
    }

    const key = getClientKey(req, config.keyPrefix);
    const now = Date.now();
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

      // Set rate limit headers
      res.setHeader("X-RateLimit-Limit", config.max);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, config.max - count - 1));
      res.setHeader("X-RateLimit-Reset", Math.ceil((now + config.windowMs) / 1000));

      if (count >= config.max) {
        const retryAfter = Math.ceil(config.windowMs / 1000);
        res.setHeader("Retry-After", retryAfter);
        res.status(429).json({
          success: false,
          error: "Too many requests",
          code: "RATE_LIMITED",
          retryAfter,
        });
        return;
      }

      next();
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

/** 120 general API requests per minute */
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyPrefix: "api",
});

/** 3 bridge operations per minute */
export const bridgeRateLimit = rateLimit({
  windowMs: 60_000,
  max: 3,
  keyPrefix: "bridge",
});
