# Issue #162 — Consolidate sibling packages

Two structural package-layout cleanups, landed in one commit because they
overlap at the file level (shared import blocks + `package.json` dependency
lists) and the automation directory rename is inseparable from its import
fixes under the pre-commit test gate.

## Checklist
- [x] Fold @centraid/analytics into app-engine as an internal insights/ sub-module
- [x] Rename @centraid/automation to @centraid/automation-engine

## What changed

### Fold @centraid/analytics into app-engine as an internal insights/ sub-module
- Moved the analytics package source into `packages/app-engine/src/insights/`
  (`analytics-db.ts`, `analytics-store.ts`, `insights-store.ts`, both test
  files, `README.md`) via `git mv` so history is preserved. Deleted the
  `@centraid/analytics` package (`package.json`, `tsconfig.json`).
- The moved files now reach the rest of app-engine through relative imports
  (`../gateway-db.js` for `DatabaseProvider` / `makeMigratedDbProvider`,
  `../agent-runs-schema.js` for `RunKind`, `../run-summary-sink.js` for the
  `RunSummary` / `RunSummarySink` contract) instead of `@centraid/app-engine`.
- Rewrote `insights/index.ts` as the sub-module barrel and re-export it from
  app-engine's root `index.ts` via `export * from './insights/index.js'`.
  Dropped the barrel's old `RunSummary` / `RunSummarySink` re-export since the
  package root already exports those (avoids a duplicate-export collision).
- Kept the boundary one-way: `insights/` imports inward; nothing in app-engine
  imports back into `insights/`. Preserves the #151 domain separation as a
  folder rather than a separate package. Updated the now-stale package
  references in `index.ts`, `gateway-db.ts`, and `run-summary-sink.ts`.
- Updated the four consumers (`agent-runtime`, `automation-engine`, `gateway`,
  `openclaw-plugin`) to import the analytics symbols from `@centraid/app-engine`
  and dropped the `@centraid/analytics` dependency from their `package.json`.
  All four already depended on app-engine, so no new package edges were added.

### Rename @centraid/automation to @centraid/automation-engine
- Renamed the directory `packages/automation/` → `packages/automation-engine/`
  via `git mv` (history preserved) and updated the package `name` + `README.md`.
- Updated every consumer's dependency declaration and import specifier across
  `gateway`, `agent-runtime`, `openclaw-plugin`, `app-blueprints`, and
  `apps/desktop`. Merged the resulting same-module imports to satisfy oxlint's
  no-duplicates rule, and reflowed import lines the longer name pushed over the
  width limit.
- `bun install` re-resolved the lockfile under both new names. Left the
  historical `receipts/issue-149-*.md` and `receipts/issue-158-*.md` untouched —
  they record the package name as it was at the time.

## Out of scope
- Stripping the redundant `automation-` filename prefix inside the renamed
  package (the per-file rename the user explicitly deferred — package rename only).
- Rewriting the historical receipts that mention the old `@centraid/automation`
  name; they are immutable audit records of past work.
- Folding `@centraid/worktree-store` into the gateway: deferred until the
  OpenClaw re-platform removes its second consumer (separate discussion).

## Verification
- `turbo run typecheck`: 19/19 tasks pass (includes `apps/desktop`).
- `turbo run test`: all suites green for the touched packages — app-engine 307
  (incl. the moved `AnalyticsStore` / `InsightsStore` suites), gateway 83,
  agent-runtime 55, automation-engine 62, app-blueprints 37, openclaw-plugin 6.
- `bun run check` (`oxfmt --check` + `oxlint`): 0 warnings, 0 errors.
- Confirmed no `@centraid/analytics` or bare `@centraid/automation` references
  remain outside the historical receipts.
