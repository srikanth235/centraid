# Receipt — issue #725: testing strategy for the app axis and Photos-derived hoists

This receipt covers the complete #725 strategy scope on PR #723: five testing
layers, the apps × engines grid, the enrichment evidence ladder, the graduated
Photos floor, the shared Photos engines, and the member-visible computation
fixes. No item inside the issue's stated scope is knowingly deferred.

## Checklist

- [x] TESTING.md documents the five layers and the ML evidence tiers; `TESTING.md wins over any suite README` rule (L3) unchanged
- [x] `tests/matrix.json` carries an apps × engines conformance section; `bun run test:matrix` validates every cell references a real conformance gate; structural exclusions render as `skip` with a seat-doctrine citation
- [x] `tools/enrichment-service/src/**` has a coverage floor in `tests/coverage-floors.json` seeded from a measured run, and a matrix owner
- [x] `coverage-scope-reachability` fails on a `tools/*` tree with non-test executable source and no floor/owner/allowlist entry
- [x] Mutation seeds exist for tokenizer/CTC/NMS with floors in `tests/mutation-floors.json` seeded from a measured run
- [x] A scheduled weekly workflow runs the live-model lane: setup downloads pinned weights, golden fixtures assert OCR text / embedding tolerance / face geometry, capability handshake and licence pins checked; failure files a tracking issue on the nightly-SLA terms
- [x] The live lane's report evidence uses an 8-day staleness window and renders grey, never green, when absent
- [x] The scenario × layer template is extracted and referenced from TESTING.md; Photos' table conforms to it unchanged
- [x] `packages/blueprints/apps/photos/**` has its own floor scope; the blended `apps/**` floor now excludes photos and its value is re-seeded from a measured run (down-only exception documented as the approved deviation it is)
- [x] Receipt records any knowingly deferred item

Photos review hoists and divergences are also complete:

- [x] H1 — Triage session model → `_shared/`
- [x] H2 — Selection engine → `_shared`
- [x] H3 — De-duplicate face-crop math
- [x] H4 — Codify the pure-model-beside-the-view convention
- [x] V1 — Web memories consume the vault projection
- [x] V2 — People counts use one shared strict rule
- [x] V3 — The one-computation rule is written into the seat doctrine
- [x] D1 — `media.face_cluster` has a read scope
- [x] D2 — `PhotosPeopleView` uses the strict photograph-count shelf model

## What changed

The acceptance crosswalk is complete: **TESTING.md documents the five layers and the ML evidence tiers; `TESTING.md wins over any suite README` rule (L3) unchanged** in `TESTING.md`; **`tests/matrix.json` carries an apps × engines conformance section; `bun run test:matrix` validates every cell references a real conformance gate; structural exclusions render as `skip` with a seat-doctrine citation** through the matrix schema, validator, and report grid; **`tools/enrichment-service/src/**` has a coverage floor in `tests/coverage-floors.json` seeded from a measured run, and a matrix owner**; and **`coverage-scope-reachability` fails on a `tools/*` tree with non-test executable source and no floor/owner/allowlist entry** through the new governance directive and self-test.

The mutation campaign adds **Mutation seeds exist for tokenizer/CTC/NMS with floors in `tests/mutation-floors.json` seeded from a measured run** (83.00% measured, 80% floor), while the weekly workflow delivers **A scheduled weekly workflow runs the live-model lane: setup downloads pinned weights, golden fixtures assert OCR text / embedding tolerance / face geometry, capability handshake and licence pins checked; failure files a tracking issue on the nightly-SLA terms**. Report generation implements **The live lane's report evidence uses an 8-day staleness window and renders grey, never green, when absent**. The reusable `docs/plans/app-scenario-layer-template.md` and unchanged Photos table satisfy **The scenario × layer template is extracted and referenced from TESTING.md; Photos' table conforms to it unchanged**.

Coverage is measured from the complete 2026-08-08 run (1,065 files, 11,719 passing tests): Photos 46.82% lines / 42.81% branches → floors 44/40; the `_shared` plus seven non-graduated apps blend 22.53% / 16.92% → floors 20/14; enrichment 68.01% / 51.44% → floors 66/49. This is the evidence for **`packages/blueprints/apps/photos/**` has its own floor scope; the blended `apps/**` floor now excludes photos and its value is re-seeded from a measured run (down-only exception documented as the approved deviation it is)**. The floor split is deliberately down-only and recorded in `tests/coverage-floors.json`.

