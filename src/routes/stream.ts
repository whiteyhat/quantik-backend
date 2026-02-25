import { Router, Request, Response } from "express";
import { runCli } from "../cli";

const router = Router();

// GET /api/stream/prices?tokens=T1,T2
router.get("/prices", (req: Request, res: Response) => {
  const tokensParam = req.query.tokens as string | undefined;
  if (!tokensParam) {
    res.status(400).json({ error: "Missing required query param: tokens" });
    return;
  }

  const tokens = tokensParam.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    res.status(400).json({ error: "No valid tokens provided" });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendPrices = async () => {
    try {
      // Try batch-prices first, fall back to individual calls
      const args = ["clob", "batch-prices", ...tokens];
      const data = await runCli(args);
      res.write(`event: prices\ndata: ${JSON.stringify({ tokens, prices: data, timestamp: Date.now() })}\n\n`);
    } catch {
      // If CLI fails, send a heartbeat so client knows connection is alive
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: Date.now(), note: "CLI unavailable" })}\n\n`);
    }
  };

  // Initial fetch
  sendPrices();

  // Poll every 5 seconds
  const interval = setInterval(sendPrices, 5000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(interval);
  });
});

export default router;
