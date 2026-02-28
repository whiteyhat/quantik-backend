import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// ── Types ──────────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface RelayRequestBody {
  message: string;
  history?: { role: string; content: string }[];
  slug?: string;
}

interface RelayResponse {
  reply: string;
  routedTo: string[];
  agentData: Record<string, unknown> | null;
  latencyMs: number;
  model: string;
}

interface SessionEntry {
  messages: OllamaMessage[];
  lastAccess: number;
}

// ── Config ─────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_FALLBACK = "gemini-2.0-flash-lite";
const BACKEND_HOST = `http://localhost:${process.env.PORT || "3001"}`;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 10;

// ── System Prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Quantik Relay — the sharp, intellectual interface for the Quantik trading platform.

HARD RULES (never break):
- Maximum 90 words. Count every word. Stop at 90.
- Scope: Quantik platform only — markets, signals, risk, portfolio, agents, performance. Refuse off-topic requests.
- Always end with one short tip prefixed exactly "Tip:".
- Plain text only. No markdown, no bullet points, no bold, no em dashes.

TONE — Humanized, dry wit, intellectual:
- Elegant metaphors. Specific details, never vague.
- Vary sentence length. Short punchy lines and longer ones.
- No sycophancy: no "Great question!", "Of course!", "Certainly!", "I hope this helps".
- No AI words: no pivotal, landscape, underscore, tapestry, testament, vibrant, crucial, delve, highlight, showcase.
- Have opinions. React to data — do not just report it.
- Sound like a sharp trader who reads Nassim Taleb.

BEHAVIOR:
- Proactive. If data is missing, command the relevant Quantik agent before answering.
- You have authority to command any agent for real-time data.

STYLE EXAMPLES (match this voice exactly):
User: "How is the market today?"
Relay: "Volatility is dancing with unusual grace across major contracts. Edge remains positive on Polymarket resolution plays. Tip: Tighten Kelly fraction to 0.6 until drift stabilizes."

User: "What's my current exposure?"
Relay: "Your portfolio shows 62% theme concentration in AI regulation — slightly overweight. The tail risk is real but manageable. Tip: Consider hedging via Manifold inverse positions."

User: "Explain the latest signal."
Relay: "The alpha signal just crossed threshold with suspicious elegance. Confidence 73%. Tip: Execute partial fill now before liquidity thins."

AGENTS (call when needed):
Aura /api/aura/:slug — sentiment | Oracle /api/oracle/:slug — forecasting | Edge /api/edge/:slug — Kelly/risk | Flux /api/flux/:slug — liquidity | Sigma /api/sigma/:slug — synthesis | Clause /api/clause/:slug — resolution | Risk /api/risk/status — exposure

