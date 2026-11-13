# Git

- One branch for all work on an issue. Never open a new pull request unless asked.
- Push with `git fetch origin <branch> && git rebase --autostash FETCH_HEAD && git push -u origin HEAD:<branch>`. Never force-push. Never amend or re-author another person's commits.
- Keep the configured git identity. Never change git config. Check the authors of what you push.
- Commit subjects read `type(scope): subject (#N)`, at most 100 characters; no trailers. A pull request title follows the same rule.
- Fix the code, not the check ([gate.md](gate.md)). Proto changes are additive only.
- Before pushing run the fast checks: fmt, clippy on the crate, `cargo xtask rules` reading the whole output, the crate's tests, `bun run check` for TypeScript. Re-run them after a rebase that brought in other work.
- A push cancels the gate run in flight, so batch fixes into one push.
- Disk is limited: one cargo at a time, clear `target` before a large build, never disable a sandbox.
- No model names in commits, code or pull request text.
