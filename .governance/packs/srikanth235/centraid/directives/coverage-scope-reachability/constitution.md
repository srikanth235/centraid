# coverage-scope-reachability

Top-level `packages/*` / `apps/*` source trees and every executable tree
co-located outside `src/` inside a package or app must not fall outside every
coverage floor, matrix owner, and intentional-ungated allowlist.

Coverage floors only gate the globs listed in `tests/coverage-floors.json`.
A new package under `packages/foo/src`, or executable code added to a non-`src`
runtime tree, with no floor, no matrix owner, and no allowlist entry is
invisible to `bun run coverage` thresholds — the exact blind spots #532, #630,
and #725 close.

A non-`src` tree is scored as its own scope id and is **not** satisfied by its
package's `src/**` floor, which cannot instrument it. #781 found
`packages/model-runtime/automation-handlers` — 1,042 lines of hand-authored
production handlers — hidden by exactly that conflation, so the trees are now
discovered from the tracked file list instead of named in this script.

**Fix:** add a floor scope for the runtime tree, add a matrix flow owner under
that path, or (for deliberate journey-only surfaces) append the exact scope id
to this directive's allowlist with a TESTING.md note.

**Waiver:** `// governance: allow-coverage-scope-reachability <reason>` is not
used for package trees; use the allowlist file in this directive folder so
the exception is reviewable.
