# Receipt — issue #738: one pending-write overlay on every seat

## User impact

Queued writes are visible local facts on every seat. Tally expenses, Tasks,
Agenda responses, and native Notes remain present with honest pending status
while offline and after reload/restart; terminal rows retain their explanation
and recovery actions.

First-run: onboarding and the fresh Home are unchanged. The production Electron
journey emits `artifacts/e2e/ui-impact/issue-738-pending-write-overlay.png`
after reloading offline with the pending Tally, Tasks, and Agenda rows restored.

## Checklist

- [x] **Reload survival (the headline test):** on web and desktop, add a Tally expense while the gateway is unreachable, reload the app while still unreachable — the expense renders in the ledger with a pending chip, backed only by the local outbox. Same for a Tasks add and an Agenda RSVP.
- [x] **Mobile parity:** the same offline add on native mobile renders a pending row (not toast-only), surviving app restart offline.
- [x] **No hand-rolled overlays remain:** `state.pendingExpenses`, `pendingAdds`/`pendingIds`, `apps/agenda/pending.ts`, and the Notes/Docs/Locker equivalents are deleted; a conformance guard fails on reintroduction.
- [x] **Solo-vault wipe fixed:** an empty `commonsIntents()` response can no longer clear locally-queued pending rows.
- [x] **Settlement is honest:** executed rows swap to canonical without flicker or duplication (pending key → canonical id); parked rows persist with reason and approval affordance; denied/conflict/failed rows persist with reason and edit/retry/discard; a conflict shows expected vs actual versions.
- [x] **Blueprint-agnostic by construction:** an app adopts the engine by declaring per-action projections only — no app-owned pending state, demonstrated by at least one record-only app (Tasks) and one commons-bearing app (Tally) sharing the identical engine path.
- [x] **Commons copy is honest:** a commons write offline says it is waiting for a connection; online with an unreachable steward it names the steward; expiry and dismissal behavior from #731 is unchanged (pinned by existing tests).
- [x] **Docs absorbed:** ARCHITECTURE.md read contract, blueprint-seats.md engine contract (verbs / reason grammar / structural exclusions), glossary if new vocabulary lands; the "fully offline" claim in ARCHITECTURE.md becomes true for queued writes and says so.
- [x] One receipt per implementing issue, per CONSTITUTION.md.

## What changed

### Acceptance crosswalk

- **Reload survival (the headline test):** on web and desktop, add a Tally expense while the gateway is unreachable, reload the app while still unreachable — the expense renders in the ledger with a pending chip, backed only by the local outbox. Same for a Tasks add and an Agenda RSVP. Production Electron and PWA journeys cover this exact route/component flow with transport forced offline.
- **Mobile parity:** the same offline add on native mobile renders a pending row (not toast-only), surviving app restart offline. The Android device lane now drives the mounted Tally UI under real OS airplane mode, force-stops the app, relaunches while still offline, and asserts the durable row and queued chip. The rendered cross-platform companion mounts the production `ReplicaProvider` → `useReplicaQuery` → `MultiVaultReplicaSession` path over a closed-and-reopened SQLite replica/outbox.
- **No hand-rolled overlays remain:** `state.pendingExpenses`, `pendingAdds`/`pendingIds`, `apps/agenda/pending.ts`, and the Notes/Docs/Locker equivalents are deleted; a conformance guard fails on reintroduction. The demonstrated-red guard covers known vocabulary, vocabulary-free hook collections fed by write results, inline mutations, and engine reach-past shapes.
- **Solo-vault wipe fixed:** an empty `commonsIntents()` response can no longer clear locally-queued pending rows. Commons responses enrich rows already composed from the device outbox and cannot create or remove membership.
- **Settlement is honest:** executed rows swap to canonical without flicker or duplication (pending key → canonical id); parked rows persist with reason and approval affordance; denied/conflict/failed rows persist with reason and edit/retry/discard; a conflict shows expected vs actual versions. Attention outcomes use the existing atomic outbox transition. Edit/retry creates one fresh immutable transport intent, adds its projection first, and truthfully settles the old result; per-intent exclusion plus durable-successor recovery makes concurrent taps/tabs reuse that successor, and startup completes an interrupted handoff. Synthetic adds and canonical-row edits share this path. Explicit discard journals the real non-executed result.
- **Blueprint-agnostic by construction:** an app adopts the engine by declaring per-action projections only — no app-owned pending state, demonstrated by at least one record-only app (Tasks) and one commons-bearing app (Tally) sharing the identical engine path. All eight first-party blueprints use the registry and shared overlay engine.
- **Commons copy is honest:** a commons write offline says it is waiting for a connection; online with an unreachable steward it names the steward; expiry and dismissal behavior from #731 is unchanged (pinned by existing tests). Commons remains online enrichment only.
- **Docs absorbed:** ARCHITECTURE.md read contract, blueprint-seats.md engine contract (verbs / reason grammar / structural exclusions), glossary if new vocabulary lands; the "fully offline" claim in ARCHITECTURE.md becomes true for queued writes and says so. Mobile-offline and testing/journey documentation carry the platform and evidence details.
- One receipt per implementing issue, per CONSTITUTION.md. This file is the only issue #738 receipt.

