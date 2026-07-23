# coverage-scope-reachability

Top-level `packages/*` / `apps/*` source trees must not fall outside every
coverage floor, matrix owner, and intentional-ungated allowlist.

Coverage floors only gate the globs listed in `tests/coverage-floors.json`.
A new package under `packages/foo/src` with no floor, no matrix owner, and
no allowlist entry is invisible to `bun run coverage` thresholds — the exact
blind spot #532 closes.

**Fix:** add a floor scope for the package, add a matrix flow owner under
that path, or (for deliberate journey-only surfaces) append the package id
to this directive's allowlist with a TESTING.md note.

**Waiver:** `// governance: allow-coverage-scope-reachability <reason>` is not
used for package trees; use the allowlist file in this directive folder so
the exception is reviewable.