The Photos implementation hoists triage, selection batching/failure isolation, face-crop geometry, and people-count grouping into `_shared`; deletes the mobile/web duplicate modules; makes web Memories consume `media.memory` / `memory_member`; adds the `media.face_cluster` read scope; wires strict distinct-photograph counts into the native People shelf; and records the one-computation rule in `docs/blueprint-seats.md`. The Photos selection contract keeps all five targets present, swaps Trash/Restore and Sharing/Remove from Sharing by shelf, and uses inert handlers for unavailable writes. The enrichment service is now the only model seam, with pinned runtime/model manifests, license verification, golden fixtures, hermetic tests, live-weight tests, and the gateway-only reachability law.

Checklist evidence: H1 — Triage session model → `_shared/`; H2 — Selection engine → `_shared`; H3 — De-duplicate face-crop math; H4 — Codify the pure-model-beside-the-view convention; V1 — Web memories consume the vault projection; V2 — People counts use one shared strict rule; V3 — The one-computation rule is written into the seat doctrine; D1 — `media.face_cluster` has a read scope; D2 — `PhotosPeopleView` uses the strict photograph-count shelf model; and Receipt records any knowingly deferred item in **Out of scope**.

Changed files (the receipt names every changed path for file-coverage auditing):

```text
.github/workflows/ci.yml
.github/workflows/e2e.yml
.github/workflows/enrichment-live-weekly.yml
.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh
.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/constitution.md
.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/directive.yaml
CONSTITUTION.md
README.md
TESTING.md
apps/mobile/src/apps/photos/FaceReview.tsx
apps/mobile/src/apps/photos/PhotoStateView.tsx
apps/mobile/src/apps/photos/PhotosHome.test.tsx
apps/mobile/src/apps/photos/PhotosHome.tsx
apps/mobile/src/apps/photos/PhotosPeopleView.test.tsx
apps/mobile/src/apps/photos/PhotosPeopleView.tsx
apps/mobile/src/apps/photos/PhotosScreen.tsx
apps/mobile/src/apps/photos/PhotosSelectChip.tsx
apps/mobile/src/apps/photos/face-crop.test.ts
apps/mobile/src/apps/photos/face-crop.ts
apps/mobile/src/apps/photos/people-model.ts
apps/mobile/src/apps/photos/photos-selection-writes.ts
apps/mobile/src/apps/photos/photos-selection.test.ts
apps/mobile/src/apps/photos/photos-selection.ts
apps/mobile/src/apps/photos/use-copy-to-sharing.ts
apps/mobile/src/kit/components/SelectChip.tsx
docs/blueprint-seats.md
docs/enrichment-service.md
docs/glossary.md
docs/photos-dogfood.md
docs/plans/app-scenario-layer-template.md
package.json
tests/design-gallery/baselines/mo-advisory-dark.png
packages/blueprints/apps/_shared/consent-gate.test.ts
packages/blueprints/apps/_shared/search-scaffold.test.ts
packages/blueprints/apps/_shared/face-crop.test.ts
packages/blueprints/apps/_shared/face-crop.ts
packages/blueprints/apps/_shared/people-counts.test.ts
packages/blueprints/apps/_shared/people-counts.ts
packages/blueprints/apps/_shared/selection-engine.test.ts
packages/blueprints/apps/_shared/selection-engine.ts
packages/blueprints/apps/_shared/triage-session.test.ts
packages/blueprints/apps/_shared/triage-session.ts
packages/blueprints/apps/photos/app-root.tsx
packages/blueprints/apps/photos/app.json
packages/blueprints/apps/photos/components/FaceReview.tsx
packages/blueprints/apps/photos/components/People.tsx
packages/blueprints/apps/photos/components/SelectionBar.tsx
packages/blueprints/apps/photos/duplicates.tsx
packages/blueprints/apps/photos/face-crop.test.ts
packages/blueprints/apps/photos/face-crop.ts
packages/blueprints/apps/photos/library-store.ts
packages/blueprints/apps/photos/memories.test.ts
packages/blueprints/apps/photos/memories.ts
packages/blueprints/apps/photos/queries/library.ts
packages/blueprints/apps/photos/queries/people.ts
packages/blueprints/apps/photos/selection-actions.ts
packages/blueprints/apps/photos/selection.tsx
packages/blueprints/apps/photos/triage-session.test.ts
packages/blueprints/apps/photos/triage-session.ts
packages/blueprints/apps/photos/types.ts
packages/blueprints/apps/photos/view-copy.ts
packages/blueprints/apps/photos/view-state.ts
packages/blueprints/manifest.json
packages/blueprints/src/blueprint-seats.test.ts
packages/blueprints/src/no-inference-client.test.ts
packages/blueprints/src/one-computation.test.ts
packages/blueprints/src/photos-asset-key.test.ts
packages/blueprints/src/placement-registry.test.ts
scripts/mutation/seeds.mjs
scripts/mutation/run.test.mjs
scripts/test-report/diff-coverage-run.mjs
scripts/test-report/diff-coverage-run.test.mjs
scripts/test-report/diff-coverage.mjs
scripts/test-report/diff-coverage.test.mjs
scripts/test-report/enrichment-live-run.mjs
scripts/test-report/generate.mjs
scripts/test-report/generate.test.mjs
scripts/test-report/validate-matrix.mjs
scripts/test-report/validate-matrix.test.mjs
scripts/test-report/validate-nightly-wiring.mjs
tests/coverage-floors.json
tests/experience-budgets/client-query-counts.json
tests/quality/classification-ratchet.json
tests/matrix.json
tests/matrix.schema.json
tests/mutation-floors.json
tools/enrichment-service/LICENSES.md
tools/enrichment-service/README.md
tools/enrichment-service/fixtures/README.md
tools/enrichment-service/fixtures/model-goldens.json
tools/enrichment-service/fixtures/ocr-golden.svg
tools/enrichment-service/fixtures/opencv-lena.jpg.base64
tools/enrichment-service/models.lock.json
tools/enrichment-service/package.json
tools/enrichment-service/runtime/package.json
tools/enrichment-service/ort-types.d.ts
tools/enrichment-service/setup.ts
tools/enrichment-service/src/capabilities/embed.ts
tools/enrichment-service/src/capabilities/faces.ts
tools/enrichment-service/src/capabilities/ocr.ts
tools/enrichment-service/src/capabilities/registry.ts
tools/enrichment-service/src/config.ts
tools/enrichment-service/src/face-geometry.test.ts
tools/enrichment-service/src/face-geometry.ts
tools/enrichment-service/src/model-goldens.live.test.ts
tools/enrichment-service/src/models-lock.test.ts
tools/enrichment-service/src/onnx.test.ts
tools/enrichment-service/src/onnx.ts
tools/enrichment-service/src/preprocess.test.ts
tools/enrichment-service/src/preprocess.ts
tools/enrichment-service/src/server.test.ts
tools/enrichment-service/stryker.config.mjs
tools/enrichment-service/vitest.config.ts
tools/enrichment-service/vitest.live.config.ts
tools/enrichment-service/vitest.mutation.config.ts
packages/vault/src/enrich/face-clusters.test.ts
vitest.config.ts
```

