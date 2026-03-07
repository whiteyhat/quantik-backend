import IORedis from "ioredis";

// ── Redis Connection ──────────────────────────────────────────────────────────
// Supports both Upstash (REDIS_URL with TLS) and local Redis.
// Falls back to in-memory stubs when REDIS_URL is not set.

let connection: IORedis | null = null;

export function getRedis(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("[redis] REDIS_URL is not set");
    }

    connection = new IORedis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: false,
      ...(url.startsWith("rediss://") ? { tls: { rejectUnauthorized: false } } : {}),
    });

    connection.on("error", (err) => {
      console.error("[redis] Connection error:", err.message);
    });

    connection.on("connect", () => {
      console.log("[redis] Connected");
    });
  }
  return connection;
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