- Added one pure pending-overlay engine, a shared projection registry, stable intent-derived row keys, and typed per-action projection modules for Agenda, Docs, Locker, Notes, People, Photos, Tally, and Tasks.
- Composed unsettled projections into browser IndexedDB and native SQLite read/search paths. The mounted mobile UI now reads through the multi-vault outbox-aware session, so pending-only rows survive complete native session reconstruction.
- Added durable terminal-state presentation with shared reason grammar, steward detail, expected/actual conflict versions, Approvals navigation, edit, retry, and discard. Retry reads fresh canonical versions before minting a new immutable id/hash; the old terminal result remains truthful in the outcome journal.
- Removed the Tally, Tasks, Agenda, Notes, Docs, and Locker hand-rolled pending collections. Commons responses are enrichment-only and cannot add, replace, or erase device-local outbox facts.
- Adopted the shared controls across browser blueprints and the relevant native row surfaces. Editing a synthetic pending identity replaces the terminal transport intent through one crash-recoverable engine path instead of dispatching an edit against a nonexistent canonical row. Revision identity is derived only from an explicitly declared edit-action projection and is checked against its allowed queued actions; ordinary `pending:` copy and pending foreign keys remain ordinary input.
- Extended terminal revision to canonical rows by matching the exact incoming app/action/shape/entity/row projection. Replacement is exclusive per original intent in-process and through Web Locks across browser tabs; concurrent retries reuse the durable successor. Regression coverage drives two queues concurrently and proves only one replacement remains.
- Matched pending search to SQLite FTS5 `unicode61` punctuation boundaries, so terms inside titles such as `Offline-planning` remain searchable before settlement. Native rows now render the same queued/sending/terminal status chips as browser rows, with sending reason copy kept quiet.
- Routed browser and multi-vault native reads through the same Hermes-safe pending-mutation presentation sanitizer, so the crash-recovery supersession marker is removed before schema validation and replacement rows remain visible after native restart without relying on `structuredClone`.
- Enforced Locker's `onlineOnly` secret boundary in both production browser bridges: inline add/edit calls go straight to the gateway and fail closed offline without touching the replica session. Non-secret Locker item actions retain honest outbox visibility through metadata-only row patches.
- Preserved bounded native filter/limit pushdown in the presence of outbox mutations: mounted reads compose the SQL page with only mutation-addressed canonical bases. The measured lane now times 50,000 canonical rows across four vaults plus 200 durable mutations under the 1,000 ms read / 100 ms search budgets; the browser perf lane separately budgets 200-outbox IndexedDB enumeration/composition.
- Carried browser query metadata by exact source-row provenance, with a safe field-only fallback, so a pending child that references a pending parent retains its own retry/edit/discard target.
- Fixed two production-path lifecycle gaps exposed by the journeys: the inline app bridge remains installed across unrelated shell rerenders, and the embedded gateway always wires its persisted host enrollment into replica authorization.
- Made local desktop profiles opt into durable replica storage by default, including a migration-safe read-time default for legacy profiles while preserving an explicit opt-out.
- Added real production-route Playwright journeys for Electron and the PWA. They use the actual shell, gateway, replica store, inline bridge, blueprint query/projection modules, and row components; only transport is forced offline. The Android Maestro lane now performs the real mounted Tally airplane-mode add → OS process restart → visible queued row journey; the rendered cross-platform companion exercises the production provider/query/session stack over a real SQLite intent store.
- Bounded the gateway test project to four workers after the exact PR gate measured eight concurrent SQLite/app fixture bootstraps exceeding the existing 30-second hook budget; assertions and timeout budgets are unchanged.
- Recorded maintainer-approved file-size waivers on the five cohesive issue files that cross the 625-line hygiene ceiling: the mounted reader and its end-to-end fixture, the crash-ordering coordinator, the cross-tree engine-conformance scanner, and the intent lifecycle contract. The waiver changes no runtime or gate threshold.
- Recorded the maintainer-approved 520,000 → 528,000-byte cold-shell transfer waiver after PR #745 measured 525,304 bytes. The existing safe chunk order is preserved; request-count, warm-shell, and app-open budgets remain unchanged.
- The CI repair briefly introduced `packages/client/src/replica/intent-replacement.ts` and expanded `packages/client/stryker.config.mjs`; both changes were fully reverted after production PWA evidence showed the dynamic boundary violated the documented Vite chunk-order invariant. The final tree has no replacement module and retains the original two-file client mutation scope.
- Kept `IntentRecordStore`, IndexedDB, memory, and native SQLite outbox implementations byte-identical to `origin/main`; the overlay uses their existing add/transition/settle contract without a schema or sync-model change.
- Added an architectural conformance tripwire with demonstrated-red coverage. It rejects known app-owned overlay vocabulary, arbitrary-named collection hooks populated from write results, inline optimistic mutations, and reach-past imports; engine/unit/journey tests own runtime projection correctness.

