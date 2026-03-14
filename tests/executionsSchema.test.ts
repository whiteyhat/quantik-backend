import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

function createLegacyExecutionsTable(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      agent_id TEXT,
      slug TEXT NOT NULL,
      side TEXT NOT NULL,
      amount REAL NOT NULL,
      executed_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT,
      fill_price REAL,
      pnl REAL DEFAULT NULL
    );
  `);
  return db;
}

describe("executions schema migration", () => {
  afterEach(() => {
    jest.resetModules();
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  });

  test("drops the legacy per-slug/day unique index on startup", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-executions-schema-"));
    const dbPath = path.join(tempDir, "quantik.db");
    const legacyDb = createLegacyExecutionsTable(dbPath);

    legacyDb.exec(`
      CREATE UNIQUE INDEX ux_executions_slug_day
      ON executions(slug, DATE(executed_at / 1000, 'unixepoch'));
    `);
    legacyDb
      .prepare(`
        INSERT INTO executions (slug, side, amount, executed_at, status, fill_price)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run("will-btc-hit-100k", "buy", 10, Date.UTC(2026, 2, 14, 9, 0, 0), "placed", 0.52);
    legacyDb.close();

    process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;
    const { getDb } = await import("../src/db/schema");
    const db = getDb();

    const indexes = db
      .prepare(`PRAGMA index_list('executions')`)
      .all() as Array<{ name: string }>;

    expect(indexes.some((index) => index.name === "ux_executions_slug_day")).toBe(false);
  });

  test("startup migration preserves multiple same-day execution rows", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantik-executions-schema-"));
    const dbPath = path.join(tempDir, "quantik.db");
    const legacyDb = createLegacyExecutionsTable(dbPath);
    const sameDay = Date.UTC(2026, 2, 14, 11, 30, 0);

    legacyDb
      .prepare(`
        INSERT INTO executions (slug, side, amount, executed_at, status, fill_price)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run("same-market", "buy", 10, sameDay, "placed", 0.55);
    legacyDb
      .prepare(`
        INSERT INTO executions (slug, side, amount, executed_at, status, fill_price)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run("same-market", "buy", 20, sameDay + 60_000, "failed", 0.57);
    legacyDb.close();

    process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;
    const { getDb } = await import("../src/db/schema");
    const db = getDb();

    const row = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM executions
        WHERE slug = ?
      `)
      .get("same-market") as { count: number };

    expect(row.count).toBe(2);
  });
});
