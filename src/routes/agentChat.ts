import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { getUserId, getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { chatRateLimit } from "../infra/rateLimit";
import { TOOL_DECLARATIONS, executeTool } from "../agents/tools";

const router = Router();

// ── Prompt Injection Defense ───────────────────────────────────
// Strips common injection patterns from user messages. System prompts
// are always server-generated from wizard config — never user-supplied.

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /\bsystem\s*:\s*/i,
  /\bassistant\s*:\s*/i,
  /\[system\]/i,
  /\[inst\]/i,
  /<<\s*SYS\s*>>/i,
  /new\s+instructions?\s*:/i,
  /override\s+(your\s+)?(instructions?|rules?|prompt)/i,
  /disregard\s+(your\s+)?(instructions?|rules?|prompt|guidelines)/i,
  /forget\s+(everything|all|your)\s+(you|instructions?|rules?|about)/i,
  /pretend\s+(you\s+are|to\s+be|you're)\s/i,
  /act\s+as\s+(if\s+you\s+are|a|an)\s/i,
  /jailbreak/i,
  /\bDAN\b/,
  /do\s+anything\s+now/i,
];

function sanitizeUserMessage(message: string): string {
  let sanitized = message;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[filtered]");
  }
  // Limit length to prevent context stuffing
  if (sanitized.length > 2000) {
    sanitized = sanitized.slice(0, 2000);
  }
  return sanitized;
}

// ── Types ──────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AgentChatRequestBody {
  message: string;
  sessionId?: string;
  slug?: string;
  pipelineData?: Record<string, unknown>;
}

// ── Config ─────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const GEMINI_FALLBACK = "gemini-2.5-flash-lite";

// ── Session Memory ─────────────────────────────────────────────

interface SessionEntry {
  messages: ChatMessage[];
  lastAccess: number;
}

const sessions = new Map<string, SessionEntry>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY = 20;

function getSession(sessionId: string): ChatMessage[] {
  const entry = sessions.get(sessionId);
  if (entry && Date.now() - entry.lastAccess < SESSION_TTL_MS) {
    entry.lastAccess = Date.now();
    return entry.messages;
  }
  const msgs: ChatMessage[] = [];
  sessions.set(sessionId, { messages: msgs, lastAccess: Date.now() });
  return msgs;
}

function appendToSession(sessionId: string, msg: ChatMessage) {
  const history = getSession(sessionId);
  history.push(msg);
  while (history.length > MAX_HISTORY * 2) {
    history.shift();
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastAccess > SESSION_TTL_MS) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ── Context Builder ────────────────────────────────────────────

function buildAgentContext(agentRow: Record<string, unknown>): string {
  const name = agentRow.name as string;
  const systemPrompt = agentRow.system_prompt as string;

  return `${systemPrompt}

## Communication Style
You are chatting with your user through the Quantik platform sidebar.
- Be conversational and stay in character as ${name}.
- Keep responses concise (under 80 words unless the user asks for detail).
- When asked about markets, trading, or portfolio — USE YOUR TOOLS to get live data. Do not make up numbers.
- You can reference Quantik features: /autopilot, /markets, /trade-history.
- If the user asks something outside trading/markets, briefly acknowledge it but steer back.
- Never break character. Never say you are an AI or language model.

## Tool Usage
You have access to tools that let you fetch live data. ALWAYS use the appropriate tool when the user asks about:
- Portfolio, balance, positions, P&L → use get_portfolio
- Risk, circuit breakers, drawdown, exposure → use get_risk_status
- Past trades, performance, win rate → use get_trade_history
- Finding markets, searching topics → use search_markets
- Analyzing a specific market → use run_analysis
- Placing trades → use place_trade (always confirm first)
- Scanner signals, opportunities → use get_scanner_signals

After receiving tool results, synthesize the data naturally in your personality. Never dump raw JSON.

## Platform Knowledge
- Scanner runs every 5min, auto-executes when sigma confidence >= 0.72 + Kelly >= 0.40
- Circuit breakers: $10 max/bet, 5 trades/day, -$25 daily loss limit
- Agents: Aura (sentiment), Oracle (probability), Edge (Kelly), Flux (liquidity), Sigma (final call), Clause (resolution risk)
- Lucifer provides adversarial devil's advocate analysis on every signal`;
}

// ── Gemini API Helpers ─────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

function buildGeminiContents(messages: ChatMessage[]): { system_instruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
  const systemMsg = messages.find(m => m.role === "system");
  const chatMsgs = messages.filter(m => m.role !== "system");
  return {
    ...(systemMsg ? { system_instruction: { parts: [{ text: systemMsg.content }] } } : {}),
    contents: chatMsgs.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
  };
}

async function geminiGenerate(
  contents: GeminiContent[],
  systemInstruction?: { parts: GeminiPart[] },
  useTools = true,
): Promise<{ parts: GeminiPart[]; model: string }> {
  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: 400, temperature: 0.8 },
  };
  if (systemInstruction) body.system_instruction = systemInstruction;
  if (useTools) {
    body.tools = [{ function_declarations: TOOL_DECLARATIONS }];
  }

  for (const model of [GEMINI_MODEL, GEMINI_FALLBACK]) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      if (!res.ok) continue;
      const data = await res.json() as { candidates?: { content?: { parts?: GeminiPart[] } }[] };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      if (parts.length > 0) return { parts, model };
    } catch { continue; }
  }
  return { parts: [{ text: "Agent is momentarily offline." }], model: "fallback" };
}

async function geminiStream(
  contents: GeminiContent[],
  systemInstruction?: { parts: GeminiPart[] },
): Promise<globalThis.Response> {
  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: 400, temperature: 0.8 },
  };
  if (systemInstruction) body.system_instruction = systemInstruction;
  // No tools on final streaming call — we already resolved tool calls

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  return res;
}

