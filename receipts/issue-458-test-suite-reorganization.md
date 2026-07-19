# Issue #458 — Test suite reorganization

GitHub issue: [#458](https://github.com/srikanth235/centraid/issues/458)

The suite now expresses the current product as a machine-readable quality
matrix, gives the load-bearing invariants named contract homes, applies
ratchet-only coverage gates to vault/backup/client-replica, shares its test
infrastructure through `@centraid/test-kit`, and has distinct per-PR,
performance, scale, Playwright, mobile, and pairing lanes. Every lane can feed
one self-contained HTML health report whose missing evidence remains visible.

## Checklist

### Phase 1 — Mechanical hygiene

- [x] Pin `pool: 'forks'` explicitly in every node-env vitest config; delete the prose comments hoping the default holds
- [x] Pick **one** integration marker (`*.integration.test.ts`) and rename the `.e2e.test.ts` / `-e2e.test.ts` files to it; `.spec.ts` stays Playwright-only; fold `.property.test.ts` into the normal convention
- [x] Wire the web PWA Playwright suite into nightly `e2e.yml`; wire the two orphaned pairing flows into `pairing-relay-e2e.yml`
- [x] Correct TESTING.md's Maestro claim (see Phase 6 decision)
- [x] Make local `bun run test` at least report the coverage floors so the CI gate isn't a surprise

### Phase 2 — Re-tier the coverage gates

- [x] Measure vault / client / backup coverage; seed ratchet-only-up floors a tight margin below measured (same procedure as the original five)
- [x] Split the client gate: `packages/client/src/replica/**` gated toward the 80/70 band; `src/react/**` screens follow the renderer rule (logic-units + e2e, no line gate)
- [x] Drop the whole-package 30s timeouts in mobile/tunnel/backup; slow tests get per-file timeouts or the `.integration.test.ts` marker

### Phase 3 — `packages/test-kit`

- [x] `tempDir()` helper with auto-cleanup (kills the 148-site duplication)
- [x] Fake-clock helper
- [x] `createTestVault()` / `buildTestGateway()` factories
- [x] Mock-LLM harness lifted out of automation
- [x] Two shared vitest presets (`node`, `jsdom+jsx+css-modules`) that package configs extend
- [x] **Volume fixture generator** — deterministic synthetic big-vault builder (N parties/photos/conversations, synthetic blob sets) used by the Phase 8 scale lane and by any test that needs realistic volume

### Phase 4 — Flow catalog + machine-readable test matrix

- [x] Enumerate the canonical **important app flows** per surface (this is the "what must work" list — kept deliberately short)
- [x] Each matrix cell maps to its **owning** test file(s)/spec(s) and tier — one owner per flow
- [x] Verify/correct every seeded cell mark above while wiring it
- [x] Generator (Phase 9) fails/greys any cell whose owning test file no longer exists — rotted tests become visible, not silent
- [x] Review rule: a new test either claims an unowned cell/flow or extends an owner; duplicate owners are merged

### Phase 5 — Named invariant contract suites

- [x] Promote the ranked invariants above to explicitly-marked executable contracts (`*.contract.test.ts` or `contracts/` dir per package), listed by name in TESTING.md and referenced from the matrix's Contract column
- [x] Mostly renaming + gap-filling — the marker tells refactoring agents these encode product law, and CI can require contract files never shrink
- [x] Property-based tests for the two best candidates: blob custody and replica intent idempotency (the mobile upload crash test prototyped the pattern)
- [x] Priority gap-fill from the matrix's Concurrency column: replica multi-tab / multi-writer idempotency (the #406-review high)

### Phase 6 — One e2e system per surface

- [x] **Desktop:** Playwright `_electron` is the system. Port unique assertions from the 4 desktop agent-e2e flows into specs; retire those flows — net e2e runtime goes *down*
- [x] Re-scope `tests/agent-e2e*` explicitly as exploratory manual-QA harnesses (which is what they genuinely are); merge the three `harness.mjs` files into one shared lib
- [x] **Web:** the existing Playwright suite, now actually running nightly (Phase 1)
- [x] **Mobile:** amend TESTING.md to bless the agent-e2e-mobile flows as the mobile e2e layer and wire them into nightly CI; drop Maestro from the doc until Maestro flows actually exist
- [x] **Pairing:** keep as-is, all three flows nightly (Phase 1)

### Phase 7 — Performance lane

- [x] Blob egress: TTFB + peak-memory ceiling on large-blob streaming (catches the buffer-whole-file class)
- [x] Vault write path: fsyncs-per-write / write latency budget
- [x] Replica bootstrap wall-clock at fixed N (from the Phase 3 volume fixture)
- [x] Gateway request latency + idle CPU on the low-end profile
- [x] Mobile fast-path: make the existing #404 budgets actually gate the nightly lane
- [x] Tunnel throughput floor
- [x] Results emit JSON consumed by the Phase 9 report (trend over time)

### Phase 8 — Scalability lane

- [x] Backup → restore round-trip on a big vault (the ❌ that hurts most if wrong)
- [x] Replica windowed bootstrap + convergence at volume (deletion-leak class)
- [x] Conversation-ledger digest→archive→prune over years-of-history fixture
- [x] Blob eviction/GC over a large CAS with mixed custody states
- [x] Atlas/Browse query behavior on a 10k-entity ontology

### Phase 9 — Unified HTML test report

- [x] `scripts/test-report/` generator (plain node, same style as the docs-site build): ingests vitest JSON + `coverage/coverage-summary.json`, Playwright JSON results, perf/scale lane JSON, and the Phase 4 matrix manifest → emits `dist/test-report/index.html`
- [x] **Top of page: the matrix as a heatmap** (surface × dimension), each cell colored by its owning tests' latest status; clicking a cell lists owners, last result, runtime
- [x] Coverage-vs-floor per package; per-package wall-clock + slowest-10 files (the bloat watch); skipped/env-gated counts; perf/scale trend lines
- [x] Missing/stale lanes render grey, not absent — a lane that stopped running is visible (the #225 rot lesson)
- [x] `bun run test:report` locally; CI uploads it as an artifact per-PR and publishes the full nightly version (all lanes populated)

### Phase 10 — Rewrite TESTING.md

- [x] New package tiers, the unit/integration/contract/e2e taxonomy, the dimension matrix + flow-catalog pointer, lane schedule (per-PR vs nightly), test-kit pointer, corrected e2e table
- [x] The convention rules (behaviour-over-implementation, real-deps, adversarial check) stay untouched — they're still right

## What changed

### Phases 1–2: taxonomy, workflows, coverage, and runtime budgets

- **Pin `pool: 'forks'` explicitly in every node-env vitest config; delete the prose comments hoping the default holds.** Every workspace Vitest config now consumes the shared node or browser preset; the node preset pins `forks` once as executable configuration.
- **Pick one integration marker (`*.integration.test.ts`) and rename the `.e2e.test.ts` / `-e2e.test.ts` files to it; `.spec.ts` stays Playwright-only; fold `.property.test.ts` into the normal convention.** Gateway backup/service, vault disk-full, and tunnel integration tests use the marker; the mobile crash property suite returns to `.test.ts`; `.spec.ts` remains exclusive to Playwright.
- **Wire the web PWA Playwright suite into nightly `e2e.yml`; wire the two orphaned pairing flows into `pairing-relay-e2e.yml`.** The nightly e2e workflow now runs desktop, web, and mobile systems; pairing lifecycle, hygiene, and cross-network relay run independently and feed a final report job.
- **Correct TESTING.md's Maestro claim (see Phase 6 decision).** The e2e table names the implemented mobile agent-e2e layer and describes Maestro as absent, not aspirational infrastructure.
- **Make local `bun run test` at least report the coverage floors so the CI gate isn't a surprise.** The default test command validates `tests/coverage-floors.json` after Turbo's package tests, while `coverage` measures and enforces the same source of truth.
- **Measure vault / client / backup coverage; seed ratchet-only-up floors a tight margin below measured (same procedure as the original five).** The final successful run measured aggregate 70.57% lines / 77.61% branches / 81.39% functions, vault 91.77/79.12, backup 90.76/79.20, and client replica 75.82/76.64 (lines/branches). The client replica floor is 75/76, within one point of both measured values; every checked-in floor sits below its observation and can only move upward.
- **Split the client gate: `packages/client/src/replica/**` gated toward the 80/70 band; `src/react/**` screens follow the renderer rule (logic-units + e2e, no line gate).** The floor manifest gates only replica sources and documents React as the renderer/e2e surface.
- **Drop the whole-package 30s timeouts in mobile/tunnel/backup; slow tests get per-file timeouts or the `.integration.test.ts` marker.** Shared presets return the global default; only measured heavy files opt into 15s/30s budgets with `vi.setConfig`, and the coverage runner bounds worker concurrency to prevent host contention.

### Phase 3: shared test infrastructure

- **`tempDir()` helper with auto-cleanup (kills the 148-site duplication).** `@centraid/test-kit/temp-dir` provides async and synchronous creation, tracks every directory, and cleans after the owning Vitest file. The audited 148-file direct-creator baseline is fully migrated: no test calls `mkdtemp`/`mkdtempSync` directly, and 153 test files (including the new issue-owned lanes) now use the shared helper.
- **Fake-clock helper.** `@centraid/test-kit/fake-clock` provides deterministic install/advance/set/restore helpers.
- **`createTestVault()` / `buildTestGateway()` factories.** `@centraid/test-kit/factories` builds a bootstrapped on-disk vault and a gateway backed by it.
- **Mock-LLM harness lifted out of automation.** The implementation now lives in the dependency-neutral `@centraid/mock-llm` workspace package. Automation keeps compatibility re-exports, while `@centraid/test-kit/mock-llm` is the stable test-facing facade.
- **Two shared vitest presets (`node`, `jsdom+jsx+css-modules`) that package configs extend.** `@centraid/test-kit/vitest` owns both presets; package configs retain only package-specific coverage and setup.
- **Volume fixture generator — deterministic synthetic big-vault builder (N parties/photos/conversations, synthetic blob sets) used by the Phase 8 scale lane and by any test that needs realistic volume.** `@centraid/test-kit/volume-fixture` emits deterministic parties, photos, conversations, blobs, and replica rows from a seed.

### Phase 4: ownership matrix

- **Enumerate the canonical important app flows per surface (this is the "what must work" list — kept deliberately short).** `tests/matrix.json` defines 37 canonical flows across 13 product surfaces and ten quality dimensions.
- **Each matrix cell maps to its owning test file(s)/spec(s) and tier — one owner per flow.** `cellOwners` explicitly records an owner object or deliberate `null` for all 130 surface/dimension cells. Owners carry path, tier, flow IDs, and status; validation rejects missing cells/paths, zero-test owners, unknown flows, and duplicate flow ownership.
- **Verify/correct every seeded cell mark above while wiring it.** The manifest records solid, partial, gap, and deliberate-skip states with evidence rather than copying the audit table blindly.
- **Generator (Phase 9) fails/greys any cell whose owning test file no longer exists — rotted tests become visible, not silent.** `validate-matrix.mjs` fails structural rot, while report preparation converts absent or stale result evidence into grey status.
- **Review rule: a new test either claims an unowned cell/flow or extends an owner; duplicate owners are merged.** The rule is durable in `TESTING.md`, and manifest validation enforces unique flow ownership.

### Phase 5: executable product law

- **Promote the ranked invariants above to explicitly-marked executable contracts (`*.contract.test.ts` or `contracts/` dir per package), listed by name in TESTING.md and referenced from the matrix's Contract column.** Vault gateway/custody, backup service, replica intents/session admission, handler runner/archive, scheduler ledger, app sessions, and tunnel wire conformance now have named contract files.
- **Mostly renaming + gap-filling — the marker tells refactoring agents these encode product law, and CI can require contract files never shrink.** Existing proofs were renamed without churn; the matrix validator requires each contract owner to keep at least its recorded test count.
- **Property-based tests for the two best candidates: blob custody and replica intent idempotency (the mobile upload crash test prototyped the pattern).** Deterministic combinatorial suites cover 16 custody transitions and 64 replica intent payload/replay cases.
- **Priority gap-fill from the matrix's Concurrency column: replica multi-tab / multi-writer idempotency (the #406-review high).** `multi-writer.contract.test.ts` opens two independent `IndexedDbIntentStore` connections to the same database, concurrently enqueues and claims one intent, then reopens the database through a third connection to prove durable exactly-once settlement and idempotent replay.

### Phase 6: one e2e owner per surface

- **Desktop: Playwright `_electron` is the system. Port unique assertions from the 4 desktop agent-e2e flows into specs; retire those flows — net e2e runtime goes down.** Playwright now owns cloned-template persistence, dark-theme persistence, three builder-created drafts with distinct on-disk manifests across a full restart, and deletion that removes the mirrored app directory as well as its UI tile. The duplicate desktop agent-e2e tree is deleted. The port also fixed the desktop settings parser/merge path so the documented `builderEnabled` flag survives load and patches, allowing the current builder flow to be exercised.
- **Re-scope `tests/agent-e2e*` explicitly as exploratory manual-QA harnesses (which is what they genuinely are); merge the three `harness.mjs` files into one shared lib.** Mobile and pairing docs state their roles, and both thin adapters use `tests/agent-e2e-shared/harness.mjs` for run IDs, evidence, verdicts, and JSON artifacts.
- **Web: the existing Playwright suite, now actually running nightly (Phase 1).** Its config emits a distinct JSON artifact for the report.
- **Mobile: amend TESTING.md to bless the agent-e2e-mobile flows as the mobile e2e layer and wire them into nightly CI; drop Maestro from the doc until Maestro flows actually exist.** The mobile job builds and starts a tokenless loopback host over the real gateway graph, then runs each declared flow and uploads its evidence. Every gateway-dependent journey clears state and saves the declared URL through the real Settings UI, so its prerequisites do not depend on flow order.
- **Pairing: keep as-is, all three flows nightly (Phase 1).** Lifecycle, hygiene, and relay have separate jobs so one failure does not hide the other evidence. The pairing workflow runs before the main nightly report and publishes a mergeable evidence artifact.

### Phase 7: six budget gates

- **Blob egress: TTFB + peak-memory ceiling on large-blob streaming (catches the buffer-whole-file class).** The parent seeds a 128 MiB local blob, then a fresh child process whose allocator has never owned the payload serves it through the real gateway route. The test records first byte/completion and enforces a 96 MiB child-RSS growth ceiling isolated from Fetch client and seed-time allocations. Because the payload is larger than the ceiling and the measured process cannot reuse its seed buffer, whole-file buffering cannot fit. The route now streams from `BlobCustody.openLocalReadStreamSync()` instead of materializing the whole file.
- **Vault write path: fsyncs-per-write / write latency budget.** The lane bounds p95 journalled-write latency everywhere and, on Linux nightly hosts, uses `strace` syscall evidence to cap `fsync`/`fdatasync` calls per write.
- **Replica bootstrap wall-clock at fixed N (from the Phase 3 volume fixture).** A shared deterministic fixture drives the bootstrap budget.
- **Gateway request latency + idle CPU on the low-end profile.** The gate records p95 request latency and idle CPU utilization.
- **Mobile fast-path: make the existing #404 budgets actually gate the nightly lane.** The real Chromium PWA waterfall spec writes a #404 budget artifact; the perf lane consumes that browser evidence and skips explicitly when it is unavailable, rather than substituting a synthetic mobile algorithm.
- **Tunnel throughput floor.** Two local iroh endpoints establish a real QUIC tunnel and send a fixed payload through it to enforce minimum MiB/s.
- **Results emit JSON consumed by the Phase 9 report (trend over time).** All perf tests append normalized samples through `quality-result.ts`; the report ingests current and historical records.

### Phase 8: five correctness-at-volume gates

- **Backup → restore round-trip on a big vault (the ❌ that hurts most if wrong).** The scale lane coordinates a 32 MiB vault plus WAL/journal state and checks byte-for-byte restore.
- **Replica windowed bootstrap + convergence at volume (deletion-leak class).** The shared generated fixture's 50,000 replica rows drive windows, deletions, checkpoints, and final convergence.
- **Conversation-ledger digest→archive→prune over years-of-history fixture.** A 365-day × 20-items history is digested, archived, and pruned behind proven custody.
- **Blob eviction/GC over a large CAS with mixed custody states.** Ten thousand content-backed blobs are split evenly across the real `replicated`, `local-only`, `pending-offsite`, `remote-only`, and `missing` custody projection. The pending cohort models post-promotion custody with no staging row and a durable outbox obligation. After replica-index healing, the product cache eviction pass sheds only remotely proven resident bytes while its explicit outbox guard retains every local-only and pending-offsite byte.
- **Atlas/Browse query behavior on a 10k-entity ontology.** Ten thousand typed parties plus 9,999 authored `core_link` relations exercise keyset browsing across both `core.party` and `core.link` under one bounded query budget.

### Phases 9–10: report and durable strategy

- **`scripts/test-report/` generator (plain node, same style as the docs-site build): ingests vitest JSON + `coverage/coverage-summary.json`, Playwright JSON results, perf/scale lane JSON, and the Phase 4 matrix manifest → emits `dist/test-report/index.html`.** Preparation normalizes each source and generation emits a self-contained page.
- **Top of page: the matrix as a heatmap (surface × dimension), each cell colored by its owning tests' latest status; clicking a cell lists owners, last result, runtime.** The accessible 13×10 grid drives a detail inspector that renders owner, tier, lane, last status, and runtime without external assets.
- **Coverage-vs-floor per package; per-package wall-clock + slowest-10 files (the bloat watch); skipped/env-gated counts; perf/scale trend lines.** These views are all derived from normalized evidence and retain explicit no-data states.
- **Missing/stale lanes render grey, not absent — a lane that stopped running is visible (the #225 rot lesson).** Every Vitest, Playwright, agent-e2e, perf, and scale result carries a capture time and turns stale after 36 hours. Coverage, desktop Playwright, web Playwright, perf, and scale commands stamp distinct run markers so a cached result not refreshed by the current invocation turns grey immediately. The smoke check injects old green Vitest, Playwright, and perf evidence behind newer lane markers and asserts all three render stale/grey.
- **`bun run test:report` locally; CI uploads it as an artifact per-PR and publishes the full nightly version (all lanes populated).** PR CI always prepares the partial report. The final nightly job restores bounded cross-run history, downloads all surface artifacts plus the latest pairing artifact, runs full Vitest coverage, perf, and scale, then regenerates and uploads one combined report even when an evidence command fails.
- **New package tiers, the unit/integration/contract/e2e taxonomy, the dimension matrix + flow-catalog pointer, lane schedule (per-PR vs nightly), test-kit pointer, corrected e2e table.** `TESTING.md` is rewritten around these current mechanisms.
- **The convention rules (behaviour-over-implementation, real-deps, adversarial check) stay untouched — they're still right.** The rewrite preserves those rules verbatim in its conventions section.

### Changed-file crosswalk

The following paths are the complete modified/added/renamed/deleted surface of
this change (old paths are retained here for audit clarity):

```text
.github/workflows/ci.yml
.github/workflows/e2e.yml
.github/workflows/pairing-relay-e2e.yml
.gitignore
TESTING.md
apps/desktop/package.json
apps/desktop/src/main/settings-merge.test.ts
apps/desktop/src/main/settings-merge.ts
apps/desktop/src/main/settings.ts
apps/desktop/tests/e2e/appview-templates-insights.spec.ts
apps/desktop/tests/e2e/delete-app.spec.ts
apps/desktop/tests/e2e/fixtures.ts
apps/desktop/tests/e2e/playwright.config.ts
apps/desktop/tests/e2e/settings-gateways.spec.ts
apps/desktop/vitest.config.ts
apps/mobile/src/lib/upload/cbsf.test.ts
apps/mobile/src/lib/upload/crash.property.test.ts
apps/mobile/src/lib/upload/crash.test.ts
apps/mobile/src/lib/upload/enqueue.test.ts
apps/mobile/src/lib/upload/store.test.ts
apps/mobile/src/lib/upload/uploader.test.ts
apps/mobile/vitest.config.ts
apps/web/package.json
apps/web/tests/e2e/perf-waterfall.spec.ts
apps/web/tests/e2e/playwright.config.ts
apps/web/vitest.config.ts
bun.lock
package.json
packages/agent-runtime/src/cli/centraid-cli.test.ts
packages/agent-runtime/src/models/catalog-warmer.test.ts
packages/agent-runtime/src/models/catalog.test.ts
packages/agent-runtime/src/multimodal.test.ts
packages/agent-runtime/src/preflight.test.ts
packages/agent-runtime/vitest.config.ts
packages/app-engine/src/conversation/archive/archive.contract.test.ts
packages/app-engine/src/conversation/archive/archive.test.ts
packages/app-engine/src/conversation/archive/digest-parity.test.ts
packages/app-engine/src/conversation/archive/test-fixtures.ts
packages/app-engine/src/conversation/history.test.ts
packages/app-engine/src/conversation/rehydrate.test.ts
packages/app-engine/src/conversation/reprice.test.ts
packages/app-engine/src/conversation/store.test.ts
packages/app-engine/src/data/blob-store.test.ts
packages/app-engine/src/handlers/dispatcher.test.ts
packages/app-engine/src/handlers/handler-pool.test.ts
packages/app-engine/src/handlers/handler-runner.contract.test.ts
packages/app-engine/src/handlers/handler-runner.test.ts
packages/app-engine/src/handlers/vault-bridge.test.ts
packages/app-engine/src/http/app-bundle.test.ts
packages/app-engine/src/http/changes-sse.test.ts
packages/app-engine/src/http/http-server.test.ts
packages/app-engine/src/http/query-bundle.test.ts
packages/app-engine/src/http/static-server.test.ts
packages/app-engine/src/http/turn-routes.test.ts
packages/app-engine/src/insights/analytics-store.test.ts
packages/app-engine/src/insights/insights-store.test.ts
packages/app-engine/src/registry/deregister-cleanup.test.ts
packages/app-engine/src/settings/app-settings.test.ts
packages/app-engine/src/stores/gateway-db.test.ts
packages/app-engine/src/stores/prefs-store.test.ts
packages/app-engine/vitest.config.ts
packages/automation/package.json
packages/automation/src/fire/condition.test.ts
packages/automation/src/fire/connector.test.ts
packages/automation/src/fire/fire-vault.test.ts
packages/automation/src/fire/fire.test.ts
packages/automation/src/fire/scheduler-ledger.contract.test.ts
packages/automation/src/fire/scheduler-ledger.test.ts
packages/automation/src/index.ts
packages/automation/src/mock-llm/mock-llm-server.test.ts
packages/automation/src/mock-llm/mock-llm-server.ts
packages/automation/src/mock-llm/mock-llm-writers.ts
packages/automation/src/mock-llm/persistent-mock-session.test.ts
packages/automation/src/mock-llm/persistent-mock-session.ts
packages/automation/src/scaffold/app.test.ts
packages/automation/src/scaffold/scaffold.test.ts
packages/automation/vitest.config.ts
packages/backup/src/crypto.test.ts
packages/backup/src/engine.test.ts
packages/backup/src/interop-clawgnition.test.ts
packages/backup/src/local-provider.test.ts
packages/backup/src/manifest.test.ts
packages/backup/src/materialize.test.ts
packages/backup/src/object-store.test.ts
packages/backup/src/recovery-kit.test.ts
packages/backup/src/wal-format.test.ts
packages/backup/src/wal-restore.test.ts
packages/backup/vitest.config.ts
packages/blueprints/src/app-boot-harness.ts
packages/blueprints/src/app-rewrites.test.ts
packages/blueprints/src/clone.test.ts
packages/blueprints/src/update-app-meta.test.ts
packages/blueprints/vitest.config.ts
packages/client/package.json
packages/client/src/replica/intent-idempotency-properties.test.ts
packages/client/src/replica/intents.contract.test.ts
packages/client/src/replica/intents.test.ts
packages/client/src/replica/multi-writer.contract.test.ts
packages/client/src/replica/shell-session-admission.contract.test.ts
packages/client/src/replica/shell-session-admission.test.ts
packages/client/vitest.config.ts
packages/gateway/src/backup/backup-e2e.test.ts
packages/gateway/src/backup/backup-service-restore.test.ts
packages/gateway/src/backup/backup-service.contract.test.ts
packages/gateway/src/backup/backup-service.test.ts
packages/gateway/src/backup/backup-sources.test.ts
packages/gateway/src/backup/backup.integration.test.ts
packages/gateway/src/backup/recover-e2e.test.ts
packages/gateway/src/backup/recover-job.test.ts
packages/gateway/src/backup/recover-live-e2e.test.ts
packages/gateway/src/backup/recover-live.integration.test.ts
packages/gateway/src/backup/recover-reconcile.test.ts
packages/gateway/src/backup/recover.integration.test.ts
packages/gateway/src/backup/restore-lazy-e2e.test.ts
packages/gateway/src/backup/restore-lazy.integration.test.ts
packages/gateway/src/backup/restore-verify-sealkey.test.ts
packages/gateway/src/backup/storage-credentials.test.ts
packages/gateway/src/backup/storage-e2e.test.ts
packages/gateway/src/backup/storage-usage.test.ts
packages/gateway/src/backup/storage.integration.test.ts
packages/gateway/src/backup/wal-e2e.test.ts
packages/gateway/src/backup/wal.integration.test.ts
packages/gateway/src/cli/admin.test.ts
packages/gateway/src/cli/backup-admin.test.ts
packages/gateway/src/cli/cli.test.ts
packages/gateway/src/cli/key-admin.test.ts
packages/gateway/src/cli/recover-admin.test.ts
packages/gateway/src/cli/service-admin.test.ts
packages/gateway/src/cli/service-install.e2e.test.ts
packages/gateway/src/cli/service-install.integration.test.ts
packages/gateway/src/cli/status-admin.test.ts
packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts
packages/gateway/src/lifecycle/clone-over-http.test.ts
packages/gateway/src/lifecycle/draft-preview-over-http.test.ts
packages/gateway/src/lifecycle/ext-band-over-http.test.ts
packages/gateway/src/lifecycle/headless-automation-compile.test.ts
packages/gateway/src/lifecycle/install-over-http.test.ts
packages/gateway/src/lifecycle/lifecycle-over-http.test.ts
packages/gateway/src/lifecycle/lifecycle-shared.test.ts
packages/gateway/src/lifecycle/webhook-route-over-http.test.ts
packages/gateway/src/routes/agents-routes.test.ts
packages/gateway/src/routes/apps-store-routes.test.ts
packages/gateway/src/routes/assistant-routes.test.ts
packages/gateway/src/routes/automations-routes.test.ts
packages/gateway/src/routes/blob-routes.test.ts
packages/gateway/src/routes/blob-routes.ts
packages/gateway/src/routes/connections-routes.test.ts
packages/gateway/src/routes/device-work-routes.test.ts
packages/gateway/src/routes/devices-routes.test.ts
packages/gateway/src/routes/import-routes.test.ts
packages/gateway/src/routes/lifecycle-automation-routes.test.ts
packages/gateway/src/routes/recover-routes.test.ts
packages/gateway/src/routes/replica-intent-route.test.ts
packages/gateway/src/routes/replica-routes.test.ts
packages/gateway/src/routes/replica-shape.test.ts
packages/gateway/src/routes/route-helpers.test.ts
packages/gateway/src/routes/storage-routes.test.ts
packages/gateway/src/routes/templates-routes.test.ts
packages/gateway/src/routes/vault-routes.atlas.test.ts
packages/gateway/src/routes/vault-routes.browse.test.ts
packages/gateway/src/routes/vault-routes.test.ts
packages/gateway/src/runs/run-events-sse.test.ts
packages/gateway/src/runs/unified-conversation-runner.test.ts
packages/gateway/src/serve/build-gateway.test.ts
packages/gateway/src/serve/connection-broker.test.ts
packages/gateway/src/serve/demo-seed.test.ts
packages/gateway/src/serve/device-plane.test.ts
packages/gateway/src/serve/device-token-store.test.ts
packages/gateway/src/serve/gateway-diagnostics.test.ts
packages/gateway/src/serve/gateway-instance-lease.test.ts
packages/gateway/src/serve/gateway-log-store.test.ts
packages/gateway/src/serve/outbox-executor.test.ts
packages/gateway/src/serve/pricing-warmer.test.ts
packages/gateway/src/serve/serve-device-tokens.test.ts
packages/gateway/src/serve/serve-git-store.test.ts
packages/gateway/src/serve/serve-multiclient.test.ts
packages/gateway/src/serve/serve-scheduler-reconcile.test.ts
packages/gateway/src/serve/serve-vault-addressing.test.ts
packages/gateway/src/serve/serve.test.ts
packages/gateway/src/serve/vault-plane-blob-sweep.test.ts
packages/gateway/src/serve/vault-plane-conversation-archival.test.ts
packages/gateway/src/serve/vault-plane.test.ts
packages/gateway/src/serve/vault-quarantine.test.ts
packages/gateway/src/serve/vault-registry.test.ts
packages/gateway/src/serve/web-app-sessions.contract.test.ts
packages/gateway/src/serve/web-app-sessions.test.ts
packages/gateway/src/serve/web-session-store.test.ts
packages/gateway/src/serve/web-ui-server.test.ts
packages/gateway/src/validate-automation-handler.test.ts
packages/gateway/src/validate-manifest.test.ts
packages/gateway/src/worktree-store/remote.test.ts
packages/gateway/src/worktree-store/worktree-store.test.ts
packages/gateway/vitest.config.ts
packages/mock-llm/package.json
packages/mock-llm/src/index.ts
packages/mock-llm/src/mock-llm-server.ts
packages/mock-llm/src/mock-llm-writers.ts
packages/mock-llm/src/persistent-mock-session.ts
packages/mock-llm/tsconfig.json
packages/skills/vitest.config.ts
packages/test-kit/package.json
packages/test-kit/src/factories.ts
packages/test-kit/src/fake-clock.ts
packages/test-kit/src/mock-llm-server.test.ts
packages/test-kit/src/mock-llm.ts
packages/test-kit/src/persistent-mock-session.test.ts
packages/test-kit/src/quality-result.ts
packages/test-kit/src/temp-dir.ts
packages/test-kit/src/test-kit.test.ts
packages/test-kit/src/vitest.ts
packages/test-kit/src/volume-fixture.ts
packages/test-kit/tsconfig.json
packages/test-kit/vitest.config.ts
packages/tunnel/src/tunnel.integration.test.ts
packages/tunnel/src/tunnel.test.ts
packages/tunnel/src/wire-conformance.contract.test.ts
packages/tunnel/src/wire-conformance.test.ts
packages/tunnel/vitest.config.ts
packages/vault/src/blob/blob.test.ts
packages/vault/src/blob/cache-headroom.test.ts
packages/vault/src/blob/cache.ts
packages/vault/src/blob/custody-properties.test.ts
packages/vault/src/blob/custody-proven.contract.test.ts
packages/vault/src/blob/custody-proven.test.ts
packages/vault/src/blob/custody.ts
packages/vault/src/blob/direct-cold-doors.test.ts
packages/vault/src/blob/direct-cold-originals.test.ts
packages/vault/src/blob/disk-full.e2e.test.ts
packages/vault/src/blob/disk-full.integration.test.ts
packages/vault/src/blob/evict.ts
packages/vault/src/blob/outbox-drain.test.ts
packages/vault/src/blob/stream-ingress.test.ts
packages/vault/src/blob/transfers.test.ts
packages/vault/src/db.test.ts
packages/vault/src/errors.test.ts
packages/vault/src/gateway/custody.test.ts
packages/vault/src/gateway/duties.test.ts
packages/vault/src/gateway/gateway.contract.test.ts
packages/vault/src/gateway/gateway.test.ts
packages/vault/src/gateway/seal-custody.test.ts
packages/vault/src/gateway/sql.test.ts
packages/vault/src/host.test.ts
packages/vault/src/replica/invocation-commits.test.ts
packages/vault/src/schema/migrate.test.ts
packages/vault/src/wal-shipper-clone.test.ts
packages/vault/src/wal-shipper-detectors.test.ts
packages/vault/src/wal-shipper.test.ts
packages/vault/vitest.config.ts
receipts/issue-458-test-suite-reorganization.md
scripts/test-report/generate.mjs
scripts/test-report/prepare.mjs
scripts/test-report/report-floors.mjs
scripts/test-report/smoke.mjs
scripts/test-report/validate-matrix.mjs
tests/agent-e2e-mobile/AGENTS.md
tests/agent-e2e-mobile/README.md
tests/agent-e2e-mobile/flows/home-loads.md
tests/agent-e2e-mobile/flows/native-v0-resilience.md
tests/agent-e2e-mobile/flows/native-v0-resilience.mjs
tests/agent-e2e-mobile/flows/template-gate.md
tests/agent-e2e-mobile/flows/template-gate.mjs
tests/agent-e2e-mobile/lib/ci-gateway.mjs
tests/agent-e2e-mobile/lib/harness.mjs
tests/agent-e2e-pairing/README.md
tests/agent-e2e-pairing/lib/docker-harness.mjs
tests/agent-e2e-pairing/lib/harness.mjs
tests/agent-e2e-shared/harness.mjs
tests/agent-e2e/.gitignore
tests/agent-e2e/AGENTS.md
tests/agent-e2e/README.md
tests/agent-e2e/flows/clone-template-and-reopen.md
tests/agent-e2e/flows/clone-template-and-reopen.mjs
tests/agent-e2e/flows/delete-draft-wipes-disk-and-ui.md
tests/agent-e2e/flows/delete-draft-wipes-disk-and-ui.mjs
tests/agent-e2e/flows/multiple-drafts-coexist-and-persist.md
tests/agent-e2e/flows/multiple-drafts-coexist-and-persist.mjs
tests/agent-e2e/flows/settings-theme-persists.md
tests/agent-e2e/flows/settings-theme-persists.mjs
tests/agent-e2e/lib/harness.mjs
tests/coverage-floors.json
tests/matrix.json
tests/matrix.schema.json
tests/perf/blob-egress.perf.test.ts
tests/perf/fixtures/blob-egress-server.mjs
tests/perf/fixtures/vault-write-child.mjs
tests/perf/gateway-request.perf.test.ts
tests/perf/mobile-fast-path.perf.test.ts
tests/perf/replica-bootstrap.perf.test.ts
tests/perf/tunnel-throughput.perf.test.ts
tests/perf/vault-write.perf.test.ts
tests/quality/replica-bootstrap-fixture.ts
tests/scale/backup-restore.scale.test.ts
tests/scale/blob-gc.scale.test.ts
tests/scale/conversation-ledger.scale.test.ts
tests/scale/ontology.scale.test.ts
tests/scale/replica-bootstrap.scale.test.ts
vitest.config.ts
vitest.perf.config.ts
vitest.scale.config.ts
```

## Out of scope

- Publishing the report to a public static host. CI publishes retained report
  artifacts; repository-hosting policy and retention remain separate concerns.
- Reorganizing colocated tests into central test directories, adding noisy
  per-PR perf/e2e gates, or bulk-writing tests to increase counts. These are
  explicitly excluded by issue #458's principles and notes.
- Broad performance optimization beyond the one correctness-enabling local
  blob streaming change. The issue establishes reproducible gates; other
  optimizations remain separately reviewable work.

## Decisions

- Used JSON for the checked-in matrix so schema validation and the plain-Node
  report generator need no new parser dependency.
- Kept contract promotion rename-heavy and assigned one owner per flow, rather
  than duplicating already-strong lower-tier proof.
- The mobile/pairing exploratory harnesses share result/evidence mechanics but
  retain surface-specific drivers. Desktop assertions moved wholly to
  Playwright because Electron already had the authoritative real-UI system.
- CI publication means named, retained Actions artifacts for partial per-PR
  and fully populated nightly reports; public hosting is intentionally not
  introduced by a test-organization issue.
- Perf budgets use generous fixed regression margins and isolated nightly
  worker counts. They are product health signals, not inner-loop blockers.
- The existing desktop fixture's conversation creation response lacked the
  current `updatedAt`/pin/archive shape and crashed the real sidebar only after
  relaunch. The port corrected that contract and keeps error-only renderer
  diagnostics. Likewise, `builderEnabled` existed in client types but was
  silently dropped by desktop settings load/merge, so the settings bridge was
  fixed as a forced current-product-shape change.
- Oxfmt's default parallelism was killed by this workspace's 2,182-file scan on
  the verification host. The root format commands now pin one formatter thread;
  the same rules run in roughly 2.5 seconds without weakening the gate.

## Verification

```sh
bun install --frozen-lockfile
bun run test:matrix
bun run test:report:smoke
! rg -n '\bmkdtemp(Sync)?\(' apps packages \
  --glob '*.test.ts' --glob '*.test.tsx' --glob '*.spec.ts' --glob '*.spec.tsx'
bun run test:perf
bun run test:scale
bun run coverage
bun run test:report
bun run test:report:smoke
bun run build
bun run typecheck
bun run lint
bun run lint:types
bun run lint:css
bun run format:check
node --check tests/agent-e2e-mobile/lib/ci-gateway.mjs
node --check tests/agent-e2e-mobile/lib/harness.mjs
bunx playwright test -c apps/desktop/tests/e2e/playwright.config.ts \
  apps/desktop/tests/e2e/appview-templates-insights.spec.ts \
  apps/desktop/tests/e2e/delete-app.spec.ts \
  --grep "10.1|10.2|10.3|10.4|3.1"
```

- Frozen install passed.
- Matrix validation reported 13 surfaces, 10 dimensions, and 37 uniquely owned
  flows.
- The temp-directory audit found zero direct `mkdtemp`/`mkdtempSync` calls in
  test files and 153 shared-helper consumers. Representative async, sync, and
  `beforeAll` callers passed 55/55 focused tests before the full run.
- Focused test-kit/client/blob-route verification passed 33/33 tests.
  Performance passed 5 budgets with the browser-only mobile budget correctly
  environment-gated; scale passed 5/5.
- Full coverage passed 489 test files and 4,370 tests, with one test file and
  29 tests intentionally skipped. Aggregate coverage was 70.57% lines / 77.61%
  branches / 81.39% functions; every repository and scoped package floor
  passed.
- The mobile harness modules passed Node syntax checks. A local operational
  smoke started the nightly CI gateway entry point on a tokenless loopback
  port, and an unauthenticated `GET /_apps` returned `[]` before clean shutdown.
- Typecheck completed 31/31 tasks and the build completed 15/15 tasks. Oxlint,
  package lint, type-aware lint, CSS lint, and the single-thread full oxfmt scan
  were clean.
- All five issue-owned Electron assertions passed against the final build:
  Discover rendered both populated and empty catalogs, an automation clone
  survived a fresh mock-gateway instance and Electron process, three
  independent drafts survived a restart with distinct manifests, and deleting
  a draft removed both the tile and its app directory.
- The generated report passed its structural smoke test. It was also served and
  inspected in installed Chromium: the 13×10 heatmap rendered 130 cells,
  selecting a Correctness cell updated the Vault core inspector with owner,
  tier, status, 3 ms runtime, and path, and the page produced no browser errors.

## Audit

**PASS — receipt fidelity.** `## What changed` faithfully matches the staged
274-entry diff (299 paths when both sides of 25 renames are counted). It
accurately describes the real IndexedDB two-writer/reopen proof, 128 MiB
fresh-process streaming check with 96 MiB RSS ceiling, mobile real-gateway
lane, pending-outbox eviction guard, desktop restart coverage, and no
gateway-process/conversation-rehydration overclaim.

**PASS — checklist realization.** Every checked item has staged implementation
and ownership evidence. Rechecked: fake IndexedDB independent
connections/claim/reopen; 10,000 inserted parties plus 9,999 `core_link` rows
and browsing of `core.party`/`core.link`; universal stale markers; independent
pairing jobs; client replica 75/76 floors below 75.82/76.64; and 10k
mixed-custody protection of local-only and pending-offsite bytes.

**PASS — issue/checklist and governance evidence.** The receipt checklist
faithfully mirrors issue #458's phased scope. The changed-file crosswalk is
exact at **299/299**, including every old and new rename side. Direct test
`mkdtemp`/`mkdtempSync` calls are zero; `@centraid/test-kit/temp-dir` has **153**
consumers with async/sync tracked cleanup. Receipt verification records **4,370
passed / 29 skipped** and **70.57/77.61/81.39** aggregate coverage. Steering
correctly records the sole human ordinal 1 and no ledger event. `git diff
--cached --check` is clean.

## Steering

**PASS.** The complete human-message transcript contains only ordinal 1, the
task-defining opening request: `/goal work on the entire scope of
https://github.com/srikanth235/centraid/issues/458 and create PR`. There are no
later human messages, interruptions, corrections, or redirects, so there are
no steering events and no steering ledger rows are required.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f7437-af9-1784383047-1 | codex | 019f7437-af9c-7782-8dbb-cb973af36847 | #458 | gpt-5.6-sol | 3541346 | 0 | 174211072 | 390779 | 3932125 | 58.2678 | 3541346 | 0 | 174211072 | 390779 | test: realign suite with product shape (#458) -m governance: allow-toolchain-con |
| claude-code-e1dd013a-4c0-1784443417-1 | claude-code | e1dd013a-4c0e-40fb-a814-df75c60d1fe9 | #458 | claude-fable-5 | 61 | 472562 | 2062185 | 53023 | 525646 | 10.6210 | 61 | 472562 | 2062185 | 53023 | merge: main into issue-458 test reorg — #460 supersedes the PR's egress streamin |
| claude-code-e1dd013a-4c0-1784443462-1 | claude-code | e1dd013a-4c0e-40fb-a814-df75c60d1fe9 | #458 | claude-fable-5 | 1 | 1632 | 106372 | 372 | 2005 | 0.1454 | 62 | 474194 | 2168557 | 53395 | merge: main into issue-458 test reorg — #460 supersedes the PR's egress streamin |
| claude-code-e1dd013a-4c0-1784443508-1 | claude-code | e1dd013a-4c0e-40fb-a814-df75c60d1fe9 | #458 | claude-fable-5 | 4 | 1164 | 216008 | 840 | 2008 | 0.2726 | 66 | 475358 | 2384565 | 54235 | chore(merge): merge main into issue-458 test reorg — #460 supersedes egress stre |
