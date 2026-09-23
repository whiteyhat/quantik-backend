// ── Allowed browser origins (HTTP CORS + Socket.IO) ─────────────────────────

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3002",
  "http://127.0.0.1:3002",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://mission.adflix.now",
  "https://quantik.fun",
  "https://www.quantik.fun",
  "https://quantik-eight.vercel.app",
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

// Vercel preview deployments of the "quantik" project on the elixir-games team:
// quantik-<hash>-elixir-games.vercel.app. The hash segment has no hyphens, so
// another team whose slug merely ends in "-elixir-games" can't match.
const VERCEL_PREVIEW = /^quantik-[a-z0-9]+-elixir-games\.vercel\.app$/;

/** Exact origins, this project's Vercel previews, and our own subdomains. */
export function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  let hostname: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    hostname = url.hostname;
  } catch {
    return false;
  }
  if (VERCEL_PREVIEW.test(hostname)) return true;
  return hostname.endsWith(".adflix.now") || hostname.endsWith(".quantik.fun");
}
