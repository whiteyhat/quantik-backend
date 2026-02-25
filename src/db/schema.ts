import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(__dirname, "..", "..", "quantik.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      market_slug TEXT,
      market_question TEXT,
      created_at INTEGER,
      completed_at INTEGER,
      decision TEXT,
      confidence REAL,
      aura_output JSON,
      flux_output JSON,
      oracle_output JSON,
      edge_output JSON,
      sigma_output JSON,
      clause_output JSON,
      lucifer_output JSON
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      market_slug TEXT,
      direction TEXT,
      size REAL,
      price REAL,
      net_ev REAL,
      ev_grade TEXT,
      status TEXT,
      created_at INTEGER,
      pipeline_run_id TEXT
    );
  `);
}
