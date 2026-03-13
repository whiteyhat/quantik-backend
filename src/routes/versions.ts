import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { isPgEnabled, pgQuery } from "../db/postgres";

const router = Router();

interface VersionRow {
  id: number;
  version: string;
  released_at: string;
  features: string;
  fixes: string;
  highlight: string | null;
  highlight_es: string | null;
  highlight_fr: string | null;
  highlight_de: string | null;
  features_es: string | null;
  features_fr: string | null;
  features_de: string | null;
  fixes_es: string | null;
  fixes_fr: string | null;
  fixes_de: string | null;
}

function parseJson(raw: string | null, fallback: string[] = []): string[] {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as string[]; } catch { return fallback; }
}

function formatRows(rows: VersionRow[]) {
  return rows.map((v) => {
    const enFeatures = parseJson(v.features);
    const enFixes = parseJson(v.fixes);
    return {
      version: v.version,
      date: v.released_at,
      highlight: {
        en: v.highlight ?? "",
        es: v.highlight_es ?? v.highlight ?? "",
        fr: v.highlight_fr ?? v.highlight ?? "",
        de: v.highlight_de ?? v.highlight ?? "",
      },
      features: {
        en: enFeatures,
        es: parseJson(v.features_es, enFeatures),
        fr: parseJson(v.features_fr, enFeatures),
        de: parseJson(v.features_de, enFeatures),
      },
      fixes: {
        en: enFixes,
        es: parseJson(v.fixes_es, enFixes),
        fr: parseJson(v.fixes_fr, enFixes),
        de: parseJson(v.fixes_de, enFixes),
      },
    };
  });
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    if (isPgEnabled()) {
      const rows = await pgQuery<VersionRow>(
        "SELECT * FROM versions ORDER BY id DESC"
      );
      return res.json(formatRows(rows));
    }

    const db = getDb();
    const rows = db.prepare<[], VersionRow>(
      "SELECT * FROM versions ORDER BY id DESC"
    ).all();
    return res.json(formatRows(rows));
  } catch (err) {
    console.error("[versions] Error:", err);
    res.status(500).json({ error: "Failed to load versions" });
  }
});

export default router;
