# Issue #653 — main CI: format drift + SettingsRoute IconName

## Checklist

- [x] Reproduce `bun run format:check` failure on the four CI-flagged paths
- [x] Reproduce `@centraid/client` build `TS2304: Cannot find name 'IconName'` in `SettingsRoute.tsx`
- [x] Add type-only `IconName` import from `@centraid/design-tokens`
- [x] Run `bun run format` so oxfmt rewrites the four drifted files
- [x] `bun run format:check` exit 0
- [x] `bun run --cwd packages/client build` exit 0 twice (no IconName / `error TS`)
- [x] `bun run turbo run build --filter='./packages/*'` exit 0 with `@centraid/client#build` success
- [x] `bun run build` exit 0

## What changed

Root CI run https://github.com/srikanth235/centraid/actions/runs/30561239208:

- **static** failed at `format:check` on four paths
- **verify** / **mutation-pr** failed at `@centraid/client#build` on `IconName`

Local reproduce confirmed:

- Reproduce `bun run format:check` failure on the four CI-flagged paths (`CHANGELOG.md`, `docs/traps/design-tokens.md`, `packages/client/src/react/CSS-CONVENTIONS.md`, `packages/client/src/react/shell/appearance.test.ts`)
- Reproduce `@centraid/client` build `TS2304: Cannot find name 'IconName'` in `SettingsRoute.tsx` (lines using `IconName` without an import)

Fixes:

- Add type-only `IconName` import from `@centraid/design-tokens` in `packages/client/src/react/shell/routes/SettingsRoute.tsx` so `PageDef.icon` and related types compile under `tsc -p tsconfig.build.json`
- Run `bun run format` so oxfmt rewrites the four drifted files (mechanical only)
- Drop unused `THEME_PRESETS` / `themes` / `tileFinish` / `IconName` / `ThemeName` imports from `packages/client/src/react/screens/SettingsAppearanceScreen.tsx` and the unused `THEME_PRESETS` import from `packages/client/src/react/screens/SettingsAppearanceScreen.test.tsx` — static never reached oxlint on the red main run (format:check failed first); once format is fixed these `no-unused-vars` errors block `bun run lint`

## Decisions

None — the work followed the CI failure diagnosis exactly (format + missing type import). No design tradeoffs.

## Out of scope

- Node.js 20 Actions deprecation annotations
- GitHub Actions cache restore 400 / Pages noise
- Full coverage / Stryker / e2e beyond the known build+format gates
- Design-token catalog or Settings UX work

## Verification

Checklist crosswalk (each `[x]` item appears below as a substring for receipt-per-issue):

- Reproduce `bun run format:check` failure on the four CI-flagged paths — reproduced before fix; logs in implementer scratch `format-check-before.txt`
- Reproduce `@centraid/client` build `TS2304: Cannot find name 'IconName'` in `SettingsRoute.tsx` — confirmed against CI verify log job 90934757146
- Add type-only `IconName` import from `@centraid/design-tokens` — present in `SettingsRoute.tsx`
- Run `bun run format` so oxfmt rewrites the four drifted files — four paths in the staged diff
- `bun run format:check` exit 0 — after fix
- `bun run --cwd packages/client build` exit 0 twice (no IconName / `error TS`) — client-build-1/2
- `bun run turbo run build --filter='./packages/*'` exit 0 with `@centraid/client#build` success — packages-build
- `bun run build` exit 0 — repo-build

```sh
bun run format:check
bun run lint
bun run --cwd packages/client build
bun run --cwd packages/client build
bun run turbo run build --filter='./packages/*'
bun run build
```

## Audit

**PASS**

1. **What changed ↔ diff:** Working tree adds `import type { IconName } from "@centraid/design-tokens"` in `packages/client/src/react/shell/routes/SettingsRoute.tsx` (absent on `main` at `3b67d1a`, where `IconName` is used unimported — matches CI `TS2304`). Receipt names the four CI `format:check` paths (`CHANGELOG.md`, `docs/traps/design-tokens.md`, `packages/client/src/react/CSS-CONVENTIONS.md`, `packages/client/src/react/shell/appearance.test.ts`) and mechanical oxfmt-only rewrites — same set as issue #653 / run 30561239208. No extra substantive scope claimed.
2. **Checklist `[x]` items realized:** All eight boxes map to either tree evidence (IconName type-only import present; four format paths named and claimed reformatted) or Verification claims (`format:check`, client build ×2, packages turbo filter, monorepo `bun run build`). Reproduce steps documented against CI run + client verify job.
3. **Checklist mirrors #653 acceptance:** Issue acceptance is `format:check` green, `packages/client` build without IconName/TS errors, packages turbo + monorepo `bun run build`; Fix requires IconName import + `bun run format` on drifted files. Checklist covers format paths, IconName import, and those verification gates.

## Steering

**Verdict: PASS**

1. **Every human-steering event recorded in `### Steering` under `## Accounting`:** PASS — zero human steering events (no interrupt, redirect, or mid-task correction). Single authorized goal: fix CI failures on main from run 30561239208 (format:check + SettingsRoute IconName) per on-disk plan; agent executed continuously. Empty `### Steering` (`_(none)_`) is correct; no rows to invent.
2. **No non-steering message recorded as steering:** PASS — Accounting has no false-positive steering rows (tool denials and ordinary task messages are not classified as steering).

## Accounting

### Costs

_(populated by governance pre-commit hook)_

### Steering

_(none)_
