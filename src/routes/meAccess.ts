import { Router, Request, Response } from "express";
import { getUserIdAsync } from "../middleware/auth";
import { isAdminRequest } from "../middleware/guards";
import { loadLinkedAgentForUser } from "../utils/linkedAgent";

const router = Router();

// Who is looking: lets the frontend choose between the demo and the real app
// and hide operator-only controls. Safe for guests: everything is false.
router.get("/me/access", async (req: Request, res: Response) => {
  const userId = await getUserIdAsync(req);
  const linkedAgent = userId ? await loadLinkedAgentForUser(userId) : null;
  res.json({
    signedIn: !!userId,
    hasAgent: !!linkedAgent,
    isOperator: !!userId && isAdminRequest(req),
  });
});

export default router;
