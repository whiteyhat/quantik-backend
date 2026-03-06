# /commit — Create a conventional commit

Stage and commit current changes with a well-formed conventional commit message.

1. Run in parallel:
   - `git status`
   - `git diff`

2. Analyze the changes and draft a commit message:
   - Format: `type(scope): short description`
   - Types: `feat` | `fix` | `refactor` | `chore` | `test` | `docs` | `perf`
   - Scope: the module or route affected (e.g. `edge`, `risk`, `oracle`, `db`)
   - Keep the subject line under 72 chars
   - Add a body if the change needs explanation

3. Stage specific files (never `git add .` — avoid accidentally committing `.env`)

4. Commit with:
```
git commit -m "$(cat <<'EOF'
type(scope): description

Optional body.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

5. Run `git status` to confirm success