### Changed-file manifest

The manifest is the sorted union of `git diff --name-only origin/main` and untracked, non-ignored files:

```text
ARCHITECTURE.md
TESTING.md
apps/desktop/src/main/embedded-gateway-layout.test.ts
apps/desktop/src/main/gateway-store-core.test.ts
apps/desktop/src/main/gateway-store-core.ts
apps/desktop/src/main/gateway-store.test.ts
apps/desktop/src/main/gateway-store.ts
apps/desktop/tests/e2e/SCENARIOS.md
apps/desktop/tests/e2e/pending-overlay.spec.ts
apps/desktop/tests/e2e/tsconfig.json
apps/mobile/src/apps/agenda/AgendaEvent.tsx
apps/mobile/src/apps/agenda/AgendaEventEditor.tsx
apps/mobile/src/apps/agenda/AgendaHome.tsx
apps/mobile/src/apps/agenda/useAgenda.ts
apps/mobile/src/apps/docs/DocsHome.tsx
apps/mobile/src/apps/docs/DocsItemActions.tsx
apps/mobile/src/apps/docs/DocumentViewer.tsx
apps/mobile/src/apps/locker/LockerHome.tsx
apps/mobile/src/apps/notes/NotesHome.tsx
apps/mobile/src/apps/photos/AlbumDetail.tsx
apps/mobile/src/apps/photos/DuplicateReview.tsx
apps/mobile/src/apps/photos/FaceReview.test.tsx
apps/mobile/src/apps/photos/FaceReview.tsx
apps/mobile/src/apps/photos/PhotoLightbox.tsx
apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx
apps/mobile/src/apps/photos/PhotosHome.tsx
apps/mobile/src/apps/photos/PhotosLibrary.tsx
apps/mobile/src/apps/photos/face-review-model.ts
apps/mobile/src/apps/photos/photos-selection-writes.ts
apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx
apps/mobile/src/apps/tally/TallyExpenseRow.tsx
apps/mobile/src/apps/tally/TallyHome.tsx
apps/mobile/src/apps/tasks/TasksHome.tsx
apps/mobile/src/kit/replica/PendingRowStatus.tsx
apps/mobile/src/lib/replica/multi-vault-provenance.ts
apps/mobile/src/lib/replica/multi-vault-reader.test.ts
apps/mobile/src/lib/replica/multi-vault-reader.ts
apps/mobile/src/lib/replica/multi-vault-session.ts
apps/mobile/src/lib/replica/native-session.ts
apps/mobile/src/lib/replica/replica-read-pushdown.test.ts
apps/web/tests/e2e/control-transport.ts
apps/web/tests/e2e/pending-overlay.spec.ts
apps/web/tests/e2e/perf-budgets.ts
apps/web/tests/e2e/server.ts
docs/blueprint-seats.md
docs/glossary.md
docs/mobile-offline.md
packages/blueprints/apps/_shared/PendingWriteActions.test.tsx
packages/blueprints/apps/_shared/PendingWriteActions.tsx
packages/blueprints/apps/_shared/pending-overlay.test.ts
packages/blueprints/apps/_shared/pending-overlay.ts
packages/blueprints/apps/_shared/pending-projections.ts
packages/blueprints/apps/agenda/app-inline.tsx
packages/blueprints/apps/agenda/app-root.tsx
packages/blueprints/apps/agenda/components/EventDrawer.tsx
packages/blueprints/apps/agenda/components/ScheduleView.tsx
packages/blueprints/apps/agenda/logic.ts
packages/blueprints/apps/agenda/pending-projection.ts
packages/blueprints/apps/agenda/pending.ts
packages/blueprints/apps/agenda/types.ts
packages/blueprints/apps/docs/app-inline.tsx
packages/blueprints/apps/docs/components/Grid.tsx
packages/blueprints/apps/docs/components/List.tsx
packages/blueprints/apps/docs/components/Sidebar.tsx
packages/blueprints/apps/docs/pending-projection.ts
packages/blueprints/apps/inline-types.ts
packages/blueprints/apps/locker/app-inline.tsx
packages/blueprints/apps/locker/app-root.tsx
packages/blueprints/apps/locker/logic.test.ts
packages/blueprints/apps/locker/pending-projection.ts
packages/blueprints/apps/locker/types.ts
packages/blueprints/apps/notes/app-inline.tsx
packages/blueprints/apps/notes/app-root.tsx
packages/blueprints/apps/notes/components/Card.tsx
packages/blueprints/apps/notes/components/Sidebar.tsx
packages/blueprints/apps/notes/components/Wall.tsx
packages/blueprints/apps/notes/logic.ts
packages/blueprints/apps/notes/pending-projection.ts
packages/blueprints/apps/notes/types.ts
packages/blueprints/apps/people/app-inline.tsx
packages/blueprints/apps/people/components/Grid.tsx
packages/blueprints/apps/people/components/List.tsx
packages/blueprints/apps/people/components/Sidebar.tsx
packages/blueprints/apps/people/pending-projection.ts
packages/blueprints/apps/photos/app-inline.tsx
packages/blueprints/apps/photos/components/AlbumGrid.module.css
packages/blueprints/apps/photos/components/AlbumGrid.tsx
packages/blueprints/apps/photos/components/FaceReview.tsx
packages/blueprints/apps/photos/components/Tile.tsx
packages/blueprints/apps/photos/pending-projection.ts
packages/blueprints/apps/tally/app-inline.tsx
packages/blueprints/apps/tally/app-root.tsx
packages/blueprints/apps/tally/components/ExpenseModal.tsx
packages/blueprints/apps/tally/components/ExpenseRow.test.tsx
packages/blueprints/apps/tally/components/ExpenseRow.tsx
packages/blueprints/apps/tally/components/Ledger.tsx
packages/blueprints/apps/tally/logic-commons.test.ts
packages/blueprints/apps/tally/logic.ts
packages/blueprints/apps/tally/pending-projection.ts
packages/blueprints/apps/tally/queries/dashboard.ts
packages/blueprints/apps/tally/types.ts
packages/blueprints/apps/tasks/app-inline.tsx
packages/blueprints/apps/tasks/app-root.tsx
packages/blueprints/apps/tasks/components/Board.test.tsx
packages/blueprints/apps/tasks/components/Board.tsx
packages/blueprints/apps/tasks/components/Row.tsx
packages/blueprints/apps/tasks/logic.ts
packages/blueprints/apps/tasks/pending-projection.ts
packages/blueprints/apps/tasks/types.ts
packages/blueprints/manifest.json
packages/blueprints/src/agenda-pending.test.ts
packages/blueprints/src/app-boot-harness.ts
packages/blueprints/types/centraid.d.ts
packages/client/src/react/blueprints/centraid-inline.test.ts
packages/client/src/react/blueprints/centraid-inline.ts
packages/client/src/react/blueprints/inlineQueryCtx.test.ts
packages/client/src/react/blueprints/inlineQueryCtx.ts
packages/client/src/react/shell/App.inline-branch.test.tsx
packages/client/src/react/shell/routes/InlineAppRoute.test.tsx
packages/client/src/react/shell/routes/InlineAppRoute.tsx
packages/client/src/replica/coordinator.test.ts
packages/client/src/replica/coordinator.ts
packages/client/src/replica/intents.contract.test.ts
packages/client/src/replica/intents.ts
packages/client/src/replica/multi-writer.contract.test.ts
packages/client/src/replica/query.ts
packages/client/src/replica/search.ts
packages/client/src/replica/shell-session-admission.contract.test.ts
packages/client/src/replica/shell-session-scopes.test.ts
packages/client/src/replica/shell-session.test.ts
packages/client/src/replica/shell-session.ts
packages/client/src/replica/sqlite-store.test.ts
packages/client/src/replica/store-core.ts
packages/gateway/src/serve/build-gateway.ts
packages/gateway/vitest.config.ts
receipts/issue-738-pending-write-overlay.md
scripts/lint-container-opacity.mjs
scripts/lint-engine-conformance.mjs
scripts/lint-engine-conformance.test.mjs
scripts/lint-law-registry.mjs
scripts/lint-law-registry.test.mjs
tests/agent-e2e-mobile/flows/native-v0-resilience.md
tests/agent-e2e-mobile/flows/native-v0-resilience.mjs
tests/experience-budgets/mobile.json
tests/matrix.json
tests/perf/replica-sync-io.perf.test.ts
tests/quality-rig-budgets.json
tests/quality/classification-ratchet.json
tests/skips.json
```

