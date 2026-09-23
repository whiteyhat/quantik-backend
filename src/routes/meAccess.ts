import { Router, Request, Response } from "express";
import { getUserIdAsync } from "../middleware/auth";
import { isAdminRequest } from "../middleware/guards";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";

const router = Router();

// Who is looking: lets the frontend choose between the demo and the real app
// and hide operator-only controls. Safe for guests: everything is false.
router.get("/me/access", async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdAsync(req);
    const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
    res.json({
      signedIn: !!userId,
      hasAgent: !!linkedAgent,
      isOperator: !!userId && isAdminRequest(req),
    });
  } catch (err) {
    // Never guess: the frontend retries and falls back on its own
    console.error("[me/access] lookup failed:", err instanceof Error ? err.message : err);
    res.status(503).json({ error: "Access check unavailable" });
  }
});

export default router;
