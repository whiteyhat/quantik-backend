# Quantik Backend — Known Issues & Fixes

Last updated: 2026-03-06

---

## Issue 1: Telegram flood on startup (10 full stack traces)

**Severity:** Medium — noisy logs, not a functional failure

**Symptom:**
```
[telegramAlert] sendSignalAlert failed: Error: Telegram bot token missing
    at tgPost (.../telegramAlert.ts:54:31)
    ...
```
Repeated 10 times immediately on startup.

**Root cause:**
`AlertPoller.pollAndAlert()` fires immediately on startup and queries the DB for pending alerts (`alert_sent = 0`). If there are queued signals from a previous run, it attempts to send each one via `tgPost()`, which throws `"Telegram bot token missing"` when `TELEGRAM_BOT_TOKEN` is not set. `sendSignalAlert` catches the error and calls `console.error(err)`, which prints the full `Error` object including stack trace — once per alert (up to 10).

**Fix applied:** `src/alerts/telegramAlert.ts`
- Added early token check at the top of `pollAndAlert()` — returns silently if unconfigured
- Changed `sendSignalAlert` / `sendStatusUpdate` error logging from `console.error(err)` (stack trace) to `console.warn(msg)` (message only) for token-missing errors

**To enable Telegram:** add to `.env`:
```
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

---

## Issue 2: Combinatorial arb detector floods logs (8 stack traces per scan)

**Severity:** Medium — noisy logs, wastes time on every pipeline run

**Symptom:**
```
Combinatorial arb detection failed: CliError: polymarket markets list failed: spawn /root/.local/bin/polymarket ENOENT
    at <anonymous> (.../cli.ts:31:13)
    ...
```
Repeated once per market scanned (8 times per cycle).

**Root cause:**
`detectCombinatorial()` in `src/oracle/arb-detector.ts` unconditionally calls `runCli(["markets", "list"])`, which spawns the Polymarket CLI binary. On local macOS dev, the binary doesn't exist (`.env` has `POLYMARKET_CLI=/root/.local/bin/polymarket`, a Linux production path). No availability check before the spawn attempt. The catch block logs `console.error(err)` with the full stack trace.

**Fix applied:** `src/oracle/arb-detector.ts`
- Added `POLYMARKET_CLI` env var check at function entry — returns `{ detected: false }` silently if not set or binary not reachable

---

## Issue 3: Portfolio USDC fallback warning on every market

**Severity:** Low — informational noise

**Symptom:**
```
/bin/sh: polymarket: command not found
[Edge] portfolio_usdc: no live source available. Using $1000 default.
```
Printed once per market processed.

**Root cause:**
`fetchPortfolioUsdc()` in `src/edge/index.ts` tries three sources in order: `PORTFOLIO_USDC` env var, `polymarket wallet balance` CLI command, then `PORTFOLIO_USDC_FALLBACK` env var. None are set locally. The CLI call uses `execSync("polymarket wallet balance")` without the full path, so it fails with `command not found` via shell. Falls back to the hardcoded $1000 default with a warning.

**Fix applied:** `.env` + `.env.example`
- Added `PORTFOLIO_USDC_FALLBACK=1000` so the fallback is explicit and the warning is suppressed

---

## Issue 4: GNews "fetch failed" (intermittent)

**Severity:** Low — handled gracefully

**Symptom:**
```
[GNews] Fetch failed for "Will Elon Musk": fetch failed
```

**Root cause:**
Google News RSS (`news.google.com`) occasionally blocks or rate-limits scraper requests with DNS-level failures or connection resets. The 8s `AbortSignal.timeout` fires and the error is caught — Aura falls back to other news sources (Guardian, NYT).

**Fix:** None needed. Already handled gracefully — returns `[]` and Aura continues with available sources.

---

## Issue 5: NYT HTTP 429 (rate limited)

**Severity:** Low — handled gracefully

**Symptom:**
```
[NYT] HTTP 429 for query: "Will Canada win the 2026 FIFA World Cup?"
```

**Root cause:**
NYT Developer API has per-minute rate limits (~10 req/min). The scanner processes multiple markets simultaneously, firing parallel NYT requests that exceed the limit.

**Fix:** None needed. Already returns `[]` on 429 — Aura uses remaining sources.
To reduce frequency: consider adding a short delay between NYT calls or caching results per query.

---

## Issue 6: CryptoPanic HTTP 404 / 429

**Severity:** Low — handled gracefully

**Symptom:**
```
[CryptoPanic] HTTP 404
[CryptoPanic] HTTP 429
```

**Root cause:**
404 likely means the `filter=important` endpoint returns no results for non-crypto markets. 429 is rate limiting. Both are caught and return `{ score: 0, resultCount: 0 }`.

**Fix:** None needed. Already handled gracefully.

---

## Issue 7: Polymarket CLI not found (expected on local dev)

**Severity:** Info — expected in local dev environment

**Symptom:**
```
[startup] CLOB allowance setup failed: CliError: spawn /root/.local/bin/polymarket ENOENT
/bin/sh: polymarket: command not found
```

**Root cause:**
`POLYMARKET_CLI=/root/.local/bin/polymarket` is the production Linux path (Railway server). The binary is not installed on macOS dev machines. All CLI-dependent features (live trading, CLOB balance, wallet) are inactive locally.

**Fix:** Not needed for local dev. Set `PAPER_TRADING=true` in `.env` to suppress the startup allowance check. CLI is only required on the production server.

---

## Environment Variables Checklist

| Variable | Required | Local dev value | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | set | Required for Oracle, Clause, Lucifer, Relay, Sigma |
| `POLYMARKET_PRIVATE_KEY` | Prod only | `0x...` | Live trading only |
| `POLYMARKET_CLI` | Prod only | `/root/.local/bin/polymarket` | Linux prod path |
| `PAPER_TRADING` | Recommended locally | `true` | Suppresses CLI startup check |
| `PORTFOLIO_USDC_FALLBACK` | Recommended | `1000` | Silences edge fallback warning |
| `TELEGRAM_BOT_TOKEN` | Optional | — | Needed for signal alerts |
| `TELEGRAM_CHAT_ID` | Optional | — | Needed for signal alerts |
| `FRONTEND_URL` | Optional | — | CORS allowlist |