## Out of scope

- The single-writer sync protocol, wire schema, intent schema, outbox store contract/implementations, idempotency rules, and canonical outcome vocabulary are unchanged.
- Photo byte custody/upload remains in the custody engine; only row-shaped Photos writes participate in the overlay.
- Commons steward sequencing, compaction, signatures, expiry, and notification design remain owned by #731.
- Assistant, Insights, and Automations do not become replica-write consumers.

## Decisions

1. Terminal input remains device-local until explicit retry or discard; executed input is removed after canonical convergence. Discard journals the last real non-executed status, never false execution.
2. Retry refreshes canonical base versions and mints a fresh immutable transport intent, because the gateway binds one `intentId` to one payload hash forever. A per-intent exclusive section (Web Locks across browser tabs) rechecks the durable supersession marker, so concurrent retry/edit calls return one successor. The add-first marker makes interruption recoverable without changing the outbox schema or store contract, and the shared Hermes-safe presentation boundary removes it before query validation.
3. Revision detection is projection-driven and declaration-scoped: synthetic edits name the queued actions they may replace; canonical edits match the exact app/action/shape/entity/row projection. Pending foreign keys therefore remain normal write inputs, while actions without an honest visible row identity are structurally excluded.
4. Commons intent data enriches steward/reason detail but never owns local outbox membership.
5. Local desktop profiles default to durable storage. A legacy missing preference migrates to true at read time; explicit false remains respected.
6. The Electron and PWA acceptance journeys use production routes and components with transport-only outage injection. Android device evidence drives a real OS-airplane add/restart through Tally; the cross-platform rendered companion reconstructs the app-facing session over the same SQLite file.
7. A native outbox overlay augments the ordinary pushed SQL page with only its addressed canonical row ids. The fallback full read remains reserved for a genuinely saturated page whose JavaScript composition removes hits; overlay presence alone never disables filtering or limiting.
8. `onlineOnly` is a transport policy boundary, not presentation metadata: every browser bridge bypasses the replica session before projection, and network failure cannot fall back to an outbox. Locker's remaining non-secret actions still use the ordinary overlay engine.
9. The five `repo-hygiene file-size-limit` waivers are scoped to files whose behavior is deliberately audited as one boundary; the maintainer approved those waivers after the commit hook surfaced the limit. The repository-wide 625-line threshold remains unchanged.
10. The maintainer approved a narrow cold-shell transfer ceiling adjustment from 520,000 to 528,000 bytes after the production PWA lane measured 525,304 bytes with the shared durable overlay engine. The documented safe Vite chunk order remains intact; request count, warm-shell ratio, and app-open ceilings are unchanged.