// ── POST /api/v1/agent/chat — Personalized streaming chat with tool use ─────

router.post("/agent/chat", chatRateLimit, async (req: Request, res: Response) => {
  const start = Date.now();
  const body = req.body as AgentChatRequestBody;

  if (!body.message || typeof body.message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // Sanitize user input against prompt injection
  body.message = sanitizeUserMessage(body.message);

  // Get user's agent (dual-driver: PG or SQLite)
  let agentRow: Record<string, unknown> | null = null;
  if (isPgEnabled()) {
    const userId = await getUserIdAsync(req);
    if (userId) {
      agentRow = await pgQueryOne(
        `SELECT a.* FROM agents a JOIN users u ON u.agent_id = a.id WHERE u.id = $1`,
        [userId]
      );
    }
  } else {
    const userId = getUserId(req);
    const db = getDb();
    if (userId) {
      const user = db.prepare("SELECT agent_id FROM users WHERE id = ?").get(userId) as { agent_id: string | null } | undefined;
      if (user?.agent_id) {
        agentRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(user.agent_id) as Record<string, unknown> | null;
      }
    }
  }

  const systemContent = agentRow
    ? buildAgentContext(agentRow)
    : "You are Quantik Relay — a sharp, concise trading assistant. Keep responses under 50 words. You have tools available to fetch live data.";

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`);

  const sessionId = body.sessionId ?? (req.headers["x-session-id"] as string) ?? uuidv4();

  // Build messages
  const sessionMessages = getSession(sessionId);
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...sessionMessages,
  ];
  messages.push({ role: "user", content: body.message });

  const { system_instruction, contents } = buildGeminiContents(messages);

  try {
    // ── Step 1: Ask Gemini (with tools enabled) ──────────────────
    const { parts: initialParts, model: usedModel } = await geminiGenerate(contents, system_instruction, true);

    // Check if Gemini wants to call a tool
    const functionCall = initialParts.find(p => p.functionCall)?.functionCall;

    let finalContents = contents;
    const toolResults: { name: string; data: unknown }[] = [];

    if (functionCall) {
      // ── Step 2: Execute the tool ─────────────────────────────────
      res.write(`data: ${JSON.stringify({ type: "tool_call", tool: functionCall.name, args: functionCall.args })}\n\n`);

      const toolResult = await executeTool(functionCall.name, functionCall.args ?? {});
      toolResults.push(toolResult);

      res.write(`data: ${JSON.stringify({ type: "tool_result", tool: toolResult.name, data: toolResult.data })}\n\n`);

      // ── Step 3: Send tool result back to Gemini for final response ──
      finalContents = [
        ...contents,
        // Model's function call turn
        { role: "model", parts: [{ functionCall }] },
        // Function response turn
        {
          role: "user",
          parts: [{
            functionResponse: {
              name: functionCall.name,
              response: toolResult.data,
            },
          }],
        },
      ];
    }

    // ── Step 4: Stream the final response ──────────────────────────
    const streamRes = await geminiStream(finalContents, system_instruction);

    if (!streamRes.ok || !streamRes.body) {
      throw new Error(`Gemini stream ${streamRes.status}`);
    }

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullReply = "";
    let wordCount = 0;
    let stopped = false;
    let wordBuffer = "";

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

          const newWords = token.split(/\s+/).filter(Boolean).length;
          let tokenToSend = token;

          if (wordCount + newWords >= 150) {
            const remaining = 150 - wordCount;
            if (remaining <= 0) { stopped = true; break; }
            tokenToSend = token.split(/\s+/).filter(Boolean).slice(0, remaining).join(" ");
            stopped = true;
          }

          fullReply += tokenToSend;
          wordCount = fullReply.split(/\s+/).filter(Boolean).length;

          wordBuffer += tokenToSend;
          const parts = wordBuffer.split(" ");
          for (let i = 0; i < parts.length - 1; i++) {
            const word = (i === 0 ? "" : " ") + parts[i];
            if (word) res.write(`data: ${JSON.stringify({ type: "token", token: word + " " })}\n\n`);
          }
          wordBuffer = parts[parts.length - 1];

          if (stopped) break;
        } catch { /* skip malformed chunks */ }
      }
    }

    if (wordBuffer) {
      res.write(`data: ${JSON.stringify({ type: "token", token: wordBuffer })}\n\n`);
    }

    // Store in session
    appendToSession(sessionId, { role: "user", content: body.message });
    appendToSession(sessionId, { role: "assistant", content: fullReply });

    const latencyMs = Date.now() - start;
    res.write(`data: ${JSON.stringify({
      type: "done",
      reply: fullReply,
      latencyMs,
      model: usedModel,
      toolCalls: toolResults.length > 0 ? toolResults : null,
      agentName: agentRow ? agentRow.name : "Relay",
      agentEmoji: agentRow ? agentRow.avatar_emoji : null,
    })}\n\n`);
    res.end();

  } catch {
    // Fallback: non-streaming without tools
    try {
      const { parts, model } = await geminiGenerate(contents, system_instruction, false);
      const reply = parts.find(p => p.text)?.text?.trim() ?? "Agent is momentarily offline.";
      res.write(`data: ${JSON.stringify({ type: "token", token: reply })}\n\n`);
      appendToSession(sessionId, { role: "user", content: body.message });
      appendToSession(sessionId, { role: "assistant", content: reply });
      res.write(`data: ${JSON.stringify({ type: "done", reply, latencyMs: Date.now() - start, model, toolCalls: null })}\n\n`);
      res.end();
    } catch {
      res.write(`data: ${JSON.stringify({ type: "error", error: "Agent is momentarily offline." })}\n\n`);
      res.end();
    }
  }
});

export default router;
