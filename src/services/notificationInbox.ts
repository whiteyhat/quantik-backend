import { getDb } from "../db/schema";
import { isPgEnabled, pgExec, pgQuery } from "../db/postgres";

export interface InboxNotification {
  id: string;
  userId: string | null;
  level: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  category?: string | null;
  timestamp: number;
  readAt?: number | null;
  action?: {
    label: string;
    href: string;
  } | null;
}

interface NotificationRow {
  id: string;
  user_id: string | null;
  level: InboxNotification["level"];
  title: string;
  message: string;
  category: string | null;
  timestamp: number;
  read_at: number | null;
  action_label: string | null;
  action_href: string | null;
}

function toNotification(row: NotificationRow): InboxNotification {
  return {
    id: row.id,
    userId: row.user_id,
    level: row.level,
    title: row.title,
    message: row.message,
    category: row.category,
    timestamp: row.timestamp,
    readAt: row.read_at,
    action:
      row.action_label && row.action_href
        ? { label: row.action_label, href: row.action_href }
        : null,
  };
}

export async function persistNotification(notification: InboxNotification): Promise<void> {
  const now = Date.now();
  const params = [
    notification.id,
    notification.userId,
    notification.level,
    notification.title,
    notification.message,
    notification.category ?? null,
    notification.timestamp,
    notification.readAt ?? null,
    notification.action?.label ?? null,
    notification.action?.href ?? null,
    now,
  ];

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO notifications (
         id, user_id, level, title, message, category, timestamp, read_at, action_label, action_href, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      params
    );
  } else {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO notifications (
         id, user_id, level, title, message, category, timestamp, read_at, action_label, action_href, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...params);
  }
}

export async function listNotifications(userId: string, limit = 100): Promise<InboxNotification[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));

  if (isPgEnabled()) {
    const rows = await pgQuery<NotificationRow>(
      `SELECT id, user_id, level, title, message, category, timestamp, read_at, action_label, action_href
         FROM notifications
        WHERE user_id = $1 OR user_id IS NULL
        ORDER BY timestamp DESC
        LIMIT $2`,
      [userId, safeLimit]
    );
    return rows.map(toNotification);
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, user_id, level, title, message, category, timestamp, read_at, action_label, action_href
       FROM notifications
      WHERE user_id = ? OR user_id IS NULL
      ORDER BY timestamp DESC
      LIMIT ?`
  ).all(userId, safeLimit) as NotificationRow[];
  return rows.map(toNotification);
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<boolean> {
  const now = Date.now();

  if (isPgEnabled()) {
    const count = await pgExec(
      `UPDATE notifications
          SET read_at = COALESCE(read_at, $1)
        WHERE id = $2
          AND (user_id = $3 OR user_id IS NULL)`,
      [now, notificationId, userId]
    );
    return count > 0;
  }

  const db = getDb();
  const result = db.prepare(
    `UPDATE notifications
        SET read_at = COALESCE(read_at, ?)
      WHERE id = ?
        AND (user_id = ? OR user_id IS NULL)`
  ).run(now, notificationId, userId);
  return result.changes > 0;
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const now = Date.now();

  if (isPgEnabled()) {
    return pgExec(
      `UPDATE notifications
          SET read_at = COALESCE(read_at, $1)
        WHERE read_at IS NULL
          AND (user_id = $2 OR user_id IS NULL)`,
      [now, userId]
    );
  }

  const db = getDb();
  const result = db.prepare(
    `UPDATE notifications
        SET read_at = COALESCE(read_at, ?)
      WHERE read_at IS NULL
        AND (user_id = ? OR user_id IS NULL)`
  ).run(now, userId);
  return result.changes;
}
