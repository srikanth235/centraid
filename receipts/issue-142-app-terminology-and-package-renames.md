# issue-142 — app terminology + package renames

GitHub issue: [#142](https://github.com/srikanth235/centraid/issues/142)

A repo-wide naming cleanup. Three renames plus a governance-directive rename,
landing together because they are mechanically interdependent — sequential
token sweeps over heavily-overlapping files, where splitting per-rename would
produce non-building intermediate commits (e.g. a file carrying an
`@centraid/app-engine` import committed before the package directory is moved).

v0 pre-release: no backward compatibility, no migrations.

## Checklist

- [x] Unify project→app terminology across code, tests, and docs
- [x] Rename @centraid/builder-harness to @centraid/agent-harness
- [x] Rename @centraid/runtime-core to @centraid/app-engine
- [x] Rename governance directive gateway-core-mode-agnostic to gateway-engine-mode-agnostic
- [x] Repoint moved internal doc links in receipts

## What changed

- **Unify project→app terminology across code, tests, and docs.** The wire/
  response field `project:` became `app:`; internal identifiers
  (`ProjectInfo`/`projectId`/`scaffoldProjectFiles`/`deleteProject`) became their
  `App*`/`appId` equivalents; IPC channel constants `PROJECT_*` became `APP_*`;
  and the `automation-project` subsystem became `automation-app`. A guarded sweep
  protected SQL `projection`/`projected` and repo-meaning "this project"; native
  Xcode/gradle files and historical receipts were excluded.
- **Rename @centraid/builder-harness to @centraid/agent-harness.** `git mv` of
  `packages/builder-harness` → `packages/agent-harness` (reverting the #56 name to
  its original), with all importers, workspace deps, README, and the cloning doc
  (including its GitHub URL) repointed. A stale pre-#56 dist orphan was removed.
- **Rename @centraid/runtime-core to @centraid/app-engine.** `git mv` of
  `packages/runtime-core` → `packages/app-engine`, with all importers, deps, 11
  `.mdx` docs, and the README repointed. The package already described itself as
  an "engine for centraid apps". The path-based globs in
  `no-hardcoded-model-ids/check.sh` (the `model-pricing.ts` allowlist) and the
  `gateway-engine-mode-agnostic` check now target `packages/app-engine/`, so the
  governance checks keep inspecting the right tree instead of silently passing.
- **Rename governance directive gateway-core-mode-agnostic to gateway-engine-mode-agnostic.**
  The directive folder was `git mv`'d and its id updated in `packs.lock`,
  `CONSTITUTION.md`, and the directive's own `check.sh`/`constitution.md`/
  `directive.yaml`. The "core" was modernized to "engine" to match the package
  rename while keeping the directive's gateway-mode framing.
- **Repoint moved internal doc links in receipts.** Six internal links in
  existing receipts pointed at files that moved under the package renames; their
  link targets were repointed (link syntax only — the surrounding historical
  prose was left verbatim).

## Out of scope

- The `agent-steering-accounting` governance failure on committed `HEAD`
  (`b7f78c7`) — a pre-existing steering-row count mismatch, unrelated to these
  renames; not addressed here.
- Renaming the `agent-harness` package's internal "builder" concept words (the
  AI-builder feature keeps its name); only the package identity changed.
- Historical commit-message strings in `receipts/`, `COSTS.md`, and `STEERING.md`
  were left untouched.

## Verification

- `typecheck` 18/18, `build` 9/9, `test` 14/14, `lint` 0 errors, `format` clean.
- Governance: 19/20 directives pass. `no-broken-internal-doc-links` passes after
  the repoint of moved internal doc links in receipts. The renamed
  `gateway-engine-mode-agnostic` directive passes both directly and via the
  runner (which resolves it by id). The one failure is the out-of-scope,
  pre-existing `agent-steering-accounting`.
- Confirmed no stray `builder-harness` / `runtime-core` references remain outside
  the intentionally-excluded historical files, and the new package names resolve
  across the workspace after `bun install`.
