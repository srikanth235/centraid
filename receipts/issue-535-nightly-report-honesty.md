# Receipt: issue #535 — nightly report honesty

## Checklist

- [x] Phase 1 — dual-path uploads fixed (5 jobs) + Playwright JSON at repo-root `artifacts/`; local layout fixture
- [x] Phase 2 — template-gate matrix owner; non-short-circuit mobile flows; unmappedEvidence / job recon / cellsMissing ratchet + unit tests
- [x] Phase 3 — android-emulator-runner repinned to valid v2.38.0 SHA; main-slot per-push banner + nightly link
- [x] Phase 4 — Settings journey asserts "Gateway link"; `_comment` filtered from coverage; per-lane `lane-starts-*.json`
- [x] Phase 5 — validate-matrix skip-note rule; all skips have notes; coverable-today suites (11 cells) flipped off skip
- [x] Receipt, Conventional Commits `(#535)`, `check:pr`, PR
- [x] Follow-up — PR CI green: coverage ≥71% (no floor lower), desktop e2e 8.2 Retry thrash fix

## What changed

### Phase 1 — dual-path uploads fixed (5 jobs) + Playwright JSON at repo-root `artifacts/`; local layout fixture

- `.github/workflows/e2e.yml` — `mobile-e2e`, `mobile-e2e-android`, `pairing-lifecycle`, `pairing-ticket-hygiene`, `pairing-cross-network-relay` upload only `artifacts/` for `nightly-evidence-*`; debug runs go to separate `nightly-debug-*` artifacts (no LCA double-nest after merge-multiple).
- `scripts/test-report/prepare.mjs` — always resolves monorepo root so lane prepare from `apps/*` still writes repo-root `artifacts/`.
- `apps/desktop/tests/e2e/playwright.config.ts` — JSON reporter → repo-root `artifacts/test-results/desktop-playwright.json`.
- `apps/web/tests/e2e/playwright.config.ts` — JSON reporter → repo-root `artifacts/test-results/web-playwright.json`.

### Phase 2 — template-gate matrix owner; non-short-circuit mobile flows; unmappedEvidence / job recon / cellsMissing ratchet + unit tests

- `tests/matrix.json` — flow `mobile-template-gate` owns `tests/agent-e2e-mobile/flows/template-gate.mjs` on `mobile.journey`.
- `.github/workflows/e2e.yml` — mobile iOS journeys run all three flows with aggregate exit (no `set -e` short-circuit); report job writes `artifacts/test-results/job-conclusions.json` from `needs`.
- `scripts/test-report/report-signals.mjs` — `findUnmappedEvidence`, `reconcileJobConclusions`, `cellsMissingRatchet`, `filterFloorConfigEntries`, `mergeLaneMarkers`, `collectRegisteredOwners`.
- `scripts/test-report/report-signals.test.mjs` — unit coverage for those helpers + validate-matrix skip-note rule.
- `scripts/test-report/generate.mjs` — wires honesty into summary/HTML banners/exit codes; multi-file lane-start merge; main-scope cellsMissing fail skip.

### Phase 3 — android-emulator-runner repinned to valid v2.38.0 SHA; main-slot per-push banner + nightly link

- `.github/workflows/e2e.yml` — `reactivecircus/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d` (v2.38.0) replaces orphan SHA.
- `.github/workflows/ci.yml` — `TEST_REPORT_SCOPE: main` on generate.
- `scripts/test-report/prepare-pages-site.mjs` — `ensureMainScopeBanner` injects per-push banner + `/test-report/nightly/` link for main slot.
- `scripts/test-report/generate.mjs` — renders main-scope banner when `TEST_REPORT_SCOPE=main` / `--scope main`.

### Phase 4 — Settings journey asserts "Gateway link"; `_comment` filtered from coverage; per-lane `lane-starts-*.json`

- `tests/agent-e2e-mobile/lib/harness.mjs` — Settings identity assert is **Gateway link**.
- `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs` — same string.
- `tests/agent-e2e-mobile/README.md` — docs updated.
- `scripts/test-report/prepare.mjs` — per-lane `lane-starts-<lane>.json` (no merge last-write-win).
- `scripts/test-report/generate.mjs` + `report-signals.mjs` — `filterFloorConfigEntries` drops `_comment` from coverage rows.

### Phase 5 — validate-matrix skip-note rule; all skips have notes; coverable-today suites (11 cells) flipped off skip

- `scripts/test-report/validate-matrix.mjs` — every `skip` cell must have a non-empty `matrix.notes` rationale.
- `tests/matrix.json` — all remaining skips noted; coverable-today cells flipped to `partial` with owners:
  - `packages/agent-runtime/src/matrix-contracts.test.ts`
  - `packages/agent-runtime/src/matrix-durability.test.ts`
  - `packages/agent-runtime/src/matrix-concurrency.test.ts`
  - `packages/blueprints/src/matrix-contracts.test.ts`
  - `packages/blueprints/src/matrix-durability.test.ts`
  - `packages/blueprints/src/matrix-concurrency.test.ts`
  - `apps/desktop/src/main/matrix-contracts.test.ts`
  - `apps/desktop/src/main/matrix-durability.test.ts`
  - `apps/desktop/src/main/matrix-concurrency.test.ts`
  - `apps/web/src/matrix-contracts.test.ts`
  - `apps/web/src/matrix-durability.test.ts`

