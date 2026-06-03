# issue-174 — fold worktree-store into gateway as an internal module

GitHub issue: [#174](https://github.com/srikanth235/centraid/issues/174)

`@centraid/worktree-store` is the gateway-owned git store, and `gateway` was
its only consumer. A single-consumer workspace package is pure overhead, so —
following the package-consolidation precedent set by #162 (where `analytics`
folded into `app-engine/src/insights/`) — it becomes an internal module under
`gateway/src/worktree-store/`.

v0 pre-release: no backward compatibility, no migrations.

## Checklist

- [x] Moved all 7 source files
- [x] Rewrote the 14 gateway files that imported the package
- [x] Dropped the `@centraid/worktree-store` dependency
- [x] Removed the stale `packages/code-store/` directory
- [x] Re-resolved `bun.lock`

## What changed

- **Moved** all 7 source files (`git mv`, history preserved) from
  `packages/worktree-store/src/` → `packages/gateway/src/worktree-store/`:
  `index.ts`, `types.ts`, `git.ts`, `remote.ts`, `worktree-store.ts`, and the
  `worktree-store.test.ts` / `remote.test.ts` suites. The files are
  self-contained (zero runtime deps, no `../` imports), so their internal
  relative imports needed no changes.
- **Rewrote** the 14 gateway files that imported the package: the
  `@centraid/worktree-store` specifier became the relative barrel
  `./worktree-store/index.js`.
- **Reworded** two doc-comments the bulk rewrite mangled
  (`publish-migrations.ts`, `worktree-store/types.ts`) so they read naturally
  and describe a module barrel rather than a package root.
- **Dropped** the `@centraid/worktree-store` dependency from
  `packages/gateway/package.json` and **deleted** the now-empty
  `packages/worktree-store/` package.
- **Re-resolved** `bun.lock` (one package removed).
- The module stays internal — it is *not* re-exported from gateway's root
  barrel, because nothing outside gateway consumes it. Re-exporting would add
  dead public API surface.
- **Removed** the stale `packages/code-store/` directory — leftover build
  artifacts (gitignored `dist/` + `.turbo/`, no `package.json` or `src/`) from
  a prior rename. It was entirely untracked, so it carries no diff.

## Out of scope

- No behavior change to the git store itself — this is a pure package-layout
  move.
- No re-home of any other single-consumer package; only `worktree-store` was
  in scope here.
- The two live `code-store` references in
  `apps/desktop/src/main/gateway-paths.ts` are a *runtime* on-disk path
  (`<gatewayDir>/code-store`, the git store location from #137), unrelated to
  the deleted artifact directory — intentionally left untouched.

## Verification

- `bun install` — lockfile re-resolved (1 package removed).
- `bun run typecheck` — 17/17 packages clean.
- gateway tests — 115 pass / 0 fail (now including the folded
  `worktree-store` suites).
- `bun run check` — oxfmt + oxlint clean.
