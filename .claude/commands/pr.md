# /pr — Create a pull request

Create a well-structured pull request for the current branch.

1. Run in parallel:
   - `git status`
   - `git diff main...HEAD`
   - `git log main...HEAD --oneline`

2. Analyze ALL commits and changes since diverging from main

3. Create the PR with:
   - Short title under 70 chars, prefixed: `feat:` / `fix:` / `refactor:` / `chore:`
   - Body sections:
     - **What** — what changed and why
     - **How** — implementation notes for non-obvious changes
     - **Test plan** — how to verify it works

4. Push branch if needed, then run `gh pr create`

Return the PR URL when done.
