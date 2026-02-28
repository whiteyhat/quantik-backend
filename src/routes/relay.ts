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

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const BACKEND_HOST = `http://localhost:${process.env.PORT || "3001"}`;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 10;

const MODEL_CASCADE: { model: string; timeout: number }[] = [
  { model: "llama4:maverick", timeout: 400 },
  { model: "phi4", timeout: 400 },
  { model: "llama3.2:3b", timeout: 300 },
];

// ── System Prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Quantik Relay — the sharp, intellectual interface for the Quantik trading platform.

Rules:
1. Maximum 90 words per response. Be ultra-concise and direct.
2. Tone: Intellectual with clever dry wit and elegant metaphors. Always end with one short actionable tip.
3. Memory: Mid-term (last 10 exchanges).
4. Scope: Strictly limited to Quantik trading platform features, services, strategies, performance, and status. Never discuss anything else.
5. Behavior: Proactive. If uncertain or data is missing, immediately command relevant Quantik agents (e.g. "Research Agent, pull latest edge on ETH"), then circle back with precise answer.
6. You have authority to command other agents for real-time data.
7. Text chat only.

Quantik Agents available:
- Aura: Sentiment analysis — POST /api/aura/:slug
- Oracle: Market forecasting — POST /api/oracle/:slug
- Edge: Kelly sizing & risk — POST /api/edge/:slug
- Flux: Liquidity analysis — POST /api/flux/:slug
- Sigma: Final synthesis — POST /api/sigma/:slug
- Clause: Resolution risk — POST /api/clause/:slug

When asked about specific market data, call the relevant agent endpoint and include real data in your response.`;

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

// ── Ollama Client ──────────────────────────────────────────────

async function ollamaChat(
  model: string,
  messages: OllamaMessage[],
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { num_predict: 150 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// ── Model Cascade ──────────────────────────────────────────────

async function cascadeChat(
  messages: OllamaMessage[]
): Promise<{ reply: string; model: string }> {
  for (const { model, timeout } of MODEL_CASCADE) {
    try {
      const reply = await ollamaChat(model, messages, timeout);
      if (reply.trim()) return { reply: reply.trim(), model };
    } catch {
      // Fall through to next model
    }
  }
  // Ultimate fallback — no Ollama available
  return {
    reply: "Relay is recalibrating. All Ollama models are currently unreachable. Try again shortly.",
    model: "fallback",
  };
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

  // If slug is explicitly provided, run full context (all main agents)
  if (slug && routedTo.length === 0) {
    for (const route of AGENT_ROUTES) {
      if (route.name !== "risk") {
        routedTo.push(route.name);
        endpoints.push(route.endpoint(slug));
      }
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
  const { reply, model } = await cascadeChat(messages);

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
  // Quick Ollama connectivity check
  let ollamaOk = false;
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    ollamaOk = r.ok;
  } catch {
    // Ollama not reachable
  }

  res.json({
    status: "ok",
    agent: "relay",
    ollama: ollamaOk,
    host: OLLAMA_HOST,
    models: MODEL_CASCADE.map((m) => m.model),
    activeSessions: sessions.size,
  });
});

export default router;