Gate-required deviation note (quality knobs, verbatim single line):

#738 re-pins governed fingerprints after adding the pending-overlay reliability flow and demonstrated-red evidence; the maintainer-approved cold-shell transfer ceiling moves 520,000 -> 528,000 bytes after CI measured 525,304 bytes, while request-count, warm-shell, and app-open ceilings are unchanged.

## Verification

Reproducible commands for the final diff:

```sh
bun run format:check
bun run lint:engine-conformance
bun run --cwd packages/client test -- src/replica/intents.contract.test.ts src/replica/multi-writer.contract.test.ts src/replica/coordinator.test.ts src/replica/shell-session.test.ts src/react/blueprints/inlineQueryCtx.test.ts src/react/blueprints/centraid-inline.test.ts
bun run --cwd packages/blueprints test -- apps/tally/logic-commons.test.ts apps/tally/components/ExpenseRow.test.tsx apps/_shared/pending-overlay.test.ts src/locker-online-only.test.ts
bun run --cwd apps/mobile test -- src/apps/tally/PendingRestartJourney.test.tsx src/lib/replica/multi-vault-reader.test.ts src/lib/replica/replica-read-pushdown.test.ts
bun run --cwd apps/desktop test:e2e -- pending-overlay.spec.ts
bun run --cwd apps/web e2e -- web-pwa.spec.ts pending-overlay.spec.ts
bun run check:pr
bun run check:diff-coverage
```

