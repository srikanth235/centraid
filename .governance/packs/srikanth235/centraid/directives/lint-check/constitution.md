# lint-check

Staged files that oxlint owns must already pass oxlint.

oxlint is the cheapest signal in the repo: 0.11s for a two-file commit against
1.7s for the whole tree, and it names the offending line exactly. Deferring it
to `check:pr` or the `static` CI job means a lint error can sit in the branch
for the length of a working session and then cost a 12-minute CI round trip to
discover.

The check is scoped to staged files, like `format-check` beside it. Blocking a
commit on lint debt in files the author never opened trains people to reach for
`--no-verify`, and a gate people routinely bypass protects nothing.

Errors or off, never warning debt. The staged check and repository-wide
local/CI gate use the pinned root config with `--deny-warnings`, so every
surface applies the same blocking policy.

**Fix:** `bun run lint` (or `bun run lint:fix` for reviewed safe fixes), then
`bun run check:pr` for the complete gate.

**Waiver:** none at the hook. A rule that genuinely does not apply belongs in
an explicit root `oxlint.config.ts` profile decision, or behind a narrow
reasoned `oxlint-disable` comment where the exception is visible in review.