### Inherited #721/#724 paths covered by their receipts

The governance file-coverage rule evaluates the cumulative branch because this
receipt is the newly added anchor. These paths belong to the already-receipted
#721/#724 implementation commits; they are named here so that the #725 receipt
does not silently omit an inherited path from the branch-wide audit:

```text
apps/desktop/src/main/ipc-core.test.ts
apps/desktop/src/main/ipc-core.ts
apps/desktop/src/main/ipc.ts
apps/desktop/src/main/preload-core.test.ts
apps/desktop/src/main/preload-core.ts
apps/mobile/App.tsx
apps/mobile/src/apps/photos/CameraRollImportOffer.tsx
apps/mobile/src/apps/photos/MediaPage.tsx
apps/mobile/src/apps/photos/PhotoEditor.test.tsx
apps/mobile/src/apps/photos/PhotoEditor.tsx
apps/mobile/src/apps/photos/PhotoLightbox.styles.ts
apps/mobile/src/apps/photos/camera-roll-import.test.ts
apps/mobile/src/apps/photos/memories-model.ts
apps/mobile/src/apps/photos/people-model.test.ts
apps/mobile/src/apps/photos/photo-edit-model.test.ts
apps/mobile/src/apps/photos/photo-edit-model.ts
apps/mobile/src/apps/photos/photos-library-menu.test.ts
apps/mobile/src/apps/photos/video-scrub-strip.test.ts
apps/mobile/src/apps/photos/video-scrub-strip.ts
apps/mobile/src/lib/upload/media-producer.ts
packages/client/src/centraid-api.d.ts
packages/client/src/device-enrichment-compute.ts
packages/client/src/device-enrichment-worker.test.ts
packages/client/src/gateway-client-capture.contract.test.ts
packages/client/src/gateway-client-capture.ts
packages/client/src/gateway-client-seam-fixtures.ts
packages/gateway/src/enrich/capability-sweep.test.ts
packages/gateway/src/enrich/embedding-sweep.ts
packages/gateway/src/routes/capture-routes.ts
packages/gateway/src/routes/device-work-routes.test.ts
packages/vault/src/enrich/clusters.ts
packages/vault/src/enrich/leases.test.ts
packages/vault/src/enrich/leases.ts
packages/vault/src/gateway/duties.ts
packages/vault/src/gateway/gateway.ts
packages/vault/src/schema/atlas.ts
packages/vault/src/schema/blob.ts
packages/vault/src/schema/poly-refs.ts
packages/vault/src/schema/tables.ts
tools/enrichment-service/.gitignore
tools/enrichment-service/src/capabilities/embed.test.ts
tools/enrichment-service/src/capabilities/ocr.test.ts
tools/enrichment-service/src/capabilities/transcript.test.ts
tools/enrichment-service/src/capabilities/transcript.ts
tools/enrichment-service/src/config.test.ts
tools/enrichment-service/src/ctc.test.ts
tools/enrichment-service/src/ctc.ts
tools/enrichment-service/src/image-geometry.test.ts
tools/enrichment-service/src/image-geometry.ts
tools/enrichment-service/src/nms.test.ts
tools/enrichment-service/src/nms.ts
tools/enrichment-service/src/ocr-postprocess.test.ts
tools/enrichment-service/src/ocr-postprocess.ts
tools/enrichment-service/src/server.ts
tools/enrichment-service/src/tokenizer.test.ts
tools/enrichment-service/src/tokenizer.ts
tools/enrichment-service/src/types.ts
tools/enrichment-service/tsconfig.json
```

