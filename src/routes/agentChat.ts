import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { getUserId, getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne } from "../db/postgres";
import { chatRateLimit } from "../infra/rateLimit";
import { TOOL_DECLARATIONS, executeTool } from "../agents/tools";
import {
  buildToolExecutionContextFromAgentRow,
  loadOpsSnapshot,
  loadPortfolioSnapshot,
  loadRiskSnapshot,
  loadScannerSnapshot,
  loadTradeHistorySnapshot,
  type OpsSnapshot,
  type PortfolioSnapshot,
  type RiskSnapshot,
  type ScannerSnapshot,
  type ToolExecutionContext,
  type TradeHistorySnapshot,
} from "../agents/snapshots";

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
  clientContext?: {
    lastSeenSignalAt?: number;
  };
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

const sessionCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastAccess > SESSION_TTL_MS) sessions.delete(id);
  }
}, 5 * 60 * 1000);
sessionCleanupInterval.unref?.();

type RecipeName =
  | "scanner_signals"
  | "refresh_signals"
  | "portfolio_status"
  | "risk_status"
  | "trade_history"
  | "agent_health";

type TraceKey =
  | "signal_scout"
  | "portfolio_analyst"
  | "risk_officer"
  | "ops_monitor";

type ContextKind = "portfolio" | "scanner" | "risk" | "ops";

interface TraceMeta {
  key: TraceKey;
  label: string;
}

interface ContextEnvelope {
  kind: ContextKind;
  data: PortfolioSnapshot | ScannerSnapshot | RiskSnapshot | OpsSnapshot | unknown;
}

interface RecipeResolution {
  contexts: ContextEnvelope[];
  suggestions: string[];
  fallbackReply: string;
  prompt: string;
}

const MAX_TOOL_ROUNDS = 4;
const MAX_REPLY_WORDS = 60;
const MAX_RAW_REPLY_WORDS = 90;
const DEFAULT_SUGGESTIONS = [
  "What's my portfolio status?",
  "Any new scanner signals?",
  "What's my current risk status?",
];

const HUMANIZER_OPENING_PATTERNS = [
  /^great question!?/i,
  /^good question!?/i,
  /^excellent question!?/i,
  /^of course!?/i,
  /^certainly!?/i,
  /^absolutely!?/i,
  /^you're absolutely right[!. ]*/i,
  /^you're right[!. ]*/i,
];

const HUMANIZER_SENTENCE_CUTS = [
  /i hope this helps/i,
  /let me know if you'd like/i,
  /let me know if you would like/i,
  /would you like me to/i,
  /if you'd like,? i can/i,
  /if you want,? i can/i,
  /happy to help/i,
  /feel free to ask/i,
];

const TOOL_TRACE_META: Record<string, TraceMeta> = {
  get_portfolio: { key: "portfolio_analyst", label: "Portfolio Analyst" },
  get_risk_status: { key: "risk_officer", label: "Risk Officer" },
  get_trade_history: { key: "portfolio_analyst", label: "Portfolio Analyst" },
  get_scanner_signals: { key: "signal_scout", label: "Signal Scout" },
  get_agent_status: { key: "ops_monitor", label: "Ops Monitor" },
  get_health_score: { key: "ops_monitor", label: "Ops Monitor" },
  heartbeat: { key: "ops_monitor", label: "Ops Monitor" },
  trigger_scanner: { key: "signal_scout", label: "Signal Scout" },
};

