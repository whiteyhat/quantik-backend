import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { isPgEnabled, pgExec, pgQuery } from "../db/postgres";
import { getUserIdAsync } from "../middleware/auth";
import { newMarketAlertId } from "../services/marketAlerts";

const router = Router();

interface WatchlistRow {
  id: string;
  user_id: string;
  slug: string;
  question: string | null;
  created_at: number;
}

interface MarketAlertRow {
  id: string;
  user_id: string;
  slug: string;
  question: string | null;
  direction: "above" | "below";
  threshold: number;
  enabled: number | boolean;
  last_state: string | null;
  last_triggered_at: number | null;
  created_at: number;
  updated_at: number;
}

async function getRequiredUserId(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdAsync(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return userId;
}

router.get("/watchlist", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  if (isPgEnabled()) {
    const rows = await pgQuery<WatchlistRow>(
      `SELECT id, user_id, slug, question, created_at
         FROM watchlists
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ items: rows });
    return;
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, user_id, slug, question, created_at
       FROM watchlists
      WHERE user_id = ?
      ORDER BY created_at DESC`
  ).all(userId) as WatchlistRow[];
  res.json({ items: rows });
});

router.post("/watchlist", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  const body = req.body as { slug?: unknown; question?: unknown };
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!slug) {
    res.status(400).json({ error: "slug is required" });
    return;
  }

  const question = typeof body.question === "string" && body.question.trim() ? body.question.trim() : null;
  const now = Date.now();
  const id = uuidv4();

  const db = getDb();
  db.prepare(
    `INSERT INTO watchlists (id, user_id, slug, question, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, slug) DO UPDATE SET question = excluded.question`
  ).run(id, userId, slug, question, now);

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO watchlists (id, user_id, slug, question, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, slug) DO UPDATE SET question = EXCLUDED.question`,
      [id, userId, slug, question, now]
    );
  }

  res.status(201).json({ ok: true, id, slug, question });
});

router.delete("/watchlist/:slug", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  if (!slug) {
    res.status(400).json({ error: "slug is required" });
    return;
  }

  const db = getDb();
  const sqliteResult = db.prepare(
    `DELETE FROM watchlists WHERE user_id = ? AND slug = ?`
  ).run(userId, slug.toLowerCase());

  if (isPgEnabled()) {
    await pgExec(`DELETE FROM watchlists WHERE user_id = $1 AND slug = $2`, [userId, slug.toLowerCase()]);
  }

  res.json({ ok: true, deleted: sqliteResult.changes });
});

router.get("/market-alerts", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  if (isPgEnabled()) {
    const rows = await pgQuery<MarketAlertRow>(
      `SELECT id, user_id, slug, question, direction, threshold, enabled, last_state, last_triggered_at, created_at, updated_at
         FROM market_alerts
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ items: rows.map((row) => ({ ...row, enabled: row.enabled === true || row.enabled === 1 })) });
    return;
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, user_id, slug, question, direction, threshold, enabled, last_state, last_triggered_at, created_at, updated_at
       FROM market_alerts
      WHERE user_id = ?
      ORDER BY created_at DESC`
  ).all(userId) as MarketAlertRow[];
  res.json({ items: rows.map((row) => ({ ...row, enabled: row.enabled === true || row.enabled === 1 })) });
});

router.post("/market-alerts", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  const body = req.body as { slug?: unknown; question?: unknown; direction?: unknown; threshold?: unknown };
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const direction = body.direction === "below" ? "below" : body.direction === "above" ? "above" : null;
  const threshold = Number(body.threshold);
  if (!slug || !direction || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    res.status(400).json({ error: "slug, direction ('above'|'below'), and threshold (0-1) are required" });
    return;
  }

  const question = typeof body.question === "string" && body.question.trim() ? body.question.trim() : null;
  const now = Date.now();
  const id = newMarketAlertId();

  const db = getDb();
  db.prepare(
    `INSERT INTO market_alerts (
       id, user_id, slug, question, direction, threshold, enabled, last_state, last_triggered_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`
  ).run(id, userId, slug, question, direction, threshold, now, now);

  if (isPgEnabled()) {
    await pgExec(
      `INSERT INTO market_alerts (
         id, user_id, slug, question, direction, threshold, enabled, last_state, last_triggered_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, NULL, NULL, $7, $8)`,
      [id, userId, slug, question, direction, threshold, now, now]
    );
  }

  res.status(201).json({ ok: true, id, slug, question, direction, threshold, enabled: true });
});

router.patch("/market-alerts/:id", async (req: Request, res: Response) => {
  const userId = await getRequiredUserId(req, res);
  if (!userId) return;

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  const body = req.body as {
    question?: unknown;
    direction?: unknown;
    threshold?: unknown;
    enabled?: unknown;
  };

  const fields: string[] = [];
  const sqliteValues: unknown[] = [];
  const pgValues: unknown[] = [];

  if (typeof body.question === "string") {
    fields.push("question = ?");
    sqliteValues.push(body.question.trim() || null);
    pgValues.push(body.question.trim() || null);
  }
  if (body.direction === "above" || body.direction === "below") {
    fields.push("direction = ?");
    sqliteValues.push(body.direction);
    pgValues.push(body.direction);
    fields.push("last_state = ?");
    sqliteValues.push(null);
    pgValues.push(null);
  }
  if (body.threshold != null) {
    const threshold = Number(body.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      res.status(400).json({ error: "threshold must be between 0 and 1" });
      return;
    }
    fields.push("threshold = ?");
    sqliteValues.push(threshold);
    pgValues.push(threshold);
    fields.push("last_state = ?");
    sqliteValues.push(null);
    pgValues.push(null);
  }
  if (typeof body.enabled === "boolean") {
    fields.push("enabled = ?");
    sqliteValues.push(body.enabled ? 1 : 0);
    pgValues.push(body.enabled ? 1 : 0);
  }

  if (fields.length === 0) {
    res.status(400).json({ error: "No valid fields provided" });
    return;
  }

  const now = Date.now();
  fields.push("updated_at = ?");
  sqliteValues.push(now);
  pgValues.push(now);

  const db = getDb();
  const sqliteSql = `UPDATE market_alerts SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`;
  const sqliteResult = db.prepare(sqliteSql).run(...sqliteValues, id, userId);

  if (isPgEnabled()) {
    const pgSetClause = fields.map((field, index) => field.replace("?", `$${index + 1}`)).join(", ");
    await pgExec(
      `UPDATE market_alerts SET ${pgSetClause} WHERE id = $${pgValues.length + 1} AND user_id = $${pgValues.length + 2}`,
      [...pgValues, id, userId]
    );
  }

  if (sqliteResult.changes === 0) {
    res.status(404).json({ error: "Market alert not found" });
    return;
  }

  res.json({ ok: true, id });
});

export default router;