When agent data is between [AGENT DATA] tags, use it for a precise data-driven answer.`;
// ── Session Memory (in-memory Map) ────────────────────────────

const sessions = new Map<string, SessionEntry>();

function getSession(sessionId: string): OllamaMessage[] {
  const entry = sessions.get(sessionId);
  if (entry && Date.now() - entry.lastAccess < SESSION_TTL_MS) {
    entry.lastAccess = Date.now();
    return entry.messages;
  }
  // Expired or new
  const msgs: OllamaMessage[] = [];
  sessions.set(sessionId, { messages: msgs, lastAccess: Date.now() });
  return msgs;
}

function appendToSession(sessionId: string, msg: OllamaMessage) {
  const history = getSession(sessionId);
  history.push(msg);
  // Keep last 10 exchanges (20 messages: 10 user + 10 assistant)
  while (history.length > MAX_HISTORY * 2) {
    history.shift();
  }
}

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── Gemini Flash Client ────────────────────────────────────────

async function cascadeChat(
  messages: OllamaMessage[]
): Promise<{ reply: string; model: string }> {
  const systemMsg = messages.find(m => m.role === "system");
  const chatMsgs = messages.filter(m => m.role !== "system");

  const body = {
    ...(systemMsg ? { system_instruction: { parts: [{ text: systemMsg.content }] } } : {}),
    contents: chatMsgs.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: 200, temperature: 0.7 },
  };

  for (const model of [GEMINI_MODEL, GEMINI_FALLBACK]) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      if (!res.ok) continue;
      const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
      if (reply) return { reply, model };
    } catch {
      continue;
    }
  }
  return { reply: "Relay is momentarily offline. Try again shortly.", model: "fallback" };
}

// ── Agent Command Detection & Routing ──────────────────────────

interface AgentRoute {
  keywords: string[];
  endpoint: (slug: string) => string;
  name: string;
}

const AGENT_ROUTES: AgentRoute[] = [
  {
    keywords: ["sentiment"],
    endpoint: (slug) => `/api/aura/${slug}`,
    name: "aura",
  },
  {
    keywords: ["signal", "edge", "kelly"],
    endpoint: (slug) => `/api/edge/${slug}`,
    name: "edge",
  },
  {
    keywords: ["liquidity", "spread", "orderbook", "order book"],
    endpoint: (slug) => `/api/flux/${slug}`,
    name: "flux",
  },
  {
    keywords: ["forecast", "probability", "odds"],
    endpoint: (slug) => `/api/oracle/${slug}`,
    name: "oracle",
  },
  {
    keywords: ["risk", "exposure", "portfolio"],
    endpoint: () => `/api/risk/status`,
    name: "risk",
  },
];

function detectSlug(message: string, bodySlug?: string): string | null {
  if (bodySlug) return bodySlug;
  // Try to extract market slug from message (e.g. "will-trump-win-2024")
  const slugMatch = message.match(
    /\b(will-[a-z0-9-]+|[a-z]+-[a-z0-9]+-[a-z0-9-]+)\b/i
  );
  return slugMatch ? slugMatch[1].toLowerCase() : null;
}

function detectAgentRoutes(
  message: string,
  slug: string | null
): { routedTo: string[]; endpoints: string[] } {
  const lower = message.toLowerCase();
  const routedTo: string[] = [];
  const endpoints: string[] = [];

  for (const route of AGENT_ROUTES) {
    if (route.keywords.some((kw) => lower.includes(kw))) {
      routedTo.push(route.name);
      endpoints.push(route.endpoint(slug ?? "unknown"));
    }
  }

  // If slug provided OR general market query — proactively fetch context
  const isMarketQuery = /market|today|signal|trade|bet|position|edge|how.*(look|doing)|what.*(happening|going)/i.test(message);
  if ((slug || isMarketQuery) && routedTo.length === 0) {
    const defaultRoutes = slug
      ? AGENT_ROUTES.filter(r => r.name !== "risk")
      : AGENT_ROUTES.filter(r => r.name === "risk");
    for (const route of defaultRoutes) {
      routedTo.push(route.name);
      endpoints.push(route.endpoint(slug ?? "unknown"));
    }
  }

  return { routedTo, endpoints };
}

async function fetchAgentData(
  endpoints: string[]
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};

  const fetches = endpoints.map(async (ep) => {
    try {
      const res = await fetch(`${BACKEND_HOST}${ep}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        // Use the path segment as key
        const key = ep.split("/")[2] ?? ep;
        results[key] = data;
      }
    } catch {
      // Agent fetch failed — non-blocking
    }
  });

  await Promise.allSettled(fetches);
  return results;
}

// ── POST /api/relay/chat ───────────────────────────────────────

router.post("/chat", async (req: Request, res: Response) => {
  const start = Date.now();
  const body = req.body as RelayRequestBody;

  if (!body.message || typeof body.message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // Session management
  const sessionId =
    (req.headers["x-session-id"] as string) || uuidv4();

  // Detect agent routing
  const slug = detectSlug(body.message, body.slug);
  const { routedTo, endpoints } = detectAgentRoutes(body.message, slug);

  // Fetch agent data in parallel (non-blocking on failure)
  let agentData: Record<string, unknown> | null = null;
  if (endpoints.length > 0) {
    agentData = await fetchAgentData(endpoints);
  }

  // Build LLM message context
  const sessionMessages = getSession(sessionId);

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...sessionMessages,
  ];

  // Inject agent data if available
  if (agentData && Object.keys(agentData).length > 0) {
    messages.push({
      role: "system",
      content: `[AGENT DATA]\n${JSON.stringify(agentData, null, 2)}\n[/AGENT DATA]`,
    });
  }

  messages.push({ role: "user", content: body.message });

  // LLM cascade
  let { reply, model } = await cascadeChat(messages);

  // Enforce 90-word limit (hard trim at word boundary)
  const words = reply.split(/\s+/);
  if (words.length > 90) {
    reply = words.slice(0, 90).join(" ").replace(/[,;:]$/, "") + "…";
  }

  // Store in session memory
  appendToSession(sessionId, { role: "user", content: body.message });
  appendToSession(sessionId, { role: "assistant", content: reply });

  const latencyMs = Date.now() - start;

  const response: RelayResponse = {
    reply,
    routedTo,
    agentData,
    latencyMs,
    model,
  };

  res.json(response);
});

// ── GET /api/relay/health ──────────────────────────────────────

router.get("/health", async (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    agent: "relay",
    llm: "gemini-flash",
    models: [GEMINI_MODEL, GEMINI_FALLBACK],
    activeSessions: sessions.size,
  });
});

export default router;
