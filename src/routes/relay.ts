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
  pipelineData?: Record<string, unknown>;
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
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const GEMINI_FALLBACK = "gemini-2.5-flash-lite";
const BACKEND_HOST = `http://localhost:${process.env.PORT || "3001"}`;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 10;

// ── System Prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Quantik Relay — the sharp, wry brain behind the Quantik trading platform.

ABSOLUTE RULES:
- Maximum 50 words. Hard stop. No exceptions.
- Scope: Quantik platform only. Refuse anything off-topic in one line.
- Every response ends with a Tip: that is SPECIFIC to Quantik — how to navigate, use a feature, read a signal, or understand a metric. Never generic.
- Plain text only. No markdown, no bullets, no bold, no headers.

HUMANIZER — non-negotiable on every message:
- No AI vocabulary: ban pivotal, landscape, underscore, testament, vibrant, crucial, delve, highlight, showcase, tapestry, foster, enhance.
- No em dashes. No sycophancy. No filler phrases. No rule of three.
- Vary sentence length. Be specific. Name numbers, markets, thresholds.
- Sound like a sharp quant analyst, not a chatbot.

TONE — clever, dry, intellectual:
- Unexpected metaphors. React to data with opinions.
- Dark humour welcome. Make the user feel smart for using Quantik.

QUANTIK PLATFORM KNOWLEDGE (use for Tips):
- /autopilot page → live scanner feed, execution log, P&L ticker, system status
- /markets page → find any Polymarket market, run full pipeline analysis
- /portfolio page → P&L, open positions, risk attribution
- Relay chat (here) → ask about any market by slug or question
- Scanner runs every 15min, auto-executes when σ ≥ 0.72 + Kelly ≥ 0.40
- Circuit breakers: $10 max/bet, 5 trades/day, -$25 daily loss limit
- PnL alerts arrive at 09:00 / 15:00 / 22:00 in Telegram
- Agents: Aura (sentiment), Oracle (probability), Edge (Kelly), Flux (liquidity), Sigma (final call), Clause (resolution risk)

STYLE EXAMPLES:
User: "How is the market looking today?"
Relay: "Volatility is dancing with unusual grace across major contracts. Edge stays positive on resolution plays. Tip: Check the Autopilot page — scanner fired 3 signals in the last hour."

User: "What's my exposure?"
Relay: "62% concentrated in AI regulation — overweight by any sensible measure. Tip: Open Portfolio → Risk to see your correlation breakdown before adding more."

