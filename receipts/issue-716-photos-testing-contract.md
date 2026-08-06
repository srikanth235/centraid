# Issue #716 — Photos testing contract

Issue: [#716](https://github.com/srikanth235/centraid/issues/716)

## Checklist

- [x] **A: RNTL-on-vitest spike + decision doc** (port `PhotosHome.test.tsx`, measure cost, write the mock-boundary policy)
- [x] **B1: deterministic Photos seeding in the agent-e2e harness**
- [x] **B2: the five Photos Maestro flows** (can split library+viewer / search / write+permissions)
- [x] **C: fill the ❌ component-test rows** (drawer state machine, Select a11y, viewer chrome, search empty states)
- [x] **Docs:** add the contract table to TESTING.md (or a `docs/` page it links), so the layer-assignment rule outlives this issue

## Decisions

- Chose RNTL 13.3.3 on Vitest. The initial 4.32 s spike was 2.88x the old jsdom file by shell wall time and 3.69x by Vitest duration. One consolidated RN-host contract file earns the extra transform/renderer cost by observing accessibility, responder, and host geometry semantics unavailable in jsdom; the final eleven-case run took 5.7 s wall / 4.15 s Vitest / 528 ms test-body time.
- Kept recognizer layering exclusively in Maestro. RNGH's test mock can invoke callbacks but cannot reproduce recognizer precedence against a sibling—the defect class that motivated #716.
- Split refused-permission ownership by actual data state. Pure predicates prove seeded-vault continuity, while the component and native contracts prove the literal empty-vault takeover and recovery action. The native permission journey runs first, explicitly purges the Photos demo corpus, pairs against the empty vault, and leaves Home reachable; the next journey seeds the shared gateway.
- Filed [#717](https://github.com/srikanth235/centraid/issues/717) for offline write/reconnect replay because that contract needs host network control and belongs to the broader replica reliability lane, not a sixth Photos UI flow.
- The select/write journey exposed a production gateway bug: a cached app-worker bridge deferred execution until after its request AsyncLocalStorage scopes had unwound. The bridge now captures existing vault/replica-intent scopes and re-enters them for the callback while preserving dynamic resolution for bridges constructed without a scope.

## What changed

- **A: RNTL-on-vitest spike + decision doc** (port `PhotosHome.test.tsx`, measure cost, write the mock-boundary policy) — `PhotosHome.test.tsx` now contains eleven scenario-level RNTL tests on the existing Vitest runner, including a real `PhotosHome` empty-library render; `docs/plans/photos-testing.md` records the measured renderer cost, >3x initial Vitest-duration justification, runtime-seam mock boundary, RNGH limitation, fixture contract, and closure evidence.
- The mobile Vitest definition exports its standard and RN-transform projects for direct composition by the repository coverage configs. The scoped diff-coverage runner expands the mobile package to both concrete project names, so the RNTL file receives the same transform in focused, PR, and full-coverage lanes.
- **B1: deterministic Photos seeding in the agent-e2e harness** — the Photos scenario now has 19 byte-bearing assets spanning at least three months and two years, one video, one named album/place corpus, and two named people. `ctx.ensureDemo()` idempotently loads it before the initial replica clone.
- **B2: the five Photos Maestro flows** (can split library+viewer / search / write+permissions) — library, viewer, search, select/write, and permissions each have prose plus executable journeys. `run-photos-suite.mjs` shares one gateway and paired profile, preserves independent verdicts, and fails at eight minutes or more. Assertions cover real drawer hit testing, left/right photograph swipes, every supported viewer capability row, a non-zero native search result count, trash/restore writes, and denied OS permission over an explicitly empty vault.
- **C: fill the ❌ component-test rows** (drawer state machine, Select a11y, viewer chrome, search empty states) — the consolidated component contract covers the real Home empty-library state, drawer state machine, scrub rail geometry, loading geometry, Select word/role/disabled state, distinct resting/no-hits search states, interactive viewer mode chrome and filmstrip selection, collection shelf empty/collapsed states, and refused-permission takeover.
- **Docs: add the contract table to TESTING.md (or a `docs/` page it links), so the layer-assignment rule outlives this issue** — `TESTING.md` carries the scenario × U/C/E ownership table and links the durable decision record, flow budget, and #717. The harness docs now state Maestro is the sole native journey layer rather than promising Detox.
- The native trash/restore run found and verified the replica-intent scope fix. `QUALITY.md` records the resolved defect and the focused gateway test proves a deferred worker callback sees the originating vault and intent.

### Files covered by this receipt

- Workflow, package, and lock configuration: `.github/workflows/e2e.yml`, `apps/mobile/package.json`, `apps/mobile/vitest.config.ts`, `apps/mobile/vitest.projects.ts`, `bun.lock`, and `vitest.config.ts`.
- Repository contract and decision records: `QUALITY.md`, `TESTING.md`, and `docs/plans/photos-testing.md`.
- RN test runtime: `apps/mobile/src/test/babel-register.d.ts` and `apps/mobile/src/test/react-native-setup.ts`.
- Photos component/test corpus: `apps/mobile/src/apps/photos/CollectionShelfBody.tsx`, `apps/mobile/src/apps/photos/PhotoStateView.tsx`, `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx`, `apps/mobile/src/apps/photos/PhotosHome.styles.ts`, `apps/mobile/src/apps/photos/PhotosHome.test.tsx`, `apps/mobile/src/apps/photos/PhotosHome.tsx`, `apps/mobile/src/apps/photos/PhotosSearch.tsx`, `apps/mobile/src/apps/photos/PhotosSearchEmptyState.tsx`, `apps/mobile/src/apps/photos/PhotosSearchRestingState.tsx`, `apps/mobile/src/apps/photos/PhotosSelectChip.tsx`, `apps/mobile/src/apps/photos/photos-fixtures.ts`, and `apps/mobile/src/apps/photos/timeline-model.test.ts`.
- Existing conformance remediation surfaced by the PR mirror: `apps/mobile/src/apps/photos/FaceReview.tsx` now explains why the naming control is disabled while review is busy or no named person exists.
- Mobile shell stability needed by the current PR's first-run path: `apps/mobile/src/screens/Onboarding.tsx`, `apps/mobile/src/screens/Onboarding.test.tsx`, `apps/mobile/src/screens/onboarding-styles.ts`, and `apps/mobile/src/screens/home/HomeStatusLine.tsx`.
- Deterministic scenario and real bridge regression: `packages/blueprints/apps/photos/seed.js`, `packages/gateway/src/serve/demo-seed.test.ts`, `packages/gateway/src/serve/vault-registry.ts`, and `packages/gateway/src/serve/vault-registry.test.ts`.
- Harness wiring and existing-flow compatibility: `apps/mobile/scripts/android-emulator-e2e.sh`, `tests/agent-e2e-mobile/AGENTS.md`, `tests/agent-e2e-mobile/README.md`, `tests/agent-e2e-mobile/lib/harness.mjs`, `tests/agent-e2e-mobile/flows/home-loads.md`, `tests/agent-e2e-mobile/flows/home-loads.mjs`, and `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`.
- Test-report and schema ratchets surfaced by the full PR mirror: `scripts/test-report/diff-coverage-run.mjs` and `scripts/test-report/diff-coverage-run.test.mjs` preserve the separate mobile RN project in scoped coverage; `tests/matrix.json` maps all five new verdict owners; `tests/quality/classification-ratchet.json` fingerprints that reviewed inventory change; and `tests/schema-export-fingerprint.json` records the already-documented `review_state` export audit.
- Photos device contract: `tests/agent-e2e-mobile/flows/photos-budget.md`, `tests/agent-e2e-mobile/flows/photos-library.md`, `tests/agent-e2e-mobile/flows/photos-library.mjs`, `tests/agent-e2e-mobile/flows/photos-viewer.md`, `tests/agent-e2e-mobile/flows/photos-viewer.mjs`, `tests/agent-e2e-mobile/flows/photos-search.md`, `tests/agent-e2e-mobile/flows/photos-search.mjs`, `tests/agent-e2e-mobile/flows/photos-select-write.md`, `tests/agent-e2e-mobile/flows/photos-select-write.mjs`, `tests/agent-e2e-mobile/flows/photos-permissions.md`, `tests/agent-e2e-mobile/flows/photos-permissions.mjs`, and `tests/agent-e2e-mobile/run-photos-suite.mjs`.

## Out of scope

- #717's host-controlled offline write/reconnect implementation remains a named follow-up; only its issue and ownership link are part of this change.
- Two consecutive nightly green runs cannot be manufactured from local evidence. The implementation can update PR #715, but #716 must remain open until two real scheduled workflow runs pass and their URLs are recorded on the issue.
- No screenshot/pixel oracle, per-PR simulator lane, mobile UI line-percentage gate, second unit runner, or second native runner was added.

## Verification

Focused RN component/unit and package type evidence:

```sh
bun run --filter=@centraid/mobile test -- src/apps/photos/PhotosHome.test.tsx src/apps/photos/timeline-model.test.ts
bun run --filter=@centraid/mobile typecheck
```

Result: `PhotosHome.test.tsx` passed all 11 RNTL cases in 4.15 s Vitest / 5.7 s wall; the full mobile package and typecheck are included in the repository mirror below.

Real demo/bridge evidence and gateway types:

```sh
bun run --filter=@centraid/gateway test -- src/serve/vault-registry.test.ts src/serve/demo-seed.test.ts
bun run --filter=@centraid/gateway typecheck
```

Result: 2 files, 17 tests passed in 11.43 s; gateway typecheck passed.

Harness structural gate:

```sh
bun run lint:e2e-flows
```

Result: 46 Maestro steps across 7 files, no vacuous assertions.

Device evidence against an isolated gateway/data directory, Metro bundle, and iPhone 17 Pro simulator:

```sh
MAESTRO_GATEWAY_URL=http://127.0.0.1:18789 \
  MAESTRO_PLATFORM=ios \
  node tests/agent-e2e-mobile/run-photos-suite.mjs
```

Result: all five flows passed in one 366-second aggregate run, below the 480-second hard budget. Individual verdicts were permissions 139.971 s, library 55.412 s, viewer 48.963 s, search 57.251 s, and select/write 60.475 s. The run began from a fresh pairing against an explicitly purged Photos corpus, then seeded and synchronized the shared profile for the remaining journeys.

The corrected scoped repository coverage aggregate passed 792 files (plus one skipped), 7,824 tests (plus seven skipped), and scored 89.0% diff coverage (3,916/4,402):

```sh
bun run check:diff-coverage
```

Final repository mirror:

```sh
bun run check:pr
```

Result: passed. All 39 push gates, repository typechecks, type-aware lint, workflow-pin lint, 792 test files (plus one skipped), 7,824 tests (plus seven skipped), and 89.0% diff coverage were green.

## Audit

**Verdict: PASS.** The substantive and branch-wide receipt audits remain valid. A fresh-context final audit additionally confirmed all eight file-size waivers use supported first-10-line syntax, are truthful and path-specific, and cover cohesive legacy #712/#716 orchestration for which decomposition would be unrelated and risky in this CI-fix commit. The waiver-only delta is behavior-neutral; both receipts remain shape-waiver-free, and the direct `repo-hygiene`, `no-unjustified-suppressions`, and `receipt-per-issue` checks pass.

## Steering

**Verdict: PASS.** The human message was the initial task specification, not a mid-task correction or redirect. No steering row is required.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fd642-e7c-1786052394-1 | codex | 019fd642-e7c5-7c51-983a-10ddd72c2c1c | #716 | gpt-5.6-sol | 3294288 | 0 | 134928640 | 226296 | 3520584 | 45.3623 | 3632606 | 0 | 142991360 | 253751 | test(mobile): establish Photos testing contract (#716) |
| codex-019fd642-e7c-1786053516-1 | codex | 019fd642-e7c5-7c51-983a-10ddd72c2c1c | #716 | gpt-5.6-sol | 81799 | 0 | 6858496 | 10581 | 92380 | 2.0778 | 3714405 | 0 | 149849856 | 264332 | test(mobile): establish Photos testing contract (#716) -m governance: allow-tool |
| codex-019fd642-e7c-1786053838-1 | codex | 019fd642-e7c5-7c51-983a-10ddd72c2c1c | #716 | gpt-5.6-sol | 21796 | 0 | 2754304 | 3975 | 25771 | 0.8027 | 3736201 | 0 | 152604160 | 268307 | test(mobile): establish Photos testing contract (#716) -m governance: allow-tool |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
