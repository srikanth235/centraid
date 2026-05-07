# Receipt — issue-3: fix ci.yml oxfmt --check failures

Closes [#3](https://github.com/srikanth235/centraid/issues/3).

## Checklist

- [x] .oxfmtrc.jsonc
- [x] .github/workflows/ci.yml
- [x] apps/mobile/package.json
- [x] receipts/issue-3.md

## What changed

- `.oxfmtrc.jsonc` — appended three entries to `ignorePatterns`: `.governance/**`, `.github/ISSUE_TEMPLATE/**`, and `.github/workflows/governance.yml`. These cover the governance-kit installed assets (six of the eight files oxfmt was previously flagging) so they are skipped by `bun run format:check` and won't drift from their upstream pack content on the next `governance pack update`. The user-style rules (`printWidth`, `singleQuote`, etc.) are untouched.
- `.github/workflows/ci.yml` — oxfmt fix. Switched the `GOVERNANCE_FILE_SIZE_LIMIT` env value from double quotes to single quotes to match the repo's `singleQuote: true` rule.
- `apps/mobile/package.json` — oxfmt fix. Re-sorted the `dependencies` object so `@centraid/design-tokens` lands in alphabetical position (experimentalSortPackageJson). No semantic change.
- Added `receipts/issue-3.md` (this file) so `commit-issue-receipt-match` has a receipt to bind the commit to issue #3.

## Out of scope

- Changing oxfmt's formatting rules in `.oxfmtrc.jsonc` (only ignorePatterns moved).
- Reformatting the kit-installed files themselves — they are regenerable assets, not source of truth.
- Tightening or relaxing oxlint rules in `.oxlintrc.json`.
- Adding Markdown formatting (already excluded via `**/*.md`).

## Verification

- `bun run check` exits 0 — both `oxfmt --check .` and `oxlint .` are green locally.
- `bash .governance/run.sh` exits 0 — all 12 directives pass against the new HEAD.
- The commit message matches `fix: ci.yml oxfmt --check failures (#3)` — Conventional Commits prefix + trailing issue reference.
- After push, both GitHub Actions workflows (`Governance` and `ci`) go green on the resulting commit.
- Each checked item above appears as a substring in *What changed*.