Passed after the audit repair pass:

- `bun run format`
- `bun run test:mutation -- --package client-replica`: 82.3% (floor 72%).
- Client focused suites: 6 files / 87 tests, including immutable replacement, concurrent replacement serialization, interrupted-handoff recovery, truthful discard, declaration-scoped and canonical-row revision identity, Tally's one-revision session route, pending-foreign-key enqueueing, exact query-row provenance, and the inline Locker secret boundary.
- Native focused suites: 3 files / 15 tests, including the mounted-provider Tally restart, Hermes-without-`structuredClone`, multi-vault retry/replacement recovery, and driver-counted overlay pushdown.
- Blueprint focused suites: 4 files / 16 tests, including pure settle/expire transitions, the Tally one-write pending edit path, online-only Locker calls, and non-secret Locker item projections.
- Desktop gateway-store suites: 2 files / 13 tests plus desktop typecheck.
- Electron production pending-overlay journey: 1 passed; emitted `artifacts/e2e/ui-impact/issue-738-pending-write-overlay.png`.
- PWA production pending-overlay journey plus existing isolation smoke: 2 passed.
- `bun run check:pr`: passed all 39 push gates, including all 35 repository
  typecheck tasks, the type-aware policy suite, the full affected test suite, and
  the diff-coverage gate.

## Audit

PASS — the final independent frozen-tree audit found no substantive blockers.
It verified the exact 148-path manifest, byte-identical protected outbox/schema
files, production Electron/PWA/native routes, replacement and settlement
semantics, all eight blueprint contracts, measured latency budgets, and the
exact green PR gate recorded above.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | codex | 019feedb-0022-7060-976c-d65be56924b1 |
