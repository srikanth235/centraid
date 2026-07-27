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

Errors only, never warnings. The CI gate this stands in for (`bunx oxlint .`)
fails on errors alone. A local gate stricter than the remote one it previews
blocks commits that would have been accepted, which is a worse failure than the
one it prevents.

**Fix:** `bunx oxlint <file>` — or `bun run check:pr` for the whole tree.

**Waiver:** none at the hook. A rule that genuinely does not apply belongs in
`.oxlintrc.json`, or behind an `oxlint-disable` comment on the line itself,
where the exception is visible in review.
