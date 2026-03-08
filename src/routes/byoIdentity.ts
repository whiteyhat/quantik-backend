export type IdentitySource = "remote" | "random_fallback";

export interface ResolvedByoIdentity {
  name: string;
  description: string | null;
  avatar: string;
  identity_source: IdentitySource;
}

type FetchLike = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

const RANDOM_EMOJIS = ["🤖", "🦞", "🦊", "🐺", "🦅", "🧠", "⚡", "📈", "🧿", "🎯"];
const RANDOM_PREFIXES = ["Alpha", "Signal", "Vector", "Nova", "Helix", "Quantum", "Apex", "Pulse"];
const RANDOM_SUFFIXES = ["Claw", "Trader", "Sentinel", "Oracle", "Hunter", "Engine", "Pilot", "Scout"];
const RANDOM_DESCRIPTIONS = [
  "Autonomous OpenClaw trading agent connected to Quantik infrastructure.",
  "External AI agent running market analysis and execution workflows.",
  "Prediction market agent synchronized from external OpenClaw runtime.",
  "Quantik-integrated autonomous agent for analysis, risk, and trade execution.",
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function sanitizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 100).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function sanitizeDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 500).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function sanitizeEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const first = Array.from(trimmed)[0];
  return first ?? null;
}

function parseRemoteIdentity(payload: unknown): { name: string; description: string | null; avatar: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  const name = sanitizeName(obj.name);
  if (!name) return null;

  const description = sanitizeDescription(obj.description);
  const avatar = sanitizeEmoji(obj.emoji) ?? sanitizeEmoji(obj.avatar) ?? "🤖";

  return { name, description, avatar };
}

function buildIdentityUrl(agentUrl: string): string {
  const withSlash = agentUrl.endsWith("/") ? agentUrl : `${agentUrl}/`;
  return new URL("identity", withSlash).toString();
}

function isPrivateOrInternalHost(hostnameRaw: string): boolean {
  const host = hostnameRaw.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

export function validateExternalHttpsUrl(value: unknown, fieldName: "endpoint_url" | "agent_url"):
  | { ok: true; normalizedUrl: string }
  | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${fieldName} is required` };
  }

  const trimmed = value.trim();
  if (trimmed.length > 500) {
    return { ok: false, error: `${fieldName} must be 500 characters or less` };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") {
      return { ok: false, error: `${fieldName} must use HTTPS` };
    }

    if (isPrivateOrInternalHost(parsed.hostname)) {
      return { ok: false, error: `${fieldName} must not point to a private/internal address` };
    }

    return { ok: true, normalizedUrl: parsed.toString() };
  } catch {
    return { ok: false, error: `${fieldName} is not a valid URL` };
  }
}

export function normalizeLegacyByoIdentity(body: {
  name?: unknown;
  avatar?: unknown;
  description?: unknown;
}):
  | { ok: true; identity: { name: string; avatar: string; description: string | null } }
  | { ok: false; error: string } {
  const name = sanitizeName(body.name);
  if (!name) {
    return { ok: false, error: "name is required" };
  }

  const description = sanitizeDescription(body.description);
  const avatar = sanitizeEmoji(body.avatar) ?? "🤖";

  return {
    ok: true,
    identity: {
      name,
      avatar,
      description,
    },
  };
}

export function normalizeClaimedByoIdentity(body: {
  name?: unknown;
  emoji?: unknown;
  avatar?: unknown;
  description?: unknown;
}):
  | { ok: true; identity: { name: string; avatar: string; description: string | null } }
  | { ok: false; error: string } {
  const name = sanitizeName(body.name);
  if (!name) {
    return { ok: false, error: "name is required" };
  }

  return {
    ok: true,
    identity: {
      name,
      avatar: sanitizeEmoji(body.emoji) ?? sanitizeEmoji(body.avatar) ?? "🤖",
      description: sanitizeDescription(body.description),
    },
  };
}

export function generateRandomByoIdentity(): ResolvedByoIdentity {
  const id = Math.floor(100 + Math.random() * 900);
  return {
    name: `${pickRandom(RANDOM_PREFIXES)}${pickRandom(RANDOM_SUFFIXES)}${id}`,
    description: pickRandom(RANDOM_DESCRIPTIONS),
    avatar: pickRandom(RANDOM_EMOJIS),
    identity_source: "random_fallback",
  };
}

export async function resolveByoIdentity(agentUrl: string, fetchImpl: FetchLike = fetch): Promise<ResolvedByoIdentity> {
  try {
    const identityUrl = buildIdentityUrl(agentUrl);
    const response = await fetchImpl(identityUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`identity endpoint returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const parsed = parseRemoteIdentity(payload);
    if (!parsed) {
      throw new Error("identity payload missing required fields");
    }

    return {
      ...parsed,
      identity_source: "remote",
    };
  } catch {
    return generateRandomByoIdentity();
  }
}
