import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";

const router = Router();

interface VersionRow {
  id: number;
  version: string;
  released_at: string;
  features: string;
  fixes: string;
  highlight: string | null;
}

router.get("/", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const rows = db.prepare<[], VersionRow>(
      "SELECT * FROM versions ORDER BY id DESC"
    ).all();

    res.json(rows.map((v) => ({
      id: v.id,
      version: v.version,
      released_at: v.released_at,
      highlight: v.highlight ?? "",
      features: JSON.parse(v.features) as string[],
      fixes: JSON.parse(v.fixes) as string[],
    })));
  } catch (err) {
    console.error("[versions] Error:", err);
    res.status(500).json({ error: "Failed to load versions" });
  }
});

export default router;
