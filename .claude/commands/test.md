# /test — Generate Jest tests for a module

You are writing Jest tests for the quantik-backend project.

**Test stack:**
- Jest + ts-jest
- Tests live in `tests/` directory (e.g. `tests/edge.test.ts`)
- Config in `package.json` under `"jest"` key
- Run with: `npm test`
- Timeout: 60s per test

**Task:**
Look at the file or module the user wants to test. Then:
1. Read the target source file thoroughly
2. Identify all exported functions/classes
3. Write a comprehensive test file covering:
   - Happy path for each function
   - Edge cases (empty input, nulls, boundary values)
   - Error paths (throws, rejects)
4. Mock external dependencies (SQLite db, HTTP calls, CLI calls) using `jest.mock()`
5. Place the test file at `tests/<module-name>.test.ts`

**Mocking pattern for SQLite:**
```ts
jest.mock("../src/db/schema", () => ({
  getDb: () => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn().mockReturnValue({ changes: 1 }),
    }),
  }),
}));
```

After writing tests, run `npm test` to verify they pass.
