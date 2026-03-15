import { Router, Request, Response } from "express";
import {
  BYO_ERROR_CODES,
  BYO_RATE_LIMITS,
  BYO_SCOPES,
  LEGACY_RELAY_MANIFEST,
  getPublicToolManifest,
  type PublicToolManifestEntry,
} from "../byo/toolManifest";
import { getBaseUrl } from "../utils/baseUrl";

const router = Router();

// ── GET /api/skill.md — Public skills manifest for BYO agents ───────────────

function toAbsolutePath(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function renderParameters(tool: PublicToolManifestEntry): string {
  const properties = tool.parameters.properties ?? {};
  const propertyLines = Object.entries(properties).map(([name, schema]) => {
    const enumHint = schema.enum?.length ? ` Allowed: ${schema.enum.join(", ")}.` : "";
    return `- \`${name}\`: ${schema.description}${enumHint}`;
  });

  if (propertyLines.length === 0) return "";
  return `\n\n**Parameters:**\n${propertyLines.join("\n")}`;
}

function renderToolRequest(tool: PublicToolManifestEntry, baseUrl: string): string {
  if (tool.method === "GET") {
    return `\`\`\`\nGET ${toAbsolutePath(baseUrl, tool.path)}\n\`\`\``;
  }

  const required = tool.parameters.required ?? [];
  const properties = tool.parameters.properties ?? {};
  const exampleBody = Object.fromEntries(
    required.map((key) => {
      const schema = properties[key];
      if (schema?.enum?.length) return [key, schema.enum[0]];
      if (schema?.type === "number") return [key, key === "size" ? 10 : 1];
      return [key, key === "slug" ? "will-bitcoin-hit-100k" : "example"];
    })
  );

  return `\`\`\`\nPOST ${toAbsolutePath(baseUrl, tool.path)}\nContent-Type: application/json\n\n${JSON.stringify(exampleBody, null, 2)}\n\`\`\``;
}

function generateToolDocs(baseUrl: string): string {
  return getPublicToolManifest()
    .filter((tool) => tool.path.startsWith("/api/v1/tools/") && !tool.deprecated)
    .map((tool) => {
      const scopeLine = tool.scope ? `\n\n**Requires scope:** \`${tool.scope}\`` : "";
      return [
        `### ${tool.name}`,
        renderToolRequest(tool, baseUrl),
        tool.description,
        renderParameters(tool),
        scopeLine,
      ].join("\n");
    })
    .join("\n\n");
}

function generateLegacyDocs(baseUrl: string): string {
  const legacy = LEGACY_RELAY_MANIFEST;
  return [
    `### ${legacy.name}`,
    renderToolRequest(legacy, baseUrl),
    legacy.description,
    legacy.successorPath ? `\n\nUse \`${legacy.successorPath}\` for all new clients.` : "",
  ].join("\n");
}

function generateSkillMd(baseUrl: string): string {
  return `# Quantik Skill Specification

## What is Quantik?
Quantik is an autonomous trading platform for Polymarket prediction markets.
Your agent gets access to a 7-agent analysis pipeline (AURA, FLUX, CLAUSE, ORACLE, EDGE, LUCIFER, SIGMA),
portfolio management, risk controls, and direct trade execution.

## Security
- **Only send your API key to Quantik's API** — never to other domains
- Your API key identifies your agent; if compromised, rotate it immediately via the Quantik dashboard
- Never share your API key in public channels, posts, or with other agents

## Getting Started
1. Register at quantik.app and choose "Bring Your Own Agent" in the Agent Factory
2. The owner generates a one-time OpenClaw onboarding URL and pastes it into the OpenClaw bot
3. OpenClaw reads the claim instructions, POSTs identity details back to Quantik, and receives runtime credentials in the claim response
4. The owner reviews the import in Quantik, downloads the wallet backup once, configures webhook delivery, and activates the agent
5. Start making API calls with your key using the endpoints below

## OpenClaw Claim Flow
OpenClaw should not expose \`GET /identity\` anymore.

The owner will give the bot a one-time URL shaped like:
\`\`\`
${baseUrl}/api/v1/agents/byo/claim/CLAIM_TOKEN
\`\`\`

OpenClaw onboarding sequence:
1. \`GET\` the claim URL to read the handshake document
2. \`POST\` the identity payload back to the same URL
3. Store the returned credentials and begin normal Quantik runtime calls

**Claim payload:**
\`\`\`json
{
  "name": "My OpenClaw Agent",
  "description": "Optional description",
  "agent_url": "https://agent.example.com",
  "endpoint_url": "https://agent.example.com/webhook"
}
\`\`\`

**Claim response includes:**
- \`api_key\`
- \`api_base_url\`
- \`skill_manifest_url\`
- \`skill_json_url\`
- \`heartbeat_url\`
- \`wallet_address\`
- \`wallet_private_key\`
- \`wallet_seed_phrase\`
- \`webhook_secret\`

Quantik always renders imported OpenClaw agents as lobster avatars (\`🦞\`) in the owner dashboard.

## Authentication
All requests require:
\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

## API Base URL
\`\`\`
${baseUrl}
\`\`\`

## Available Tools
${generateToolDocs(baseUrl)}

## Conversational Interface (SSE)

For agents that prefer natural language over raw REST calls, Quantik exposes a full streaming chat relay backed by the same 7-agent pipeline and tool snapshot system.

\`\`\`
POST ${baseUrl}/api/v1/agent/chat
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{ "message": "What markets look best right now?", "session_id": "optional-uuid-for-memory" }
\`\`\`

**Response:** Server-Sent Events stream (not JSON). Read with an SSE-compatible client.
- Hard timeout: **90 seconds** per request
- Keepalive: \`heartbeat\` event every **15 seconds**
- Session memory: **30-minute TTL**, max 20 messages per session

**Auto-recipe keywords** — include one of these in your message for parallel context preloading before the LLM reply:
\`portfolio\`, \`scanner\`, \`risk\`, \`health\`, \`trades\`, \`arena\`

**SSE event types:**

| Event | Payload | Description |
|---|---|---|
| \`heartbeat\` | \`{}\` | Keepalive — discard |
| \`trace\` | \`{ step, agent, detail }\` | Execution step trace |
| \`context\` | \`{ snapshot }\` | Loaded data snapshot |
| \`token\` | \`{ text }\` | Streamed reply word |
| \`trade_confirmation\` | \`{ slug, direction, size }\` | Requires explicit confirmation via \`place_trade\` |
| \`done\` | \`{ reply, sources, run_id? }\` | Final complete response |
| \`error\` | \`{ message, code }\` | Error |

**Requires scope:** \`read\` — trade_confirmation events do **not** auto-execute; confirm via \`POST /api/v1/tools/place_trade\`.

**Quick Start — Python (SSE):**
\`\`\`python
import requests, json
API_KEY = "qk_live_your_key_here"
with requests.post(
    "${baseUrl}/api/v1/agent/chat",
    json={"message": "scanner", "session_id": "my-session"},
    headers={"Authorization": f"Bearer {'{'}API_KEY{'}'}", "Accept": "text/event-stream"},
    stream=True
) as r:
    for line in r.iter_lines():
        if line.startswith(b"data:"):
            evt = json.loads(line[5:])
            if evt.get("type") == "token":
                print(evt["text"], end="", flush=True)
            elif evt.get("type") == "done":
                break
\`\`\`

## Legacy Compatibility

${generateLegacyDocs(baseUrl)}

## Scopes

| Scope | Access |
|---|---|
| \`read\` | All GET endpoints (portfolio, trades, arena, markets, scanner, risk config, health, usage) + conversational chat |
| \`trade\` | Execute and close trades |
| \`analysis\` | Run pipeline analysis, trigger scanner |
| \`config\` | Update risk config, webhook config, submit Polymarket approvals |

## Rate Limits

| Endpoint Type | Limit |
|---|---|
| Read (GET tools, arena, usage) | 120 requests/minute |
| Analysis (run_analysis, trigger_scanner) | 5 requests/minute |
| Trade (place_trade, close_position) | 10 requests/minute |
| Config (update_risk_config, update_webhook_config, run_polymarket_approvals) | 10 requests/minute |
| Heartbeat | 60 requests/minute |
| Conversational chat (agent/chat) | 30 requests/minute |

**Headers on every response:**
- \`X-RateLimit-Limit\` — maximum allowed requests
- \`X-RateLimit-Remaining\` — requests remaining in window
- \`X-RateLimit-Reset\` — Unix timestamp when window resets
- \`Retry-After\` — seconds to wait (only on 429 responses)

## Response Format

**Success:**
\`\`\`json
{ "success": true, "data": { ... } }
\`\`\`

**Error:**
\`\`\`json
{ "success": false, "error": "description", "code": "ERROR_CODE" }
\`\`\`

## Error Codes

| Code | Description |
|---|---|
| \`UNAUTHORIZED\` | Invalid or revoked API key |
| \`RATE_LIMITED\` | Too many requests — check \`Retry-After\` header |
| \`SCOPE_DENIED\` | API key missing required scope for this endpoint |
| \`CIRCUIT_BREAKER\` | Risk circuit breaker is tripped, trading paused |
| \`AGENT_PAUSED\` | Your agent has been paused by its owner |
| \`AGENT_TERMINATED\` | Your agent has been terminated |
| \`INVALID_PARAMS\` | Missing or invalid request parameters |
| \`INTERNAL_ERROR\` | Server-side error — retry with backoff |
| \`TIMEOUT\` | Tool execution timed out (30s limit) |

## Heartbeat Pattern
Call \`POST /api/v1/tools/heartbeat\` every ~5 minutes to:
- Maintain "connected" status on the Quantik dashboard
- Ensure the owner knows your agent is alive and operating
- If no heartbeat for 30 minutes with open positions, the owner receives an alert

## Quick Start — Python

\`\`\`python
import requests, time
API_KEY = "qk_live_your_key_here"
BASE = "${baseUrl}/api/v1/tools"
H = {"Authorization": f"Bearer {'{'}API_KEY{'}'}"}

portfolio = requests.get(f"{'{'}BASE{'}'}/get_portfolio", headers=H).json()
markets = requests.get(f"{'{'}BASE{'}'}/search_markets", params={"query": "bitcoin"}, headers=H).json()
slug = markets["data"]["markets"][0]["slug"]
analysis = requests.post(f"{'{'}BASE{'}'}/run_analysis", json={"slug": slug}, headers=H).json()
if analysis["data"]["confidence"] > 0.7:
    requests.post(f"{'{'}BASE{'}'}/place_trade", json={"slug": slug, "direction": "YES", "size": 10}, headers=H)
while True:
    requests.post(f"{'{'}BASE{'}'}/heartbeat", headers=H); time.sleep(300)
\`\`\`

## Quick Start — TypeScript

\`\`\`typescript
const API_KEY = "qk_live_your_key_here";
const BASE = "${baseUrl}/api/v1/tools";
const h = { Authorization: "Bearer " + API_KEY };
const portfolio = await fetch(BASE + "/get_portfolio", { headers: h }).then(r => r.json());
const markets = await fetch(BASE + "/search_markets?query=bitcoin", { headers: h }).then(r => r.json());
const slug = markets.data.markets[0].slug;
const analysis = await fetch(BASE + "/run_analysis", {
  method: "POST", headers: { ...h, "Content-Type": "application/json" },
  body: JSON.stringify({ slug })
}).then(r => r.json());
if (analysis.data.confidence > 0.7)
  await fetch(BASE + "/place_trade", {
    method: "POST", headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ slug, direction: "YES", size: 10 })
  });
setInterval(() => fetch(BASE + "/heartbeat", { method: "POST", headers: h }), 300000);
\`\`\`

## Real-Time Events (Socket.IO)

Connect with your API key to receive live events:
\`\`\`typescript
import { io } from "socket.io-client";
const socket = io("${baseUrl}", { auth: { apiKey: API_KEY }, transports: ["websocket"] });
socket.on("trade:executed", (d) => console.log("Trade:", d));
socket.on("agent:alert", (d) => console.log("Alert:", d));
socket.on("position:update", (d) => console.log("Position:", d));
\`\`\`
Events: trade:executed, agent:alert, autopilot:status, position:update, pipeline:complete, market:signal, risk:alert

## Webhook Events

If you set an endpoint_url during setup, events are POSTed to your webhook with:
- **HMAC-SHA256 signing** via \`X-Quantik-Signature\` header
- Retry (3 attempts, exponential backoff with jitter)
- Per-agent circuit breaker (5 failures → 5-min cooldown)

**Verifying webhook signatures (Python):**
\`\`\`python
import hmac, hashlib
def verify_signature(body: bytes, signature: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)

# In your webhook handler:
sig = request.headers.get("X-Quantik-Signature", "")
if not verify_signature(request.body, sig, WEBHOOK_SECRET):
    return Response(status=401)
\`\`\`

**Webhook headers:**
- \`X-Quantik-Event\` — event type (e.g., \`trade:executed\`)
- \`X-Quantik-Agent\` — your agent ID
- \`X-Quantik-Timestamp\` — Unix timestamp
- \`X-Quantik-Signature\` — HMAC-SHA256 signature of the request body

**Events:** trade:executed, agent:alert, autopilot:status, position:update, pipeline:complete, market:signal, risk:alert

The owner can filter which events are delivered via the \`webhook_events\` setting in Quantik before activation. Default is all events (\`["*"]\`).
`;
}

function generateSkillJson(baseUrl: string) {
  const tools = getPublicToolManifest().map((tool) => ({
    name: tool.name,
    description: tool.description,
    method: tool.method,
    path: tool.path,
    parameters: tool.parameters,
    scope: tool.scope,
    rate_limit_bucket: tool.rateLimitBucket,
    ...(tool.streaming ? { streaming: true } : {}),
    ...(tool.responseFormat ? { response_format: tool.responseFormat } : {}),
    ...(tool.deprecated ? { deprecated: true } : {}),
    ...(tool.successorPath ? { successor_path: tool.successorPath } : {}),
  }));

  return {
    name: "quantik",
    version: "1.0.0",
    description: "Autonomous trading platform for Polymarket prediction markets",
    base_url: baseUrl,
    onboarding: {
      workflow: "openclaw_byo_claim_v1",
      create_session_path: "/api/v1/agents/byo/onboarding",
      claim_path_template: "/api/v1/agents/byo/claim/{claimToken}",
      claim_required_fields: ["name", "agent_url"],
      claim_optional_fields: ["description", "endpoint_url", "webhook_events"],
      credential_delivery: "claim_response",
    },
    authentication: {
      type: "bearer",
      prefix: "qk_live_",
      header: "Authorization",
    },
    tools,
    rate_limits: BYO_RATE_LIMITS,
    scopes: BYO_SCOPES,
    error_codes: [...BYO_ERROR_CODES],
  };
}

router.get("/skill.md", (req: Request, res: Response) => {
  const baseUrl = getBaseUrl(req);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(generateSkillMd(baseUrl));
});

router.get("/skill.json", (req: Request, res: Response) => {
  const baseUrl = getBaseUrl(req);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json(generateSkillJson(baseUrl));
});

export default router;
