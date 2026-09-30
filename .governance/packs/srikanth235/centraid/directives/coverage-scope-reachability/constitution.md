# coverage-scope-reachability

Top-level `packages/*` source trees and every executable tree co-located
outside `src/` inside a package must not fall outside every coverage floor,
derived flow owner, and intentional-ungated allowlist.

Coverage floors only gate the globs listed in `tests/floors.json#coverage`.
A new package under `packages/foo/src`, or executable code added to a non-`src`
runtime tree, with no floor, no flow owner, and no allowlist entry is
invisible to the coverage thresholds — the blind spots #532, #630, and #725
closed.

A non-`src` tree is scored as its own scope id and is **not** satisfied by its
package's `src/**` floor, which cannot instrument it (#781), so the trees are
discovered from the tracked file list instead of named in this script.

The rule runs both ways. A tree that moves INTO `src/` stops being a scope of
its own: the conventional include instruments it and the package's `src/**`
floor measures it (#799). The v0 `apps/*` class and its named runtime roots
left with the v0 TypeScript tree (#1020).

**Fix:** add a floor scope for the runtime tree, add a flow owner under that
path, or (for deliberate journey-only surfaces) append the exact scope id to
this directive's allowlist with a TESTING.md note.

**Waiver:** `// governance: allow-coverage-scope-reachability <reason>` is not
used for package trees; use the allowlist file in this directive folder so
the exception is reviewable.
