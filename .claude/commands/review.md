# /review — Code review focused on backend quality

You are performing a thorough code review of the quantik-backend (Node.js/Express/TypeScript trading backend).

Review the specified file(s) or recent changes (`git diff HEAD~1`) and evaluate:

### Security
- No secrets/keys hardcoded
- No SQL injection (use parameterized queries with better-sqlite3)
- No command injection in CLI calls
- Input validation at route boundaries
- No sensitive data leaked in error responses

### TypeScript Quality
- Proper types (no unnecessary `any`)
- Error handling: `err instanceof Error ? err.message : String(err)` pattern
- Async functions properly awaited
- No floating promises

### Express/API Design
- Consistent response shape `{ data } | { error }`
- Correct HTTP status codes (200, 201, 400, 404, 500)
- Route handlers wrapped in try/catch
- No blocking synchronous operations in request handlers (SQLite sync is fine)

### Logic & Correctness
- Edge cases handled
- No off-by-one errors in financial calculations
- Kelly criterion / risk calculations are bounded (0-1)
- No division by zero in math-heavy modules

### Performance
- No N+1 queries — batch SQLite reads where possible
- No unnecessary awaits in series (parallelize with Promise.all)

**Output format:**
- List issues by severity: Critical | Warning | Suggestion
- For each issue: file:line, description, fix
- End with a summary and top 3 action items
