import { Router } from "express";
import { getDb } from "../db/schema";

const router = Router();

router.get("/summary", (_req, res) => {
  try {
    const db = getDb();
    const todayStart = new Date().setUTCHours(0, 0, 0, 0);
    const { tradesToday } = db.prepare("SELECT COUNT(*) AS tradesToday FROM executions WHERE executed_at >= ? AND status != 'failed'").get(todayStart) as any;
    const { pnlToday } = db.prepare("SELECT COALESCE(SUM(pnl), 0) AS pnlToday FROM executions WHERE executed_at >= ? AND status != 'failed' AND pnl IS NOT NULL").get(todayStart) as any;
    const { total, wins } = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins FROM executions WHERE status != 'failed' AND pnl IS NOT NULL").get() as any;
    const { openPositions } = db.prepare("SELECT COUNT(*) AS openPositions FROM executions WHERE status = 'placed' AND pnl IS NULL").get() as any;
    res.json({ pnlToday: pnlToday ?? 0, tradesToday: tradesToday ?? 0, winRate: total > 0 ? (wins ?? 0) / total : 0, openPositions: openPositions ?? 0 });
  } catch {
    res.json({ pnlToday: 0, tradesToday: 0, winRate: 0, openPositions: 0 });
  }
});

export default router;
