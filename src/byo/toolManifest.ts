import { TOOL_DECLARATIONS } from "../agents/tools";

export type ByoScope = "read" | "trade" | "analysis" | "config";
export type ByoMethod = "GET" | "POST";
export type ByoRateLimitBucket = "read" | "trade" | "analysis" | "config" | "heartbeat" | "chat";

export interface PublicToolManifestEntry {
  name: string;
  description: string;
  method: ByoMethod;
  path: string;
  scope: ByoScope;
  parameters: {
    type: string;
    properties?: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
  rateLimitBucket: ByoRateLimitBucket;
  streaming?: boolean;
  responseFormat?: string;
  deprecated?: boolean;
  successorPath?: string;
}

const TOOL_ROUTE_META: Record<
  string,
  { method: ByoMethod; scope: ByoScope; rateLimitBucket: ByoRateLimitBucket }
> = {
  get_portfolio: { method: "GET", scope: "read", rateLimitBucket: "read" },
  get_risk_status: { method: "GET", scope: "read", rateLimitBucket: "read" },
  get_trade_history: { method: "GET", scope: "read", rateLimitBucket: "read" },
  get_arena_leaderboard: { method: "GET", scope: "read", rateLimitBucket: "read" },
  search_markets: { method: "GET", scope: "read", rateLimitBucket: "read" },
  run_analysis: { method: "POST", scope: "analysis", rateLimitBucket: "analysis" },
  place_trade: { method: "POST", scope: "trade", rateLimitBucket: "trade" },
  get_scanner_signals: { method: "GET", scope: "read", rateLimitBucket: "read" },
  get_pipeline_history: { method: "GET", scope: "read", rateLimitBucket: "read" },
  get_agent_status: { method: "GET", scope: "read", rateLimitBucket: "read" },
  heartbeat: { method: "POST", scope: "read", rateLimitBucket: "heartbeat" },
  close_position: { method: "POST", scope: "trade", rateLimitBucket: "trade" },
  get_market_price: { method: "GET", scope: "read", rateLimitBucket: "read" },
  get_risk_config: { method: "GET", scope: "read", rateLimitBucket: "read" },
  update_risk_config: { method: "POST", scope: "config", rateLimitBucket: "config" },
  trigger_scanner: { method: "POST", scope: "analysis", rateLimitBucket: "analysis" },
  get_pipeline_output: { method: "GET", scope: "read", rateLimitBucket: "read" },
  update_webhook_config: { method: "POST", scope: "config", rateLimitBucket: "config" },
  get_health_score: { method: "GET", scope: "read", rateLimitBucket: "read" },
  get_polymarket_status: { method: "GET", scope: "read", rateLimitBucket: "read" },
  run_polymarket_approvals: { method: "POST", scope: "config", rateLimitBucket: "config" },
};

export const BYO_RATE_LIMITS = {
  read: { max: 120, window_ms: 60_000 },
  analysis: { max: 5, window_ms: 60_000 },
  trade: { max: 10, window_ms: 60_000 },
  config: { max: 10, window_ms: 60_000 },
  heartbeat: { max: 60, window_ms: 60_000 },
  chat: { max: 30, window_ms: 60_000 },
} as const;

export const BYO_SCOPES: ByoScope[] = ["read", "trade", "analysis", "config"];

export const BYO_ERROR_CODES = [
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "SCOPE_DENIED",
  "CIRCUIT_BREAKER",
  "AGENT_PAUSED",
  "AGENT_TERMINATED",
  "INVALID_PARAMS",
  "INTERNAL_ERROR",
  "TIMEOUT",
] as const;

export const BYO_CHAT_MANIFEST: PublicToolManifestEntry = {
  name: "agent_chat",
  description:
    "SSE streaming conversational relay grounded in live portfolio, scanner, risk, pipeline, and agent-health data.",
  method: "POST",
  path: "/api/v1/agent/chat",
  scope: "read",
  rateLimitBucket: "chat",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Natural language request or command." },
      session_id: { type: "string", description: "Optional session UUID for 30-minute memory continuity." },
      sessionId: { type: "string", description: "Legacy alias for session_id. Still accepted for backward compatibility." },
      locale: { type: "string", description: "Optional locale hint (en, es, fr, de)." },
    },
    required: ["message"],
  },
  streaming: true,
  responseFormat: "text/event-stream",
};

export const LEGACY_RELAY_MANIFEST: PublicToolManifestEntry = {
  name: "relay_stream_legacy",
  description:
    "Deprecated legacy relay endpoint retained for backward compatibility. Prefer /api/v1/agent/chat for all new integrations.",
  method: "POST",
  path: "/api/relay/stream",
  scope: "read",
  rateLimitBucket: "chat",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Natural language request or command." },
    },
    required: ["message"],
  },
  streaming: true,
  responseFormat: "text/event-stream",
  deprecated: true,
  successorPath: "/api/v1/agent/chat",
};

export function getPublicToolManifest(): PublicToolManifestEntry[] {
  const tools = TOOL_DECLARATIONS.flatMap((tool) => {
    const meta = TOOL_ROUTE_META[tool.name];
    if (!meta) return [];
    return [{
      name: tool.name,
      description: tool.description,
      method: meta.method,
      path: `/api/v1/tools/${tool.name}`,
      scope: meta.scope,
      parameters: tool.parameters,
      rateLimitBucket: meta.rateLimitBucket,
    } satisfies PublicToolManifestEntry];
  });

  return [
    ...tools,
    {
      name: "usage",
      description:
        "Get 24-hour totals, per-tool breakdown, 7-day usage history, and recent errors for the calling agent.",
      method: "GET",
      path: "/api/v1/tools/usage",
      scope: "read",
      rateLimitBucket: "read",
      parameters: { type: "object", properties: {}, required: [] },
    },
    BYO_CHAT_MANIFEST,
    LEGACY_RELAY_MANIFEST,
  ];
}
