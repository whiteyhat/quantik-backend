/**
 * Seed script — upserts all changelog versions with full i18n support (en, es, fr, de).
 *
 * Usage:  npx tsx src/db/seed-releases.ts   (or npm run seed:releases)
 *
 * Safe to re-run: uses INSERT OR REPLACE / ON CONFLICT DO UPDATE throughout.
 */

import { getDb } from "./schema";
import { isPgEnabled, pgExec } from "./postgres";
import { RELEASES } from "./releases-data";

async function seedReleases() {
  // When DATABASE_URL is present (production/Railway), seed only PostgreSQL
  // to avoid SQLite path issues on non-persistent environments.
  if (isPgEnabled()) {
    for (const r of RELEASES) {
      await pgExec(`
        INSERT INTO versions
          (version, released_at, features, fixes, highlight,
           highlight_es, highlight_fr, highlight_de,
           features_es, features_fr, features_de,
           fixes_es, fixes_fr, fixes_de)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (version) DO UPDATE SET
          released_at  = EXCLUDED.released_at,
          features     = EXCLUDED.features,
          fixes        = EXCLUDED.fixes,
          highlight    = EXCLUDED.highlight,
          highlight_es = EXCLUDED.highlight_es,
          highlight_fr = EXCLUDED.highlight_fr,
          highlight_de = EXCLUDED.highlight_de,
          features_es  = EXCLUDED.features_es,
          features_fr  = EXCLUDED.features_fr,
          features_de  = EXCLUDED.features_de,
          fixes_es     = EXCLUDED.fixes_es,
          fixes_fr     = EXCLUDED.fixes_fr,
          fixes_de     = EXCLUDED.fixes_de
      `, [
        r.version,
        r.released_at,
        JSON.stringify(r.features.en), JSON.stringify(r.fixes.en), r.highlight.en,
        r.highlight.es, r.highlight.fr, r.highlight.de,
        JSON.stringify(r.features.es), JSON.stringify(r.features.fr), JSON.stringify(r.features.de),
        JSON.stringify(r.fixes.es), JSON.stringify(r.fixes.fr), JSON.stringify(r.fixes.de),
      ]);
    }
    console.log(`[seed-releases] PostgreSQL: upserted ${RELEASES.length} releases`);
  } else {
    // Local SQLite fallback
    const db = getDb();
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO versions
        (version, released_at, features, fixes, highlight,
         highlight_es, highlight_fr, highlight_de,
         features_es, features_fr, features_de,
         fixes_es, fixes_fr, fixes_de)
      VALUES
        (?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?)
    `);
    for (const r of RELEASES) {
      upsert.run(
        r.version, r.released_at,
        JSON.stringify(r.features.en), JSON.stringify(r.fixes.en), r.highlight.en,
        r.highlight.es, r.highlight.fr, r.highlight.de,
        JSON.stringify(r.features.es), JSON.stringify(r.features.fr), JSON.stringify(r.features.de),
        JSON.stringify(r.fixes.es), JSON.stringify(r.fixes.fr), JSON.stringify(r.fixes.de),
      );
    }
    console.log(`[seed-releases] SQLite: upserted ${RELEASES.length} releases`);
  }

  console.log("[seed-releases] Done.");
}

seedReleases().catch((err) => {
  console.error("[seed-releases] Fatal:", err);
  process.exit(1);
});
