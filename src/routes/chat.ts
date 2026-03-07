import { Router, Request, Response } from "express";

const router = Router();

// ── Types ──────────────────────────────────────────────────────

interface HistoryEntry {
  role: string;
  content: string;
}

interface ChatRequestBody {
  message: string;
  history?: HistoryEntry[];
}

type AgentId = "relay" | "stack" | "oracle" | "edge";

interface ChatResponse {
  reply: string;
  agent: "relay";
  routedTo?: AgentId;
  timestamp: number;
}

// ── Routing logic ──────────────────────────────────────────────

function routeMessage(message: string): { routedTo: AgentId; reply: string } {
  const lower = message.toLowerCase();

  if (lower.includes("portfolio") || lower.includes("balance")) {
    return {
      routedTo: "stack",
      reply:
        "Routing to Stack 🔩 — the performance endpoint (/api/performance/summary) returns your current P&L today and all-time, trade count, win rate, and open positions. Want me to pull live numbers?",
    };
  }

  if (lower.includes("market") || lower.includes("price")) {
    return {
      routedTo: "oracle",
      reply:
        "Routing to Oracle 🔮 — Oracle handles market analysis and probability estimates. It ingests order-book data, news sentiment, and resolution criteria to produce calibrated YES/NO probabilities and expected-value grades for each market. You can query /api/markets for the current list of tracked markets with their latest prices and volumes.",
    };
  }

  if (lower.includes("risk") || lower.includes("kelly")) {
    return {
      routedTo: "edge",
      reply:
        "Routing to Edge ⚡ — Edge owns Kelly criterion sizing and risk management. It applies fractional Kelly (default 0.25×) against Oracle's edge estimates, enforces per-position size caps (5% max), monitors theme-cluster exposure (20% cap), and triggers the circuit breaker if drawdown hits 15%. Check /api/v1/risk/kelly-sizing for the current sizing model.",
    };
  }

  return {
    routedTo: "relay",
    reply:
      "Hey, I'm Relay — the routing layer for the Quantik agent stack. I can connect you to Stack (portfolio & balance), Oracle (market prices & analysis), or Edge (risk & Kelly sizing). What would you like to explore?",
  };
}

// ── POST /api/v1/chat ──────────────────────────────────────────

router.post("/chat", (req: Request, res: Response) => {
  const body = req.body as ChatRequestBody;

  if (!body.message || typeof body.message !== "string") {
    res.status(400).json({ error: "message is required and must be a string" });
    return;
  }

  const { routedTo, reply } = routeMessage(body.message);

  const response: ChatResponse = {
    reply,
    agent: "relay",
    routedTo,
    timestamp: Date.now(),
  };

  res.json(response);
});

// ── GET /api/v1/chat/health ────────────────────────────────────

router.get("/chat/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", agent: "relay" });
});

export default router;