### Receipt, Conventional Commits `(#535)`, `check:pr`, PR

- `receipts/issue-535-nightly-report-honesty.md` (this receipt)
- Commit subject suffix `(#535)`; PR links #535

### Follow-up — PR CI green: coverage ≥71% (no floor lower), desktop e2e 8.2 Retry thrash fix

- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx` — `loadData` via ref so parent identity churn does not remount the load effect (Retry no longer detaches mid-click).
- `packages/client/src/react/shell/routes/AutomationsRoute.tsx` — stable `useCallback` for `loadData` / `useSuggestion`.
- `packages/client/src/react/screens/AutomationsOverviewScreen.test.tsx` — unit proof that swapping `loadData` identity does not auto-refetch; Retry still uses latest.
- `apps/desktop/tests/e2e/automations.spec.ts` — settle error card before rewiring mock + click Retry.
- Coverage lift (floors untouched): `packages/vault/src/replica/doorbell.test.ts`, `packages/automation/src/manifest/manifest-output.test.ts`, `packages/automation/src/scaffold/webhook.test.ts` (route handler + secret helpers), `packages/gateway/src/routes/blob-route-errors.test.ts`.

## Out of scope

- Decomposing `generate.mjs` past the existing file-size waiver.
- Changing per-PR CI gate policy beyond matrix validation already on the static path.
- Building Maestro on-device perf/scale measurement rigs (Phase 5 uses dependency-naming notes).
- Full live nightly e2e green in this sandbox (post-merge SLA).

## Verification

```sh
bun run test:ratchet:unit
# report-signals honesty + skip-note validateMatrix tests pass

bun run test:matrix
# matrix + nightly wiring green (template-gate flow + skip notes)

bun run test:report:smoke
# generator smoke ok

bun run --filter @centraid/agent-runtime test -- src/matrix-
bun run --filter @centraid/blueprints test -- src/matrix-
bun run --filter @centraid/desktop test -- src/main/matrix-
bun run --filter @centraid/web test -- src/matrix-
# coverable-today suites green

# Fixture: single-root transport sees e2e + *-playwright.json; nested artifacts/artifacts/e2e is invisible
# Fixture: orphaned failed e2e → generate exit 1 + unmappedEvidence
# Fixture: needs job failure + failed:0 → silentAllClear + exit 1
# Fixture: cellsMissing rise vs durable history → exit 1 (non-main)

bun run check:pr
# format/lint/typecheck/matrix/ratchet/affected green

bun run --cwd packages/client test -- src/react/screens/AutomationsOverviewScreen.test.tsx
# Retry identity-stability unit test green

bun run --cwd packages/vault test -- src/replica/doorbell.test.ts
bun run --cwd packages/automation test -- src/manifest/manifest-output.test.ts
bun run --cwd packages/automation test -- src/scaffold/webhook.test.ts
bun run --cwd packages/gateway test -- src/routes/blob-route-errors.test.ts
# coverage-lift units green

bun run coverage
# lines ≥ 71% global; package floors (incl. automation branches) hold — floors not lowered
```

## Decisions

- Prefer single-root evidence uploads + separate debug artifacts over teaching generate to walk nested LCA trees.
- `cellsMissing` ratchet **fails** full/nightly generate but only **warns** on main scope (structurally greyer per-push slot).
- Phase 5 coverable-today gets real owned suites; remaining skips get reviewed dependency/delegation notes rather than tautological tests.
- Journey string follows intentional UI: Settings shows **Gateway link** (post-#498), not restore "Desktop link".

## Audit

Verdict: PASS

Evidence:
1. What changed: Receipt prose maps cleanly onto the working tree for issue #535 (branch `fix/535-nightly-report-honesty`). Paths present and aligned for the original phases (transport, honesty helpers, Android pin, main-slot banner, Gateway link, skip notes + coverable-today suites) plus the PR-green follow-up:
   - Retry thrash: `AutomationsOverviewScreen.tsx` (`loadDataRef` + stable `reload`), `AutomationsRoute.tsx` (`useCallback` loadData), unit test for identity swap, e2e 8.2 settle-before-click.
   - Coverage lift (no floor edits): `doorbell.test.ts`, `manifest-output.test.ts`, expanded `webhook.test.ts`, `blob-route-errors.test.ts`.
2. Checklist realization:
   - [x] Phases 1–5 — as previously audited against `e2e.yml` / `test-report/*` / `matrix.json` / matrix suites.
   - [x] Receipt / Conventional Commits / check:pr / PR — receipt present; follow-up commit documents CI green work under `(#535)`.
   - [x] Follow-up PR green — product Retry fix + coverage tests listed above; `tests/coverage-floors.json` not lowered.
3. Checklist mirrors #535 acceptance plus the green-PR goal (verify lines ≥71%, desktop-e2e 8.2). Live full Electron e2e remains Actions-proven after push.

## Steering

Verdict: PASS

No human steering events (interrupt or mid-task correction) for the PR-green follow-up. Goal authorization was for green PR build on #536. No rows to append to the accounting ledger.

## Accounting

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
