# /db — SQLite schema and query helper

You are helping with the SQLite database layer of quantik-backend.

**Context:**
- Database: SQLite via `better-sqlite3`
- Schema defined in `src/db/schema.ts` — always read this first
- Queries in `src/db/queries.ts`
- DB is initialized once via `getDb()` singleton
- All operations are synchronous (better-sqlite3 is sync-only)

**Task:** Help the user with whatever database work they need:
- Writing new queries (use `db.prepare().all/get/run()`)
- Adding columns or tables (write migration code inline — no migration framework)
- Debugging slow queries
- Designing schema for new features

**Add column safely:**
```ts
export function ensureNewColumn(): void {
  const db = getDb();
  const cols = db.pragma("table_info(table_name)") as { name: string }[];
  if (!cols.find(c => c.name === "new_column")) {
    db.exec("ALTER TABLE table_name ADD COLUMN new_column TEXT");
  }
}
```

**New table pattern:**
```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS my_table (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    data TEXT
  )
`);
```

Always:
1. Read `src/db/schema.ts` and `src/db/queries.ts` before making changes
2. Use `CREATE TABLE IF NOT EXISTS` patterns
3. Keep schema changes additive — never drop columns