## Out of scope

The receipt records only the issue's explicit out-of-scope work: the seven remaining apps' scenario × layer tables and their future floor graduation issues; splitting floors for apps that have not graduated; model-quality benchmarks; the accessibility and bundle-weight lanes (#587 D21); and any PR wall-clock budget change. The issue's separate deliberate deferrals also remain explicit: bulk staged import over HTTP, auto-enhance pending a native pixel-buffer decision, region-level OCR UI, the screenshot classifier, face merge/split management beyond naming and merge-into-existing, and the #717 mobile offline reliability journey. None of these is silently represented as a completed #725 acceptance item, and no in-scope #725 work is knowingly deferred.

## Decisions

- The remaining blueprint floor uses one brace glob over `_shared` and the seven non-graduated apps, because the issue requires a blend that excludes Photos while retaining one ratchet owner. Vitest's threshold matcher and the reachability directive both resolve this exact scope.
- The floor reseed uses the complete local v8 run and a conservative two-point margin for Photos/blend plus a three-point margin for enrichment branches. The down-only comparison against the old 17/12 blend is explicitly approved in `tests/coverage-floors.json`.
- The weekly live lane caches the pinned native runtime and weights, but never makes model quality a PR gate. Its golden checks prove tensor layout, preprocessing, capability handshake, and licensing; quality judgment stays in the documented dogfood ritual.
- The isolated `photos-asset-key` harness now mirrors the production `_shared` dependency under its temporary root. This preserves the byte-identical-copy contract without leaving a shared temporary sibling or weakening the test.
- #725 app-axis rebase: Photos now consumes seven bounded face-cluster and memory reads on first paint; Atlas counts the four newly registered media tables. Measured baselines are approved without adding an HTTP request.
- The dark native advisory gallery baseline is refreshed to match the existing Binding Layer ramp shipped by the PR base; the source design contract is unchanged by #725, but the stale baseline otherwise blocks the required gallery gate.
- The full type-aware lint gate surfaced a pre-existing unordered `Map` assertion in the vault face-cluster test; its comparator is now explicit so the repository gate remains deterministic. This is gate hygiene, not a change to the #725 product scope.
- The repository-wide suppression gate also required the pre-existing enrichment-service ambient declaration's class-count suppression to name its owning issue; the line now carries `#724` without changing runtime behavior.
- The active README device-ASR paragraph was stale after #724's deletion. It now points operators at `CENTRAID_ENRICH_URL`; the legacy `CENTRAID_DEVICE_ASR_*` names remain only in `CHANGELOG.md`/migration docs, where #724 requires the historical migration record. This is gate hygiene, not a new product path.

## Verification

```sh
bun run coverage
# 1,065 test files passed, 4 skipped; 11,719 tests passed, 36 skipped.
# v8: repository lines 66.18%; Photos 46.82/42.81; blend 22.53/16.92; enrichment 68.01/51.44.
bun run test:matrix
bun run test:report:smoke
bun run lint:law-registry
bun run test:governance-shell
bun run test:enrich:live
bun run test:mutation:pr
bun run check:diff-coverage:full
bun run format:check
bun run typecheck
bun run lint
bun run knip
```

## Steering

- Every human-steering event in this session is recorded: PASS — there were no interrupts or corrections after the initial issue task; the later “continue” message resumed the same requested work and did not redirect it.
- No non-steering message is recorded: PASS — status questions, tool output, approvals, and ordinary continuation context are not steering events.

## Audit

PASS — Fresh-context audit of issue #725, the worktree, and this receipt agrees:
all 10 acceptance checks plus H1–H4/V1–V3/D1–D2 are implemented; the matrix
has 48/48 app × engine cells (21 pass, 27 cited structural skips); the receipt
changed-file list covers every current path (the receipt itself is intentionally
excluded); and the matrix, report, live-model, and mutation evidence are green.
No in-scope deferral was found. The unrelated mode-only `fake-acp-agent.mjs`
change was restored before audit completion.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fdd23-464-1786176976-1 | codex | 019fdd23-4641-7621-a55c-7d00e0199116 | #725 | gpt-5.6-luna | 2357819 | 0 | 92277504 | 184000 | 2541819 | 31.7239 | 2357819 | 0 | 92277504 | 184000 | refactor(governance): reach coverage into tool source (#725) -m Add a reachabili |
| codex-019fdd23-464-1786178116-1 | codex | 019fdd23-4641-7621-a55c-7d00e0199116 | #725 | gpt-5.6-luna | 145889 | 0 | 16267264 | 18241 | 164130 | 4.7052 | 2503708 | 0 | 108544768 | 202241 | feat(testing): complete app-axis and ML evidence strategy (#725) -m Implement th |
| codex-019fdd23-464-1786178225-1 | codex | 019fdd23-4641-7621-a55c-7d00e0199116 | #725 | gpt-5.6-luna | 9624 | 0 | 2448640 | 1563 | 11187 | 0.6597 | 2513332 | 0 | 110993408 | 203804 | feat(testing): complete app-axis and ML evidence strategy (#725) -m Implement th |
| codex-019fdd23-464-1786178430-1 | codex | 019fdd23-4641-7621-a55c-7d00e0199116 | #725 | gpt-5.6-luna | 37735 | 0 | 2335488 | 1979 | 39714 | 0.7079 | 2551067 | 0 | 113328896 | 205783 | feat(testing): complete app-axis and ML evidence strategy (#725) -m Implement th |
| codex-019fdd23-464-1786178596-1 | codex | 019fdd23-4641-7621-a55c-7d00e0199116 | #725 | gpt-5.6-luna | 19697 | 0 | 830208 | 2243 | 21940 | 0.2904 | 2570764 | 0 | 114159104 | 208026 |  |
