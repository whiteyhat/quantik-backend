# /debug — Systematic backend debugging

You are debugging an issue in the quantik-backend project.

**Debugging workflow:**

1. **Understand the symptom** — Ask the user:
   - What endpoint or module is failing?
   - What is the exact error message or unexpected behavior?
   - Does it happen consistently or intermittently?

2. **Gather evidence** — Read the relevant files:
   - The route handler in `src/routes/`
   - The underlying module (e.g. `src/edge/`, `src/risk/`, `src/oracle/`)
   - Database schema if data-related
   - Check `src/index.ts` for startup issues

3. **Trace the call path** — Follow the request from route to module to db/external

4. **Common failure modes in this codebase:**
   - SQLite: table/column doesn't exist yet — check for missing `ensureXxx()` calls at startup in `src/index.ts`
   - CLI calls: `POLYMARKET_CLI` env var not set or binary not found
   - API keys: undefined env vars silently failing (check `.env`)
   - Async errors swallowed by missing `await` or unhandled promise rejection
   - CORS: origin not in `ALLOWED_ORIGINS`
   - Type errors at runtime from `undefined` accessed as object

5. **Propose fix** — Show exactly what to change with file:line references

6. **Verify** — Suggest how to confirm the fix (curl command, log output, test to run)