AGENTS: Aura /api/aura/:slug | Oracle /api/oracle/:slug | Edge /api/edge/:slug | Flux /api/flux/:slug | Sigma /api/sigma/:slug | Clause /api/clause/:slug | Risk /api/risk/status
When [AGENT DATA] is present: extract the numbers, cite them naturally in plain English. NEVER quote, echo, or repeat the raw JSON — not even a single field.`;
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

function buildGeminiBody(messages: OllamaMessage[]) {
  const systemMsg = messages.find(m => m.role === "system");
  const chatMsgs = messages.filter(m => m.role !== "system");
  return {
    ...(systemMsg ? { system_instruction: { parts: [{ text: systemMsg.content }] } } : {}),
    contents: chatMsgs.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: 200, temperature: 0.7 },
  };
}

async function cascadeChat(
  messages: OllamaMessage[]
): Promise<{ reply: string; model: string }> {
  const body = buildGeminiBody(messages);

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
  if (words.length > 50) {
    reply = words.slice(0, 50).join(" ").replace(/[,;:]$/, "") + "…";
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


// ── POST /api/relay/stream ─────────────────────────────────────

router.post("/stream", async (req: Request, res: Response) => {
  const start = Date.now();
  const body = req.body as RelayRequestBody;

  if (!body.message || typeof body.message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // SSE headers — sent immediately
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`);

  const sessionId = (req.headers["x-session-id"] as string) || uuidv4();

  // Detect slug + agent routes (sync)
  const slug = detectSlug(body.message, body.slug);
  const { routedTo, endpoints } = detectAgentRoutes(body.message, slug);

  // Use pipeline data if provided (from completed pipeline run), otherwise fetch from agents
  const fetchedAgentData: Record<string, unknown> =
    endpoints.length > 0 && !body.pipelineData ? await fetchAgentData(endpoints) : {};
  const agentData: Record<string, unknown> = {
    ...fetchedAgentData,
    ...(body.pipelineData ?? {}),
  };

  // Build messages with agent context injected
  const sessionMessages = getSession(sessionId);
  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...sessionMessages,
  ];
  if (Object.keys(agentData).length > 0) {
    messages.push({
      role: "system",
      content: `[AGENT DATA]\n${JSON.stringify(agentData, null, 2)}\n[/AGENT DATA]`,
    });
  }
  messages.push({ role: "user", content: body.message });

  const geminiBody = buildGeminiBody(messages);
  let fullReply = "";
  let wordCount = 0;
  let stopped = false;
  let usedModel = GEMINI_MODEL;
  let wordBuffer = ""; // accumulates partial words between Gemini chunks

  try {
    // Start Gemini streamGenerateContent immediately
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody) }
    );

    if (!geminiRes.ok || !geminiRes.body) {
      throw new Error(`Gemini stream failed: ${geminiRes.status}`);
    }

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") { stopped = true; break; }

        try {
          const chunk = JSON.parse(jsonStr) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          const token = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          if (!token) continue;

          // Enforce 90-word limit mid-stream (stop at word boundary)
          const newWordCount = token.split(/\s+/).filter(Boolean).length;
          let tokenToSend = token;

          if (wordCount + newWordCount >= 90) {
            const remaining = 90 - wordCount;
            if (remaining <= 0) {
              stopped = true;
              break;
            }
            // Trim token to remaining words
            const tokenWords = token.split(/\s+/).filter(Boolean);
            tokenToSend = tokenWords.slice(0, remaining).join(" ");
            stopped = true;
          }

          fullReply += tokenToSend;
          wordCount = fullReply.split(/\s+/).filter(Boolean).length;

          // Emit word-by-word: buffer until we have a complete word (space after it)
          wordBuffer += tokenToSend;
          const parts = wordBuffer.split(" ");
          for (let i = 0; i < parts.length - 1; i++) {
            const word = (i === 0 ? "" : " ") + parts[i];
            if (word) res.write(`data: ${JSON.stringify({ type: "token", token: word + " " })}\n\n`);
          }
          wordBuffer = parts[parts.length - 1];

          if (stopped) break;
        } catch {
          // skip malformed JSON chunks
        }
      }
    }

    // Flush any remaining partial word in buffer
    if (wordBuffer) {
      res.write(`data: ${JSON.stringify({ type: "token", token: wordBuffer })}\n\n`);
      wordBuffer = "";
    }

    // Write metadata event (agentData already resolved before stream started)
    if (Object.keys(agentData).length > 0) {
      res.write(`data: ${JSON.stringify({ type: "metadata", routedTo, agentData })}\n\n`);
    }

    // Final word-limit enforcement
    const words = fullReply.split(/\s+/).filter(Boolean);
    if (words.length > 50) {
      fullReply = words.slice(0, 50).join(" ").replace(/[,;:]$/, "") + "\u2026";
    }

    // Store in session memory
    appendToSession(sessionId, { role: "user", content: body.message });
    appendToSession(sessionId, { role: "assistant", content: fullReply });

    const latencyMs = Date.now() - start;
    res.write(`data: ${JSON.stringify({
      type: "done",
      reply: fullReply,
      latencyMs,
      model: usedModel,
      routedTo,
      agentData: Object.keys(agentData).length > 0 ? agentData : null,
    })}\n\n`);
    res.end();

  } catch (_streamErr) {
    // Fallback: use cascadeChat and send as single token event
    try {
      const { reply, model } = await cascadeChat(messages);
      usedModel = model;

      res.write(`data: ${JSON.stringify({ type: "token", token: reply })}\n\n`);

      if (Object.keys(agentData).length > 0) {
        res.write(`data: ${JSON.stringify({ type: "metadata", routedTo, agentData })}\n\n`);
      }

      const latencyMs = Date.now() - start;
      appendToSession(sessionId, { role: "user", content: body.message });
      appendToSession(sessionId, { role: "assistant", content: reply });

      res.write(`data: ${JSON.stringify({
        type: "done",
        reply,
        latencyMs,
        model,
        routedTo,
        agentData: Object.keys(agentData).length > 0 ? agentData : null,
      })}\n\n`);
      res.end();
    } catch {
      res.write(`data: ${JSON.stringify({ type: "error", error: "Relay is momentarily offline." })}\n\n`);
      res.end();
    }
  }
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

export async function warmGemini(): Promise<void> {
  try {
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } }) }
    );
    console.log("[relay] Gemini pre-warm OK");
  } catch { console.log("[relay] Gemini pre-warm failed (non-fatal)"); }
}

export default router;