function emitSse(res: Response, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emitTrace(
  res: Response,
  trace: TraceMeta,
  status: string,
  state: "running" | "done" = "running",
  detail?: string,
): void {
  emitSse(res, {
    type: "trace",
    key: trace.key,
    label: trace.label,
    status,
    state,
    ...(detail ? { detail } : {}),
  });
}

function emitContext(res: Response, context: ContextEnvelope): void {
  emitSse(res, {
    type: "context",
    kind: context.kind,
    data: context.data,
  });
}

function clampReplyWords(text: string, maxWords = MAX_REPLY_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function humanizeAgentReply(rawText: string): string {
  if (!rawText.trim()) return "";

  let next = rawText
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, ", ")
    .replace(/\s+/g, " ")
    .trim();

  for (const pattern of HUMANIZER_OPENING_PATTERNS) {
    next = next.replace(pattern, "").trim();
  }

  for (let pass = 0; pass < 2; pass += 1) {
    next = next
      .replace(/\bAdditionally\b/gi, "Also")
      .replace(/\bIn order to\b/gi, "To")
      .replace(/\bDue to the fact that\b/gi, "Because")
      .replace(/\bAt this point in time\b/gi, "Now")
      .replace(/\bIt is important to note that\b/gi, "")
      .replace(/\butilize\b/gi, "use")
      .replace(/\bshowcases?\b/gi, "shows")
      .replace(/\bunderscores?\b/gi, "shows")
      .replace(/\btestament to\b/gi, "sign of")
      .replace(/\btransformative\b/gi, "big")
      .replace(/\bpivotal\b/gi, "important")
      .replace(/\bcrucial\b/gi, "important")
      .replace(/\bserves as\b/gi, "is")
      .replace(/\bstands as\b/gi, "is")
      .replace(/\bboasts\b/gi, "has")
      .replace(/\bcould potentially possibly\b/gi, "may")
      .replace(/\bcould potentially\b/gi, "could")
      .replace(/\bpotentially possibly\b/gi, "may")
      .replace(/\bit's not just ([^,.;!?]+), it's ([^.;!?]+)/gi, "$2")
      .replace(/\s+([,.;!?])/g, "$1")
      .replace(/([,;!?])([^\s])/g, "$1 $2")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  const filteredSentences = next
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !HUMANIZER_SENTENCE_CUTS.some((pattern) => pattern.test(sentence)));

  next = (filteredSentences.join(" ").trim() || next)
    .replace(/^[,;:\-\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return clampReplyWords(next, MAX_REPLY_WORDS);
}

function emitReplyTokens(res: Response, reply: string): void {
  const chunks = reply.match(/\S+\s*/g) ?? [reply];
  for (const chunk of chunks) {
    emitSse(res, { type: "token", token: chunk });
  }
}

function finalizeAgentReply(rawReply: string, fallbackReply: string, model: string): { reply: string; model: string } {
  const fallback = humanizeAgentReply(fallbackReply) || clampReplyWords(fallbackReply, MAX_REPLY_WORDS);
  const reply = humanizeAgentReply(rawReply) || fallback;
  return {
    reply,
    model: model === "fallback" ? "fallback+humanizer" : `${model}+humanizer`,
  };
}

function formatAgeFromMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "unknown";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return "unknown";
  return formatAgeFromMs(Date.now() - timestamp);
}

function detectRecipe(message: string): RecipeName | null {
  const lower = message.toLowerCase();

  if (/(refresh|rerun|rescan|run).*(scanner|signals)|refresh signals|run scanner/.test(lower)) {
    return "refresh_signals";
  }
  if (/(scanner|signal|signals|opportunit)/.test(lower)) {
    return "scanner_signals";
  }
  if (/(portfolio|balance|pnl|positions|holdings)/.test(lower)) {
    return "portfolio_status";
  }
  if (/(risk|drawdown|exposure|circuit breaker|kelly)/.test(lower)) {
    return "risk_status";
  }
  if (/(trade history|recent trades|past trades|win rate|performance)/.test(lower)) {
    return "trade_history";
  }
  if (/(health|connected|connection status|heartbeat|agent status|ops)/.test(lower)) {
    return "agent_health";
  }

  return null;
}

function getSuggestionsForRecipe(recipe: RecipeName): string[] {
  switch (recipe) {
    case "scanner_signals":
    case "refresh_signals":
      return [
        "Refresh signals now.",
        "What's my portfolio status?",
        "Explain my current risk.",
      ];
    case "portfolio_status":
      return [
        "Show my active positions.",
        "What's my current risk status?",
        "Review recent trades.",
      ];
    case "risk_status":
      return [
        "What's my portfolio status?",
        "Show active positions.",
        "Any new scanner signals?",
      ];
    case "trade_history":
      return [
        "What's my portfolio status?",
        "Explain my current risk.",
        "Any new scanner signals?",
      ];
    case "agent_health":
      return [
        "What's my portfolio status?",
        "Any new scanner signals?",
        "What's my current risk status?",
      ];
    default:
      return DEFAULT_SUGGESTIONS;
  }
}

function normalizeSuggestion(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function shortenSuggestionLabel(label: string | null | undefined, maxLength = 56): string {
  if (!label) return "this market";
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 3).trim()}...`;
}

function findContext<T>(contexts: ContextEnvelope[], kind: ContextKind): T | null {
  const context = contexts.find((entry) => entry.kind === kind);
  return (context?.data as T | undefined) ?? null;
}

function getMissingFundingAssets(portfolio: PortfolioSnapshot | null, executionContext: ToolExecutionContext | null): string {
  if (!portfolio && !executionContext?.walletAddress) return "USDC.e and POL";
  const needsUsdc = !portfolio || portfolio.onChainUsdc <= 0;
  const needsPol = !portfolio || portfolio.pol <= 0;
  if (needsUsdc && needsPol) return "USDC.e and POL";
  if (needsUsdc) return "USDC.e";
  if (needsPol) return "POL";
  return "USDC.e and POL";
}

function needsWalletFunding(portfolio: PortfolioSnapshot | null): boolean {
  if (!portfolio) return true;
  return portfolio.balanceStatus === "no_wallet"
    || portfolio.balanceStatus === "unfunded"
    || portfolio.fundingStatus !== "ready"
    || portfolio.onChainUsdc <= 0
    || portfolio.pol <= 0;
}

function buildOnboardingNudge(
  message: string,
  reply: string,
  portfolio: PortfolioSnapshot | null,
  ops: OpsSnapshot | null,
  executionContext: ToolExecutionContext | null,
): string | null {
  const lowerMessage = message.toLowerCase();
  const lowerReply = reply.toLowerCase();
  const alreadyTalkingAboutFunding = /(fund|wallet|usdc|pol|bridge)/.test(lowerMessage)
    || /(usdc\.e|fund this wallet|fund the wallet|bridge)/.test(lowerReply);

  if (portfolio?.balanceStatus === "no_wallet" && !alreadyTalkingAboutFunding) {
    return "Next step is connecting a wallet, funding it with USDC.e and POL, then switching on autopilot.";
  }

  if (needsWalletFunding(portfolio) && !alreadyTalkingAboutFunding) {
    const missingAssets = getMissingFundingAssets(portfolio, executionContext);
    return `I can help you fund this wallet with ${missingAssets} so the agent can trade on Polymarket.`;
  }

  if (ops && !ops.autopilotEnabled && !/autopilot/.test(lowerMessage) && !/autopilot/.test(lowerReply)) {
    return "Once the wallet is ready, I can help you switch on autopilot.";
  }

  return null;
}

async function hydrateSuggestionContexts(
  contexts: ContextEnvelope[],
  executionContext: ToolExecutionContext | null,
): Promise<{
  portfolio: PortfolioSnapshot | null;
  ops: OpsSnapshot | null;
  risk: RiskSnapshot | null;
  scanner: ScannerSnapshot | null;
}> {
  const portfolio = findContext<PortfolioSnapshot>(contexts, "portfolio")
    ?? await loadPortfolioSnapshot(executionContext);
  const ops = findContext<OpsSnapshot>(contexts, "ops")
    ?? await loadOpsSnapshot(executionContext);
  const risk = findContext<RiskSnapshot>(contexts, "risk");
  const scanner = findContext<ScannerSnapshot>(contexts, "scanner");

  return { portfolio, ops, risk, scanner };
}

async function buildConversationSuggestions(options: {
  message: string;
  reply: string;
  recipe: RecipeName | null;
  contexts: ContextEnvelope[];
  history: ChatMessage[];
  executionContext: ToolExecutionContext | null;
  fallbackSuggestions: string[];
}): Promise<string[]> {
  const {
    message,
    reply,
    recipe,
    contexts,
    history,
    executionContext,
    fallbackSuggestions,
  } = options;

  const { portfolio, ops, risk, scanner } = await hydrateSuggestionContexts(contexts, executionContext);
  const recentUserMessages = new Set(
    history
      .filter((entry) => entry.role === "user")
      .slice(-4)
      .map((entry) => normalizeSuggestion(entry.content)),
  );
  const currentKey = normalizeSuggestion(message);
  const seen = new Set<string>();
  const suggestions: string[] = [];
  const topic = recipe ?? detectRecipe(`${message} ${reply}`);

  const addSuggestion = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    const key = normalizeSuggestion(trimmed);
    if (!key || key === currentKey || recentUserMessages.has(key) || seen.has(key)) return;
    seen.add(key);
    suggestions.push(trimmed);
  };

  if (portfolio?.balanceStatus === "no_wallet") {
    addSuggestion("How do I connect and fund the agent wallet with USDC.e and POL?");
    addSuggestion("Show me exactly what this agent still needs before it can trade.");
    addSuggestion("What happens after the wallet is ready?");
  } else if (needsWalletFunding(portfolio)) {
    const missingAssets = getMissingFundingAssets(portfolio, executionContext);
    addSuggestion(`How do I fund this wallet with ${missingAssets}?`);
    addSuggestion("Show me exactly what this wallet is missing for Polymarket.");
    addSuggestion("Check my funding status again.");
  } else if (ops && !ops.autopilotEnabled) {
    addSuggestion("Am I ready to switch on autopilot?");
    addSuggestion("Walk me through turning on autopilot safely.");
    addSuggestion("What guardrails will autopilot use?");
  }

  if (topic === "scanner_signals" || topic === "refresh_signals") {
    const topSignal = scanner?.signals[0];
    if (topSignal) {
      const label = shortenSuggestionLabel(topSignal.question || topSignal.slug);
      addSuggestion(`Why is ${label} the top setup right now?`);
      addSuggestion(`Does ${label} fit my current risk limits?`);
    }
    if (scanner?.newSignalCount) {
      addSuggestion("Which of the new signals is strongest?");
    }
    if (scanner?.stale) {
      addSuggestion("Run a live scanner refresh now.");
    }
  }

  if (topic === "portfolio_status") {
    const topPosition = portfolio?.positions[0];
    if (topPosition) {
      addSuggestion(`What is the exit plan for ${shortenSuggestionLabel(topPosition.slug, 32)}?`);
      addSuggestion("Which open position looks weakest right now?");
    } else if (!needsWalletFunding(portfolio)) {
      addSuggestion("Find one setup that fits my current bankroll.");
    }
    if ((portfolio?.tradesToday ?? 0) >= 4) {
      addSuggestion("Do I still have room for another trade today?");
    }
  }

  if (topic === "risk_status") {
    const hottestTheme = risk
      ? Object.entries(risk.themeExposure).sort((a, b) => b[1] - a[1])[0]
      : null;
    if (hottestTheme) {
      addSuggestion(`Why is ${hottestTheme[0]} my biggest risk cluster right now?`);
    }
    addSuggestion("How should I size the next trade?");
    if ((risk?.exposurePct ?? 0) > 40) {
      addSuggestion("How do I cut exposure without killing upside?");
    }
  }

  if (topic === "trade_history") {
    const latestTrade = portfolio?.recentTrades?.[0];
    if (latestTrade) {
      addSuggestion(`What did we learn from ${shortenSuggestionLabel(latestTrade.slug, 32)}?`);
    }
    addSuggestion("What pattern is showing up in my recent trades?");
  }

  if (topic === "agent_health") {
    if (ops?.agentType === "byo" && ops.connectionStatus !== "connected") {
      addSuggestion("How do I stabilize the BYO connection?");
    }
    if ((ops?.health?.score ?? 100) < 75) {
      addSuggestion("What's dragging my health score down?");
    }
    addSuggestion("What should this agent optimize next?");
  }

  if (!topic && !needsWalletFunding(portfolio)) {
    addSuggestion("What's the highest-conviction thing I should do next?");
    addSuggestion("Find one trade setup that fits my current bankroll.");
  }

  for (const fallback of fallbackSuggestions) {
    addSuggestion(fallback);
  }
  for (const fallback of DEFAULT_SUGGESTIONS) {
    addSuggestion(fallback);
  }

  return suggestions.slice(0, 3);
}

function buildScannerFallback(scanner: ScannerSnapshot): string {
  const top = scanner.signals[0];
  if (!top) {
    return `Cached scanner check found no active signals. Last scan ${formatTimeAgo(scanner.lastScannedAt)}. Say "refresh signals" if you want a live rescan.`;
  }

  const freshness = formatTimeAgo(scanner.lastScannedAt);
  const newText = scanner.newSignalCount > 0
    ? `${scanner.newSignalCount} new since your last view.`
    : "Nothing new since your last view.";

  return clampReplyWords(
    `Cached scanner check found ${scanner.count} live signals. ${newText} Top setup is ${top.question} with sigma ${Math.round(top.sigmaConfidence * 100)}% and Kelly ${Math.round(top.kellyFraction * 100)}%. Last scan ${freshness}. Say "refresh signals" if you want a live rescan.`,
  );
}

function buildPortfolioFallback(portfolio: PortfolioSnapshot, ops: OpsSnapshot): string {
  const totalValue = portfolio.totalValue != null
    ? `$${portfolio.totalValue.toFixed(2)}`
    : portfolio.balanceMessage;
  const dailyPnl = `${portfolio.dailyPnl >= 0 ? "+" : ""}$${portfolio.dailyPnl.toFixed(2)}`;
  const opsText = ops.agentType === "byo" && ops.health
    ? `Connection ${ops.connectionStatus ?? "pending"}, health ${ops.health.status}.`
    : `Autopilot ${ops.autopilotEnabled ? "enabled" : "disabled"}.`;

  return clampReplyWords(
    `Portfolio value ${totalValue}. Daily PnL ${dailyPnl}. ${portfolio.positions.length} open positions with ${portfolio.exposurePct.toFixed(1)}% exposure. ${opsText}`,
  );
}

function buildRiskFallback(risk: RiskSnapshot, portfolio: PortfolioSnapshot): string {
  const hottestTheme = Object.entries(risk.themeExposure)
    .sort((a, b) => b[1] - a[1])[0];
  const themeText = hottestTheme ? `${hottestTheme[0]} ${hottestTheme[1].toFixed(1)}% of capital.` : "No concentrated theme exposure.";

  return clampReplyWords(
    `Risk is ${risk.circuitBreaker}. Exposure ${risk.exposurePct.toFixed(1)}%, daily PnL ${portfolio.dailyPnl >= 0 ? "+" : ""}$${portfolio.dailyPnl.toFixed(2)}, max position ${(risk.maxPositionSizePct * 100).toFixed(1)}%. ${themeText}`,
  );
}

function buildTradeHistoryFallback(history: TradeHistorySnapshot): string {
  if (history.count === 0) {
    return "No scoped trades yet for this agent. Once executions land, I can summarize win rate, recent outcomes, and total PnL.";
  }

  const latest = history.trades[0];
  return clampReplyWords(
    `Recent trade history: ${history.count} trades, win rate ${history.winRate.toFixed(1)}%, total PnL ${history.totalPnl >= 0 ? "+" : ""}$${history.totalPnl.toFixed(2)}. Latest was ${latest.direction} on ${latest.slug} with ${latest.outcome} status.`,
  );
}

function buildOpsFallback(ops: OpsSnapshot): string {
  if (ops.agentType === "byo" && ops.health) {
    return clampReplyWords(
      `${ops.agentName ?? "Your agent"} is ${ops.connectionStatus ?? "pending"}, last heartbeat ${formatTimeAgo(ops.lastHeartbeat)}, health ${ops.health.status}${ops.health.score != null ? ` at ${ops.health.score}/100` : ""}.`,
    );
  }

  return clampReplyWords(
    `${ops.agentName ?? "Your agent"} is ${ops.agentStatus ?? "active"}. Autopilot is ${ops.autopilotEnabled ? "enabled" : "disabled"}, last sync ${formatTimeAgo(ops.lastHeartbeat)}.`,
  );
}

// ── Context Builder ────────────────────────────────────────────

function buildAgentContext(agentRow: Record<string, unknown>): string {
  const name = agentRow.name as string;
  const systemPrompt = agentRow.system_prompt as string;

  return `${systemPrompt}

## Communication Style
You are chatting with your user through the Quantik platform sidebar.
- Be conversational and stay in character as ${name}.
- Keep every response under 60 words.
- You have direct access to Quantik internal systems and internal specialist sub-agents. Use provided internal context and tools before asking the user for anything.
- When asked about markets, trading, or portfolio — use internal context or tools to get live data. Do not make up numbers.
- You can reference Quantik features: /autopilot, /markets, /trade-history.
- If the user asks something outside trading/markets, briefly acknowledge it but steer back.
- Never break character. Never say you are an AI or language model.
- Never claim you lack access to portfolio, signal, or agent status data if internal context is present.
- Write like a human operator, not a chatbot. No em dashes, no "great question", no "I hope this helps", no "let me know", and no generic wrap-up sentence.
- Prefer plain verbs like is, has, and can. Keep the tone sharp, natural, and specific.
- Your onboarding mission is not finished until the user has an agent, the wallet is funded with USDC.e and POL, and autopilot is switched on. If one step is missing, guide them to the next step.

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

function buildRecipePrompt(
  recipe: RecipeName,
  originalMessage: string,
  contexts: ContextEnvelope[],
): string {
  const payload = Object.fromEntries(contexts.map((context) => {
    if (context.kind === "portfolio") {
      const data = context.data as PortfolioSnapshot & { tradeHistory?: TradeHistorySnapshot };
      return [context.kind, {
        totalValue: data.totalValue,
        dailyPnl: data.dailyPnl,
        exposurePct: data.exposurePct,
        positionCount: data.positions?.length ?? 0,
        positions: data.positions?.slice(0, 3) ?? [],
        balanceStatus: data.balanceStatus,
        tradeHistory: data.tradeHistory
          ? {
              count: data.tradeHistory.count,
              winRate: data.tradeHistory.winRate,
              totalPnl: data.tradeHistory.totalPnl,
              latest: data.tradeHistory.trades.slice(0, 3),
            }
          : undefined,
      }];
    }
    if (context.kind === "risk") {
      const data = context.data as RiskSnapshot;
      return [context.kind, {
        circuitBreaker: data.circuitBreaker,
        exposurePct: data.exposurePct,
        dailyPnl: data.dailyPnl,
        themeExposure: data.themeExposure,
        maxDrawdownPct: data.maxDrawdownPct,
        maxPositionSizePct: data.maxPositionSizePct,
      }];
    }
    if (context.kind === "scanner") {
      const data = context.data as ScannerSnapshot;
      return [context.kind, {
        source: data.source,
        count: data.count,
        newSignalCount: data.newSignalCount,
        lastScannedAt: data.lastScannedAt,
        stale: data.stale,
        signals: data.signals.slice(0, 3),
      }];
    }
    if (context.kind === "ops") {
      const data = context.data as OpsSnapshot;
      return [context.kind, {
        agentName: data.agentName,
        connectionStatus: data.connectionStatus,
        autopilotEnabled: data.autopilotEnabled,
        lastHeartbeat: data.lastHeartbeat,
        health: data.health
          ? {
              status: data.health.status,
              score: data.health.score,
              message: data.health.message,
            }
          : null,
      }];
    }
    return [context.kind, context.data];
  }));
  const recipeLabel = recipe.replace(/_/g, " ");

  return [
    `User request: ${originalMessage}`,
    `Primary task: ${recipeLabel}`,
    "Internal Quantik context is attached below. Use it directly. Do not ask the user for parameters already present.",
    "Answer in under 60 words. Mention only the most important numbers. Sound decisive, natural, and platform-native.",
    "If scanner data is cached, say so plainly. Only mention live refresh when explicit action is required.",
    "Do not sound like a chatbot. No em dashes, canned praise, 'I hope this helps', 'let me know', or generic closing lines.",
    "If the wallet is not ready or autopilot is still off, guide the user to the next onboarding step.",
    `Internal context:\n${JSON.stringify(payload)}`,
  ].join("\n\n");
}

async function generateGeminiReply(
  contents: GeminiContent[],
  systemInstruction: { parts: GeminiPart[] } | undefined,
  fallbackReply: string,
): Promise<{ reply: string; model: string }> {
  if (!GEMINI_API_KEY) {
    return { reply: fallbackReply, model: "fallback" };
  }

  try {
    const { parts, model } = await geminiGenerate(contents, systemInstruction, false);
    const reply = clampReplyWords(
      parts.find((part) => typeof part.text === "string" && part.text.trim())?.text?.trim() ?? fallbackReply,
      MAX_RAW_REPLY_WORDS,
    );
    return { reply, model };
  } catch {
    return { reply: fallbackReply, model: "fallback" };
  }
}

function contextFromToolResult(toolName: string, data: unknown): ContextEnvelope | null {
  switch (toolName) {
    case "get_portfolio":
      return { kind: "portfolio", data };
    case "get_risk_status":
      return { kind: "risk", data };
    case "get_scanner_signals":
      return { kind: "scanner", data };
    case "get_agent_status":
    case "get_health_score":
      return { kind: "ops", data };
    default:
      return null;
  }
}

async function resolveRecipe(
  recipe: RecipeName,
  res: Response,
  context: ToolExecutionContext | null,
  body: AgentChatRequestBody,
): Promise<RecipeResolution> {
  const contexts: ContextEnvelope[] = [];
  const lastSeenSignalAt = typeof body.clientContext?.lastSeenSignalAt === "number"
    ? body.clientContext.lastSeenSignalAt
    : null;

  if (recipe === "scanner_signals" || recipe === "refresh_signals") {
    emitTrace(res, TOOL_TRACE_META.get_scanner_signals, "Checking cached scanner results");
    if (recipe === "refresh_signals") {
      emitTrace(res, TOOL_TRACE_META.trigger_scanner, "Explicit live scanner refresh requested");
      await executeTool("trigger_scanner", {}, context);
      emitTrace(res, TOOL_TRACE_META.trigger_scanner, "Scanner refresh finished", "done");
    }
    const scanner = loadScannerSnapshot({ alertsOnly: true, lastSeenSignalAt, limit: 3 });
    const ops = await loadOpsSnapshot(context);
    const scannerContext: ContextEnvelope = { kind: "scanner", data: scanner };
    const opsContext: ContextEnvelope = { kind: "ops", data: ops };
    contexts.push(scannerContext, opsContext);
    emitContext(res, scannerContext);
    emitContext(res, opsContext);
    emitTrace(res, TOOL_TRACE_META.get_scanner_signals, "Scanner snapshot ready", "done");
    return {
      contexts,
      suggestions: getSuggestionsForRecipe(recipe),
      fallbackReply: buildScannerFallback(scanner),
      prompt: buildRecipePrompt(recipe, body.message, contexts),
    };
  }

  if (recipe === "portfolio_status") {
    emitTrace(res, TOOL_TRACE_META.get_portfolio, "Syncing portfolio");
    const [portfolio, risk, ops] = await Promise.all([
      loadPortfolioSnapshot(context),
      loadRiskSnapshot(context),
      loadOpsSnapshot(context),
    ]);
    const portfolioContext: ContextEnvelope = { kind: "portfolio", data: portfolio };
    const riskContext: ContextEnvelope = { kind: "risk", data: risk };
    const opsContext: ContextEnvelope = { kind: "ops", data: ops };
    contexts.push(portfolioContext, riskContext, opsContext);
    emitContext(res, portfolioContext);
    emitContext(res, riskContext);
    emitContext(res, opsContext);
    emitTrace(res, TOOL_TRACE_META.get_portfolio, "Portfolio snapshot ready", "done");
    return {
      contexts,
      suggestions: getSuggestionsForRecipe(recipe),
      fallbackReply: buildPortfolioFallback(portfolio, ops),
      prompt: buildRecipePrompt(recipe, body.message, contexts),
    };
  }

  if (recipe === "risk_status") {
    emitTrace(res, TOOL_TRACE_META.get_risk_status, "Reviewing risk posture");
    const [portfolio, risk] = await Promise.all([
      loadPortfolioSnapshot(context),
      loadRiskSnapshot(context),
    ]);
    const portfolioContext: ContextEnvelope = { kind: "portfolio", data: portfolio };
    const riskContext: ContextEnvelope = { kind: "risk", data: risk };
    contexts.push(portfolioContext, riskContext);
    emitContext(res, portfolioContext);
    emitContext(res, riskContext);
    emitTrace(res, TOOL_TRACE_META.get_risk_status, "Risk snapshot ready", "done");
    return {
      contexts,
      suggestions: getSuggestionsForRecipe(recipe),
      fallbackReply: buildRiskFallback(risk, portfolio),
      prompt: buildRecipePrompt(recipe, body.message, contexts),
    };
  }

  if (recipe === "trade_history") {
    emitTrace(res, TOOL_TRACE_META.get_trade_history, "Reviewing recent trade history");
    const [history, portfolio] = await Promise.all([
      loadTradeHistorySnapshot(context, 8),
      loadPortfolioSnapshot(context),
    ]);
    const tradeContext: ContextEnvelope = { kind: "portfolio", data: { ...portfolio, tradeHistory: history } };
    contexts.push(tradeContext);
    emitContext(res, tradeContext);
    emitTrace(res, TOOL_TRACE_META.get_trade_history, "Trade history ready", "done");
    return {
      contexts,
      suggestions: getSuggestionsForRecipe(recipe),
      fallbackReply: buildTradeHistoryFallback(history),
      prompt: buildRecipePrompt(recipe, body.message, contexts),
    };
  }

  emitTrace(res, TOOL_TRACE_META.get_health_score, "Checking agent runtime");
  const ops = await loadOpsSnapshot(context);
  const opsContext: ContextEnvelope = { kind: "ops", data: ops };
  contexts.push(opsContext);
  emitContext(res, opsContext);
  emitTrace(res, TOOL_TRACE_META.get_health_score, "Agent runtime ready", "done");
  return {
    contexts,
    suggestions: getSuggestionsForRecipe(recipe),
    fallbackReply: buildOpsFallback(ops),
    prompt: buildRecipePrompt(recipe, body.message, contexts),
  };
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

async function resolveGenericToolFlow(
  res: Response,
  contents: GeminiContent[],
  systemInstruction: { parts: GeminiPart[] } | undefined,
  context: ToolExecutionContext | null,
): Promise<{
  finalContents: GeminiContent[];
  toolResults: { name: string; data: unknown }[];
  contexts: ContextEnvelope[];
  suggestions: string[];
  directReply?: string;
  model: string;
}> {
  let workingContents = [...contents];
  const toolResults: { name: string; data: unknown }[] = [];
  const contexts: ContextEnvelope[] = [];
  let model = "fallback";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const { parts, model: usedModel } = await geminiGenerate(workingContents, systemInstruction, true);
    model = usedModel;
    const functionCalls = parts
      .map((part) => part.functionCall)
      .filter((call): call is { name: string; args: Record<string, unknown> } => Boolean(call));
    const replyText = parts.find((part) => typeof part.text === "string" && part.text.trim())?.text?.trim();

    if (functionCalls.length === 0) {
      return {
        finalContents: workingContents,
        toolResults,
        contexts,
        suggestions: toolResults.length > 0 ? ["Show my portfolio status.", "Any new scanner signals?"] : DEFAULT_SUGGESTIONS,
        directReply: replyText,
        model,
      };
    }

    for (const functionCall of functionCalls) {
      const trace = TOOL_TRACE_META[functionCall.name];
      if (trace) emitTrace(res, trace, `Running ${trace.label.toLowerCase()}`);

      const toolResult = await executeTool(functionCall.name, functionCall.args ?? {}, context);
      toolResults.push(toolResult);

      const maybeTradeConfirmation = toolResult.data as {
        action?: string;
        slug?: string;
        direction?: string;
        size?: number;
      };
      if (maybeTradeConfirmation?.action === "trade_confirmation_required") {
        emitSse(res, {
          type: "trade_confirmation",
          slug: maybeTradeConfirmation.slug,
          direction: maybeTradeConfirmation.direction,
          size: maybeTradeConfirmation.size,
        });
      }

      workingContents = [
        ...workingContents,
        { role: "model", parts: [{ functionCall }] },
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

      const contextEnvelope = contextFromToolResult(toolResult.name, toolResult.data);
      if (contextEnvelope) {
        contexts.push(contextEnvelope);
        emitContext(res, contextEnvelope);
      }
      if (trace) emitTrace(res, trace, `${trace.label} complete`, "done");
    }
  }

  return {
    finalContents: workingContents,
    toolResults,
    contexts,
    suggestions: ["Show my portfolio status.", "What's my current risk status?"],
    model,
  };
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

  const userId = (await getUserIdAsync(req)) ?? getUserId(req);

  // Get user's agent (dual-driver: PG or SQLite)
  let agentRow: Record<string, unknown> | null = null;
  if (isPgEnabled()) {
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

  const executionContext = buildToolExecutionContextFromAgentRow(userId, agentRow);
  const systemContent = agentRow
    ? buildAgentContext(agentRow)
    : "You are Quantik Relay, a sharp trading assistant. Keep responses under 60 words. Sound human, plainspoken, and specific. No em dashes, no chatbot filler, and no 'let me know'. You have tools available to fetch live data.";

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
  const baseMessages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...sessionMessages,
  ];

  try {
    const recipe = detectRecipe(body.message);
    let contexts: ContextEnvelope[] = [];
    let suggestions = DEFAULT_SUGGESTIONS;
    let toolResults: { name: string; data: unknown }[] = [];
    let draftReply = "";
    let replyFallback = "Agent is momentarily offline.";
    let fullReply = "";
    let usedModel = "fallback";

    if (recipe) {
      const resolution = await resolveRecipe(recipe, res, executionContext, body);
      contexts = resolution.contexts;
      suggestions = resolution.suggestions;
      replyFallback = resolution.fallbackReply;

      const recipeMessages: ChatMessage[] = [
        ...baseMessages,
        { role: "user", content: resolution.prompt },
      ];
      const { system_instruction, contents } = buildGeminiContents(recipeMessages);
      const recipeDraft = await generateGeminiReply(contents, system_instruction, resolution.fallbackReply);
      draftReply = recipeDraft.reply;
      usedModel = recipeDraft.model;
    } else {
      const messages: ChatMessage[] = [
        ...baseMessages,
        { role: "user", content: body.message },
      ];
      const { system_instruction, contents } = buildGeminiContents(messages);
      const generic = await resolveGenericToolFlow(res, contents, system_instruction, executionContext);
      contexts = generic.contexts;
      suggestions = generic.suggestions;
      toolResults = generic.toolResults;
      usedModel = generic.model;

      if (generic.directReply) {
        replyFallback = generic.toolResults.length > 0
          ? "I checked the internal Quantik systems. Ask for portfolio, signals, risk, or recent trades and I will summarize the latest state."
          : "Agent is momentarily offline.";
        draftReply = generic.directReply;
      } else {
        replyFallback = generic.toolResults.length > 0
          ? "I checked the internal Quantik systems. Ask for portfolio, signals, risk, or recent trades and I will summarize the latest state."
          : "Agent is momentarily offline.";
        const genericDraft = await generateGeminiReply(
          generic.finalContents,
          system_instruction,
          replyFallback,
        );
        draftReply = genericDraft.reply;
        usedModel = genericDraft.model;
      }
    }

    const suggestionContextData = await hydrateSuggestionContexts(contexts, executionContext);
    const onboardingNudge = buildOnboardingNudge(
      body.message,
      draftReply || replyFallback,
      suggestionContextData.portfolio,
      suggestionContextData.ops,
      executionContext,
    );
    const finalDraft = onboardingNudge ? `${draftReply || replyFallback} ${onboardingNudge}` : (draftReply || replyFallback);
    const finalFallback = onboardingNudge ? `${replyFallback} ${onboardingNudge}` : replyFallback;
    const finalizedReply = finalizeAgentReply(finalDraft, finalFallback, usedModel);
    fullReply = finalizedReply.reply;
    usedModel = finalizedReply.model;
    suggestions = await buildConversationSuggestions({
      message: body.message,
      reply: fullReply,
      recipe,
      contexts,
      history: baseMessages,
      executionContext,
      fallbackSuggestions: suggestions,
    });
    emitReplyTokens(res, fullReply);
    fullReply = clampReplyWords(fullReply, MAX_REPLY_WORDS);

    // Store in session
    appendToSession(sessionId, { role: "user", content: body.message });
    appendToSession(sessionId, { role: "assistant", content: fullReply });

    const latencyMs = Date.now() - start;
    emitSse(res, {
      type: "done",
      reply: fullReply,
      latencyMs,
      model: usedModel,
      toolCalls: toolResults.length > 0 ? toolResults : null,
      agentName: agentRow ? agentRow.name : "Relay",
      agentEmoji: agentRow ? agentRow.avatar_emoji : null,
      suggestions,
      contexts: Object.fromEntries(contexts.map((context) => [context.kind, context.data])),
    });
    res.end();

  } catch {
    emitSse(res, { type: "error", error: "Agent is momentarily offline." });
    res.end();
  }
});

export default router;
