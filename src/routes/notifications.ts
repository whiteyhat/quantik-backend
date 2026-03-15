import { Router, Request, Response } from "express";
import { getUserIdAsync } from "../middleware/auth";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/notificationInbox";

const router = Router();

async function getRequiredUserId(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdAsync(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return userId;
}

router.get("/notifications", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 200));
  const notifications = await listNotifications(userId, limit);
  res.json({
    notifications,
    unread: notifications.filter((notification) => !notification.readAt).length,
  });
});

router.post("/notifications/:id/read", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id) {
    res.status(400).json({ error: "Notification id is required" });
    return;
  }

  const ok = await markNotificationRead(userId, id);
  if (!ok) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  res.json({ ok: true, id });
});

router.post("/notifications/read-all", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  const count = await markAllNotificationsRead(userId);
  res.json({ ok: true, updated: count });
});

export default router;
