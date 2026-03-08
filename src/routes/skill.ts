import { Router, Request, Response } from "express";
import { TOOL_DECLARATIONS } from "../agents/tools";
import { getBaseUrl } from "../utils/baseUrl";

const router = Router();

// ── GET /api/skill.md — Public skills manifest for BYO agents ───────────────

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

### get_portfolio
\`\`\`
GET ${baseUrl}/api/v1/tools/get_portfolio
\`\`\`
Returns your current portfolio: balance, active positions, total P&L, and exposure percentage.

**Example Response:**
\`\`\`json
{
  "success": true,
  "data": {
    "totalCapital": 1000.00,
    "deployedCapital": 250.00,
    "availableCapital": 750.00,
    "exposurePct": 25.00,
    "dailyPnl": 12.50,
    "positionCount": 2,
    "positions": [
      { "slug": "will-btc-hit-100k", "direction": "YES", "size": 150, "entryPrice": 0.45, "currentPrice": 0.52, "pnl": 23.33 }
    ]
  }
}
\`\`\`

### get_risk_status
\`\`\`
GET ${baseUrl}/api/v1/tools/get_risk_status
\`\`\`
Returns circuit breaker state, drawdown percentage, daily P&L, and risk configuration.

### get_trade_history
\`\`\`
GET ${baseUrl}/api/v1/tools/get_trade_history?limit=10
\`\`\`
Returns recent trades with outcomes (WIN/LOSS/OPEN), P&L, and overall win rate.
- \`limit\`: Number of trades to return (default 10, max 50)

### search_markets
\`\`\`
GET ${baseUrl}/api/v1/tools/search_markets?query=bitcoin&category=crypto
\`\`\`
Search for available prediction markets on Polymarket.
- \`query\`: Search term (optional)
- \`category\`: Filter by category — \`crypto\`, \`politics\`, \`sports\`, \`pop-culture\`, \`science\`, \`world\`, \`business\` (optional)

### run_analysis
\`\`\`
POST ${baseUrl}/api/v1/tools/run_analysis
Content-Type: application/json

{ "slug": "will-bitcoin-hit-100k" }
\`\`\`
Triggers a full 7-agent pipeline analysis on a specific market.
Returns decision (BUY/SELL/HOLD), confidence percentage, and run ID.

**Requires scope:** \`analysis\`

### place_trade
\`\`\`
POST ${baseUrl}/api/v1/tools/place_trade
Content-Type: application/json

{ "slug": "will-bitcoin-hit-100k", "direction": "YES", "size": 10 }
\`\`\`
Execute a trade on a prediction market. **Fully autonomous — no confirmation needed.**
- \`slug\`: Market slug
- \`direction\`: \`"YES"\` or \`"NO"\`
- \`size\`: Trade size in USDC

**Requires scope:** \`trade\`

### get_scanner_signals
\`\`\`
GET ${baseUrl}/api/v1/tools/get_scanner_signals?alerts_only=true
\`\`\`
Get recent high-confidence market opportunities detected by the automated scanner.
- \`alerts_only\`: Set to \`"true"\` for only high-confidence alerts (sigma >= 0.70, kelly >= 0.40)

### get_pipeline_history
\`\`\`
GET ${baseUrl}/api/v1/tools/get_pipeline_history?limit=5
\`\`\`
Get recent pipeline run history with decisions and confidence scores.
- \`limit\`: Number of runs to return (default 5, max 20)

### get_agent_status
\`\`\`
GET ${baseUrl}/api/v1/tools/get_agent_status
\`\`\`
Get your agent's current status, wallet address, configuration, and connection info.

### heartbeat
\`\`\`
POST ${baseUrl}/api/v1/tools/heartbeat
\`\`\`
Send a heartbeat to maintain "connected" status. **Call every ~5 minutes.**
If no heartbeat for 30 minutes with open positions, the owner gets alerted.

### close_position
\`\`\`
POST ${baseUrl}/api/v1/tools/close_position
Content-Type: application/json

{ "slug": "will-bitcoin-hit-100k" }
\`\`\`
Close an open position. Computes P&L from current market price and marks the position as closed.

**Requires scope:** \`trade\`

### get_market_price
\`\`\`
GET ${baseUrl}/api/v1/tools/get_market_price?slug=will-bitcoin-hit-100k
\`\`\`
Get current market price for a specific market. Returns YES/NO prices, volume, and liquidity from Polymarket.

### get_risk_config
\`\`\`
GET ${baseUrl}/api/v1/tools/get_risk_config
\`\`\`
Get current risk configuration: drawdown limit, max position size, kelly multiplier, and agent VaR thresholds.

### update_risk_config
\`\`\`
POST ${baseUrl}/api/v1/tools/update_risk_config
Content-Type: application/json

{ "max_position_size": 0.10, "drawdown_limit": 0.15, "kelly_multiplier": 0.25 }
\`\`\`
Update risk parameters. All fields are optional — only provided fields are updated.
Values must be between 0.01 and 1.0.

**Requires scope:** \`config\`

### trigger_scanner
\`\`\`
POST ${baseUrl}/api/v1/tools/trigger_scanner
\`\`\`
Trigger the orchestrator market scanner to find new trading opportunities.
Returns number of markets scanned and candidates found.

**Requires scope:** \`analysis\`

### get_pipeline_output
\`\`\`
GET ${baseUrl}/api/v1/tools/get_pipeline_output?run_id=UUID
\`\`\`
Get the full output from all 7 agents in a specific pipeline run.
Returns detailed analysis from AURA, FLUX, CLAUSE, ORACLE, EDGE, LUCIFER, and SIGMA.

### update_webhook_config
\`\`\`
POST ${baseUrl}/api/v1/tools/update_webhook_config
Content-Type: application/json

{ "endpoint_url": "https://your-server.com/webhook", "webhook_events": ["trade:executed", "agent:alert"] }
\`\`\`
Update your webhook endpoint URL and/or event subscriptions.
Use \`["*"]\` for all events. URL must be HTTPS.

**Requires scope:** \`config\`

### get_health_score
\`\`\`
GET ${baseUrl}/api/v1/tools/get_health_score
\`\`\`
Get your agent's health score (0-100) with grade (A-F) and component breakdown:
uptime (40%), error rate (30%), latency (20%), connection status (10%).

## Scopes

| Scope | Access |
|---|---|
| \`read\` | All GET endpoints (portfolio, trades, markets, scanner, risk config, health) |
| \`trade\` | Execute and close trades |
| \`analysis\` | Run pipeline analysis, trigger scanner |
| \`config\` | Update risk config, webhook config |

## Rate Limits

| Endpoint Type | Limit |
|---|---|
| Read (GET tools) | 120 requests/minute |
| Analysis (run_analysis, trigger_scanner) | 5 requests/minute |
| Trade (place_trade, close_position) | 10 requests/minute |
| Config (update_risk_config, update_webhook_config) | 10 requests/minute |
| Heartbeat | 60 requests/minute |

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
    tools: TOOL_DECLARATIONS.map(t => ({
      name: t.name,
      description: t.description,
      method: ["run_analysis", "place_trade", "heartbeat", "close_position", "update_risk_config", "trigger_scanner", "update_webhook_config"].includes(t.name) ? "POST" : "GET",
      path: `/api/v1/tools/${t.name}`,
      parameters: t.parameters,
      scope: ["place_trade", "close_position"].includes(t.name) ? "trade" :
             ["run_analysis", "trigger_scanner"].includes(t.name) ? "analysis" :
             ["update_risk_config", "update_webhook_config"].includes(t.name) ? "config" : "read",
    })),
    rate_limits: {
      read: { max: 120, window_ms: 60000 },
      analysis: { max: 5, window_ms: 60000 },
      trade: { max: 10, window_ms: 60000 },
      config: { max: 10, window_ms: 60000 },
    },
    scopes: ["read", "trade", "analysis", "config"],
    error_codes: [
      "UNAUTHORIZED", "RATE_LIMITED", "SCOPE_DENIED",
      "CIRCUIT_BREAKER", "AGENT_PAUSED", "AGENT_TERMINATED",
      "INVALID_PARAMS", "INTERNAL_ERROR", "TIMEOUT",
    ],
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
