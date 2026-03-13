// src/aura/fetchWithRetry.ts
// Shared fetch wrapper with automatic retry on 429 (rate limit) responses

const DEFAULT_TIMEOUT = 8000;
const MAX_RETRIES = 2;

export async function fetchWithRetry(
  url: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT, headers } = options;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      // Respect Retry-After header, default to exponential backoff
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000 || 2000, 10000)
        : (attempt + 1) * 2000; // 2s, 4s
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    return res;
  }

  // Shouldn't reach here, but TypeScript needs it
  throw new Error("Max retries exceeded");
}
