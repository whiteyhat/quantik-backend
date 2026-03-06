# /route — Scaffold a new Express route

You are scaffolding a new Express route for the quantik-backend project.

**Stack context:**
- Node.js + Express + TypeScript
- SQLite via `better-sqlite3` — use `getDb()` from `src/db/schema.ts`
- All routes are in `src/routes/` and mounted in `src/index.ts`
- Follow the existing pattern: default export of an `express.Router()`
- Use `async/await`, wrap handlers in try/catch, return `res.json()`
- No auth middleware currently — keep it consistent with existing routes

**Task:**
The user wants to create a new route. Ask for:
1. Route name / path prefix (e.g. `trades` → `/api/trades`)
2. What endpoints it needs (GET list, GET by id, POST, PATCH, DELETE)
3. What data it works with

Then:
1. Create `src/routes/<name>.ts` following existing patterns
2. Add the import + `app.use(...)` mount to `src/index.ts`
3. Show the user the created file paths

**Reference pattern:**
```ts
import express from "express";
import { getDb } from "../db/schema";

const router = express.Router();

router.get("/", (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM table_name ORDER BY created_at DESC").all();
    res.json(rows);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
```
