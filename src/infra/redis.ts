import IORedis from "ioredis";

// ── Redis Connection ──────────────────────────────────────────────────────────
// Supports both Upstash (REDIS_URL with TLS) and local Redis.
// Falls back to in-memory stubs when REDIS_URL is not set.

let connection: IORedis | null = null;
let redisHealthy = true;

export function getRedis(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("[redis] REDIS_URL is not set");
    }

    connection = new IORedis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: false,
      connectTimeout: 10000,      // fail fast: 10s connection timeout
      retryStrategy(times) {
        if (times > 5) {
          console.error("[redis] Max retries reached — giving up");
          redisHealthy = false;
          return null; // stop retrying
        }
        return Math.min(times * 1000, 5000); // 1s, 2s, 3s, 4s, 5s
      },
      ...(url.startsWith("rediss://") ? { tls: { rejectUnauthorized: false } } : {}),
    });

    connection.on("error", (err) => {
      console.error("[redis] Connection error:", err.message);
    });

    connection.on("connect", () => {
      redisHealthy = true;
      console.log("[redis] Connected");
    });
  }
  return connection;
}

/** Returns false if Redis exhausted its retries and is unreachable */
export function isRedisHealthy(): boolean {
  return redisHealthy;
}

export function isRedisEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

// ── Redis Cache Helpers ───────────────────────────────────────────────────────

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isRedisEnabled()) return null;
  try {
    const val = await getRedis().get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!isRedisEnabled()) return;
  try {
    await getRedis().set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {}
}

export async function cacheDel(key: string): Promise<void> {
  if (!isRedisEnabled()) return;
  try {
    await getRedis().del(key);
  } catch {}
}
