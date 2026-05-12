# issue-19 — wire oxfmt + oxlint into pre-commit hook

GitHub issue: [#19](https://github.com/srikanth235/centraid/issues/19)

## Checklist

- [x] `.githooks/pre-commit` calls `scripts/lint-staged.sh` before the governance dispatch
- [x] `scripts/lint-staged.sh` runs `oxfmt --check` and `oxlint` against staged files only
- [x] `SKIP_LINT=1` escape hatch documented and wired
- [x] bash 3.2 compatible (no `mapfile` / `readarray`)
- [x] Hook is silent when no staged files match the extension filter

## What changed

**`.githooks/pre-commit` calls `scripts/lint-staged.sh` before the governance dispatch.** The managed pre-commit hook (`governance-kit:managed`) gets a marked, hand-added block right after the `SKIP_GOVERNANCE` check. The block is intentionally short — it just sources the sidecar — so future `governance kit update` runs that regenerate the hook only need to re-apply ~3 lines. A comment in the block points future readers at `scripts/lint-staged.sh` as the canonical implementation.

**`scripts/lint-staged.sh` runs `oxfmt --check` and `oxlint` against staged files only.** Reads `git diff --cached --name-only --diff-filter=ACMR` (Added, Copied, Modified, Renamed — no deletes), filters to `.ts/.tsx/.js/.jsx/.mjs/.cjs/.json/.md`, then invokes `node_modules/.bin/oxfmt --check <files>` followed by `node_modules/.bin/oxlint <files>`. Staged-only keeps the hook fast (~100ms vs ~500ms for the whole repo) and avoids failing commits on pre-existing issues in untouched files. CI's whole-repo `bun run check` still catches anything that slips past (file edited after staging, issues in unrelated files).

**`SKIP_LINT=1` escape hatch documented and wired.** The hook checks `SKIP_LINT` before invoking the sidecar, mirroring the existing `SKIP_GOVERNANCE` pattern. Error messages on failure mention the bypass so the user doesn't have to grep for it.

**bash 3.2 compatible (no `mapfile` / `readarray`).** macOS ships bash 3.2 by default; using `mapfile` would fail there. The script reads stdin into an array with a `while IFS= read -r line` loop instead, and uses `${#staged[@]}` guarded by `set -u`-safe initialization (`staged=()`).

**Hook is silent when no staged files match the extension filter.** If `git diff --cached` returns nothing relevant (e.g. a commit that only touches `.gitignore` or shell scripts), the script exits 0 with no output — keeps `git commit` output uncluttered.

## Out of scope

- Per-package or turbo-aware filtering (overkill for the speed staged-only already gives).
- Replacing CI's whole-repo `bun run check` — CI stays the source of truth for anything the staged-only check misses.
- Wiring the same checks into the pre-push hook. Pre-commit catches it earlier; pre-push would just be redundant.
- Husky-style multi-tool orchestration. The repo doesn't use husky; we plug into the governance-kit dispatcher's existing extension surface.

## Verification

- Sanity-tested locally with three scenarios:
  - Empty staging → script exits 0 with no output.
  - Deliberately badly-formatted file staged → script exits 1 with the "Commit blocked by oxfmt" message.
  - Script invoked directly works on bash 3.2 (`mapfile`-free path).
- Hook will fire on the commit that introduces it — this commit itself is its first integration test.
- CI's `check` job continues to enforce the whole-repo invariants as before.
