# issue-450 — Deferred ontology, blueprint, and data-trigger backlog

GitHub issue: [#450](https://github.com/srikanth235/centraid/issues/450)

## Checklist

- [x] Track 1 §1: consolidate People debts, tasks, relationships, interactions, and journal entries onto the Tally, Schedule, Core, and Knowledge mechanisms
- [x] Track 1 §1: retain the genuine People CRM rows and settle the People/Tally grant boundary
- [x] Track 1 §2: make demo purge, party merge, and domain hard-deletes consume the polymorphic-reference registry
- [x] Track 1 §3: enforce home purchase, business invoice-total, and event organizer/chair reconciliation invariants
- [x] Track 1 §4: add `updated_at`, converge single-target polymorphic column names, and document the two recurrence encodings
- [x] Track 1 §5: cover `browseUpdateRow` at the UI level and expose Tally's expense trash shelf/restore action
- [x] Track 1 §6: deliberately retain the `last_contacted_at` ground-fact semantics and re-scrutinize the polymorphic exclusion lists
- [x] Track 2: README lead/layout describe install-in-place UI apps and cloned automations
- [x] Track 2: runtime docs distinguish `POST /centraid/_apps/_install` from `POST /centraid/_apps/_clone`
- [x] Track 2: `src/index.ts` documents scaffold, clone, and install-in-place paths
- [x] Track 2: typecheck and governance pass
- [x] Track 3: a live gateway fires a watched data automation in well under one second
- [x] Track 3: a missed ring is recovered by the cron/cursor backstop exactly once after reopen
- [x] Track 3: burst writes coalesce into one off-cycle evaluation pass
- [x] Track 3: the doorbell runs only after provenance is durable and cannot fail the committed write
- [x] Track 3: condition triggers remain poll-only, the cron backstop remains, and the default cadence is unchanged
- [x] Tests, build, CI checks, and governance are green

## What changed

### Track 1 — ontology and Atlas tail

**People now composes canonical mechanisms.** The duplicate People mechanisms are removed from DDL, FTS, table metadata, commands, app queries, and demo scenarios. People commands now write `tally_obligation` for IOUs, `schedule_task` for reminders, provenance-stamped `core_link` rows for relationships, `core_activity` plus `knowledge_annotation` for interactions, and `knowledge_note` for journal entries. Gift ideas also become typed `schedule_task` rows linked to their recipient with the controlled `gift-for` relation; the existing `people.add_gift`/`toggle_gift` app API projects `needs-action`/`completed` back to `idea`/`given`. Only `people_profile` and `people_important_date` remain as People tables. Tally folds obligations into its derived balances, while People receives the Tally scopes it needs and Tally stays independent of the People schema; an app-credential test executes the cross-pack command and reads the result through the declared Tally scope.

**Polymorphic cleanup is registry-driven at every destructive site.** Demo purge calls `cleanupPolyRefs`; party merge derives its repoint pairs from `POLY_REF_REGISTRY`; and hard-delete commands for concepts, parties, locker items, notes/documents, and finance budgets clean references in the same transaction as deleting their row. Single-target mechanisms now consistently use physical `target_type`/`target_id` columns (attachments, outbox items, enrich requests/embeddings, sync mappings, and seed rows); the registry retains the intentionally directional `core_link` endpoint pairs. The exclusion maps remain documented historical/non-polymorphic exceptions and their census test still prevents vacuous closure.

**Stored facts reconcile with their projections.** Bound `home_asset_item` prices/currencies must match the acquisition transaction, and the Home command projects the bound values. Business invoice lines maintain the invoice total; a new invoice must start at zero before child lines exist, and direct inconsistent inserts or updates are rejected. Schedule DDL documents and enforces the organizer/chair direction: a chair must be the organizer, and changing an organizer while a different chair exists is rejected. Tests exercise insert and update failures as well as the valid paths.

**Conventions and UI gaps are closed.** A shared trigger helper adds and maintains `updated_at` on editable People, Social, Tally, Home, and Business rows. DDL comments explain why recurring events/reminders use RFC 5545 `rrule` while weekly availability uses a compact weekday mask. Atlas Browse has a UI-level edit test that verifies `browseUpdateRow`, and Tally now shows trashed expenses with a Restore action backed by the existing journalled restore command. The ontology version advances from 1.3 to 1.4 and affected bundled-app versions/manifests advance with their changed contract.

**The audit caveats are explicit decisions.** `people_profile.last_contacted_at` remains an owner-gesture ground fact, deliberately unlike the rebuildable Social thread projection. `POLY_REF_EXCLUSIONS` remains limited to append-only/history/outbox mechanisms whose subject must survive deletion; `NON_POLY_PAIRS` remains the documented census of coincidental enum/id pairs.

### Track 2 — blueprint lifecycle docs

`packages/blueprints/README.md` now leads with the post-#434 lifecycle: bundled UI apps are installed in place, acquire declared-scope grants, serve from the shipped package, upgrade with the release, and retain their data when uninstall revokes access. Automation templates are cloned into owner-editable code and remain the builder/compiler path. The runtime section separately documents `_install` and `_clone`, including grants, upgrade behavior, and uninstall semantics. The package header documents all three authoring/lifecycle paths: scaffold, automation clone, and UI install-in-place; the builder remains a dev-only v1 surface behind `builderEnabled`.

### Track 3 — push-nudge data triggers

`LocalScheduler` gains a fire-and-forget `nudge(entityTypes?)`. `InProcessScheduler` records data-watch entity kinds, coalesces nearby hints in a fixed 25 ms window, filters to intersecting data triggers, bypasses the minute de-duplication gate, and routes failures through the existing scheduler error path. Per-trigger evaluations are single-flight across both nudge and minute-tick callers, with at most one dirty rerun, so two callers cannot read/advance the same cursor concurrently. Condition watches are deliberately excluded. Reconcile now bootstraps new/changed data cursors before publish is considered ready; a bootstrap failure restores the previous registry and rejects publish so the next reconcile retries rather than losing the first real change.

The gateway injects an `onProvenanceCommitted` seam into each vault plane and connects it to that vault's scheduler under `runWithVaultContext`. Every steady-state write path rings only after its journal provenance writes have completed: owner/app command execution, replica finalization, import publishing, demo operations, duty/sweep paths, and grant/revoke administration. The callback carries only entity kinds, never row payloads, and callback failure cannot turn a durable vault write into a failure.

The standing cron evaluation path is unchanged and remains the correctness backstop for a dropped doorbell, crash recovery, restore/replay, or a future out-of-process writer. The live integration test publishes a real data-triggered automation, proves a committed `core.party` write creates a run in under one second, proves eight committed writes in one burst create one evaluation/fire, then simulates the recoverable kill window by making provenance durable while dropping the best-effort ring. Reopening the vault catches that row once and advances the cursor once; a scheduler test separately drives the minute tick over the same persisted-cursor/offline-write state and proves exactly-once advancement.

### Changed-file inventory

Every non-receipt path in the change set is listed verbatim here:

- `packages/automation/src/fire/in-process-scheduler.test.ts`
- `packages/automation/src/fire/in-process-scheduler.ts`
- `packages/blueprints/README.md`
- `packages/blueprints/apps/agenda/app.json`
- `packages/blueprints/apps/agenda/queries/search.ts`
- `packages/blueprints/apps/agenda/queries/upcoming.ts`
- `packages/blueprints/apps/notes/app.json`
- `packages/blueprints/apps/notes/queries/library.ts`
- `packages/blueprints/apps/notes/queries/search.ts`
- `packages/blueprints/apps/people/app.json`
- `packages/blueprints/apps/people/app.tsx`
- `packages/blueprints/apps/people/queries/dashboard.ts`
- `packages/blueprints/apps/people/queries/journal.ts`
- `packages/blueprints/apps/people/queries/person.ts`
- `packages/blueprints/apps/people/seed.js`
- `packages/blueprints/apps/photos/queries/_shared.ts`
- `packages/blueprints/apps/tally/actions/restore-expense.ts`
- `packages/blueprints/apps/tally/app.json`
- `packages/blueprints/apps/tally/app.tsx`
- `packages/blueprints/apps/tally/components/Dashboard.module.css`
- `packages/blueprints/apps/tally/components/Dashboard.tsx`
- `packages/blueprints/apps/tally/logic.ts`
- `packages/blueprints/apps/tally/queries/dashboard.ts`
- `packages/blueprints/apps/tally/types.ts`
- `packages/blueprints/apps/tasks/app.json`
- `packages/blueprints/apps/tasks/queries/board.ts`
- `packages/blueprints/apps/tasks/queries/search.ts`
- `packages/blueprints/index.json`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/app-boot-harness.ts`
- `packages/blueprints/src/app-boot/tally.test.ts`
- `packages/blueprints/src/index.ts`
- `packages/client/src/react/screens/AtlasBrowseTab.test.tsx`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/serve-scheduler-reconcile.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/blob/semantic-contributions.ts`
- `packages/vault/src/commands/attachments.test.ts`
- `packages/vault/src/commands/attachments.ts`
- `packages/vault/src/commands/business.test.ts`
- `packages/vault/src/commands/documents.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/finance.ts`
- `packages/vault/src/commands/home.test.ts`
- `packages/vault/src/commands/home.ts`
- `packages/vault/src/commands/knowledge.ts`
- `packages/vault/src/commands/locker.ts`
- `packages/vault/src/commands/merge.test.ts`
- `packages/vault/src/commands/merge.ts`
- `packages/vault/src/commands/outbox.test.ts`
- `packages/vault/src/commands/outbox.ts`
- `packages/vault/src/commands/people.test.ts`
- `packages/vault/src/commands/people.ts`
- `packages/vault/src/commands/schedule.test.ts`
- `packages/vault/src/enrich/leases.test.ts`
- `packages/vault/src/enrich/leases.ts`
- `packages/vault/src/enrich/similarity.ts`
- `packages/vault/src/gateway/assistant-context.ts`
- `packages/vault/src/gateway/demo.test.ts`
- `packages/vault/src/gateway/demo.ts`
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/gateway/gateway.test.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/search.test.ts`
- `packages/vault/src/ingest/mbox-attachments.test.ts`
- `packages/vault/src/ingest/publishers.ts`
- `packages/vault/src/ingest/staging.test.ts`
- `packages/vault/src/ingest/staging.ts`
- `packages/vault/src/schema/core.ts`
- `packages/vault/src/schema/domains-health-finance-schedule.ts`
- `packages/vault/src/schema/domains-home-business.ts`
- `packages/vault/src/schema/domains-people.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `packages/vault/src/schema/domains-tally.ts`
- `packages/vault/src/schema/enrich.ts`
- `packages/vault/src/schema/fts.ts`
- `packages/vault/src/schema/migrate.test.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/src/schema/outbox.ts`
- `packages/vault/src/schema/poly-refs.ts`
- `packages/vault/src/schema/seed.ts`
- `packages/vault/src/schema/sync.ts`
- `packages/vault/src/schema/tables.ts`
- `packages/vault/src/schema/updated-at.ts`

## Verification

```sh
bun run ci
bun run build
bun run --filter @centraid/blueprints test
bunx turbo run test \
  --filter=@centraid/vault \
  --filter=@centraid/automation \
  --filter=@centraid/client \
  --concurrency=1
(cd packages/gateway && bun run test -- --maxWorkers=1 --minWorkers=1)
.governance/run.sh
git diff --check
```

Results: the final `bun run ci` is green across formatting, oxlint, package lint, 28 typecheck/build tasks, type lint, and CSS lint. Production build is green for all 14 build tasks. The affected-package graph (Blueprints, Vault, Automation, Client, Gateway) passes all 18 tasks; focused audit-fix coverage passes Automation scheduler 17/17, Vault 71/71 across six files, Blueprint app boot 2/2, and live Gateway scheduler/demo 5/5. Final outbox convention coverage passes 21/21 across outbox, poly-ref census, and assistant-context tests. The full final Gateway suite passes 106 files / 754 tests with 2 skips using one worker. Earlier full runs also recorded Blueprints 30 files / 222 tests and Client 131 files / 1,013 tests. Parallel Gateway attempts exhausted local resources and produced timeout/cancellation noise; the same full suite is green with the documented single-worker command. Governance and `git diff --check` pass.

Checklist crosswalk:

- Track 1 §1: consolidate People debts, tasks, relationships, interactions, and journal entries onto the Tally, Schedule, Core, and Knowledge mechanisms — realized in `domains-people.ts`, People commands/queries, `domains-tally.ts`, Tally balance queries, and demo code.
- Track 1 §1: retain the genuine People CRM rows and settle the People/Tally grant boundary — only profiles and important dates remain; the installed-app credential test covers cross-pack access.
- Track 1 §2: make demo purge, party merge, and domain hard-deletes consume the polymorphic-reference registry — covered by registry calls and cleanup/closure tests.
- Track 1 §3: enforce home purchase, business invoice-total, and event organizer/chair reconciliation invariants — covered by DDL guards, command projections, and focused failure/valid-path tests.
- Track 1 §4: add `updated_at`, converge single-target polymorphic column names, and document the two recurrence encodings — covered by `schema/updated-at.ts`, canonical physical columns, DDL comments, and convention tests.
- Track 1 §5: cover `browseUpdateRow` at the UI level and expose Tally's expense trash shelf/restore action — covered by `AtlasBrowseTab.test.tsx`, Tally query/UI/action changes, and app-boot assertions.
- Track 1 §6: deliberately retain the `last_contacted_at` ground-fact semantics and re-scrutinize the polymorphic exclusion lists — recorded in the People contract and enforced by the poly-ref census tests.
- Track 2: README lead/layout describe install-in-place UI apps and cloned automations — implemented in the blueprint README.
- Track 2: runtime docs distinguish `POST /centraid/_apps/_install` from `POST /centraid/_apps/_clone` — implemented in the runtime section.
- Track 2: `src/index.ts` documents scaffold, clone, and install-in-place paths — implemented in the package header.
- Track 2: typecheck and governance pass — reproduced by the commands and results above.
- Track 3: a live gateway fires a watched data automation in well under one second — covered by `serve-scheduler-reconcile.test.ts`.
- Track 3: a missed ring is recovered by the cron/cursor backstop exactly once after reopen — covered by the live restart and direct minute-tick tests.
- Track 3: burst writes coalesce into one off-cycle evaluation pass — covered by timed scheduler and eight-write live-gateway tests.
- Track 3: the doorbell runs only after provenance is durable and cannot fail the committed write — covered by callback-order and error-isolation tests across write paths.
- Track 3: condition triggers remain poll-only, the cron backstop remains, and the default cadence is unchanged — covered by scheduler filtering/cadence tests and the unchanged cron path.
- Tests, build, CI checks, and governance are green — reproduced by the commands and final results above.

## Decisions

- **Gift ideas are canonical tasks, not a third People table.** `people.add_gift` creates a `schedule_task` linked to the recipient by the controlled `gift-for` relation; task status projects to the existing `idea`/`given` UI. This preserves the feature while honoring the issue's explicit two-table People boundary.
- **Obligations are ground facts, balances remain projections.** `tally_obligation` records an IOU, not a running balance; Tally derives group/member balances by folding obligations with expense splits.
- **Single-target pairs use `target_*`; directional links do not.** `core_link.from_*`/`to_*` encode two meaningful endpoints and are intentionally exempt from the single-target naming convention.
- **Invoice totals are maintained projections.** Keeping `total_minor` preserves the existing API/query shape, while line triggers and command guards make disagreement impossible through supported writes.
- **Organizer/chair disagreement is rejected.** Neither encoding silently overwrites the other; inserts and updates must preserve the documented directional equality, retaining iCal fidelity without divergence.
- **Reconcile awaits data-cursor bootstrap.** A newly published automation must establish its no-history watermark before the publish response returns; otherwise the first post-publish doorbell can be consumed by bootstrap and miss the first real change.
- **No cadence optimization in this PR.** The `* * * * *` data default, `*/5` condition default, and minute cron backstop stay unchanged; changing the backstop cadence remains the issue's explicitly separate optional follow-up.

## Out of scope

- Cross-process or cross-device doorbells; the persisted cursor and cron poll continue to provide correctness for remote/replayed writes.
- Push-nudging condition triggers; they remain windowed polls rather than change-feed tails.
- Changes to `changes()` range/limit behavior or the persisted cursor format.
- Relaxing the default data-trigger polling cadence.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f7436-51b-1784369837-1 | codex | 019f7436-51b8-7d43-a576-ecb61f41c177 | #450 | gpt-5.6-sol | 1544873 | 0 | 73753856 | 176891 | 1721764 | 24.9540 | 1544873 | 0 | 73753856 | 176891 | feat(vault): close deferred ontology and trigger backlog (#450) |

## Steering

**Verdict 1: Every steering event is recorded as a row in the Steering table.** PASS — The user supplied one initial goal to implement the full scope of issue #450 and create a PR. There were no mid-task corrections, interruptions, or redirections, so no steering row is required.

**Verdict 2: No non-steering message is recorded as steering.** PASS — The initial task assignment is not a steering event, and no table rows are present.

## Audit

### Round 1 — REFUTED

The Constitution-required fresh-context audit rejected the first frozen diff. It found: concurrent nudge/minute evaluations could race the same cursor; failed bootstrap was swallowed; invoice INSERT admitted a nonzero total before lines; the receipt misstated organizer and delete ordering; `people_gift` exceeded the issue's explicit two-table boundary; grant/burst/cron-backstop tests were weaker than their checked claims; and the receipt still said Audit was pending.

### Resolution

The scheduler now serializes each watch cursor, coalesces a real timed burst, retries a failed bootstrap and rejects publish readiness; invoice INSERT is guarded; gifts compose `schedule_task` + `core_link`; the installed People/Tally grant is exercised with an app credential; the live gateway drives eight committed writes through one burst and simulates the durable-provenance/pre-ring kill window; a separate minute-tick test proves the cron fallback advances once; and the organizer/delete prose is corrected above.

### Round 2 — REFUTED

The second fresh-context audit confirmed all eight Round 1 findings were closed and that the checklist mirrors the issue, but found one remaining physical `subject_type`/`subject_id` pair on `outbox_item` and found that this receipt did not yet carry the Constitution-required verbatim changed-file inventory.

### Resolution

`outbox_item` now uses physical `target_type`/`target_id` columns while preserving the existing command input contract, its exclusion note and graph-join test use the canonical names, and the complete non-receipt path inventory is recorded above.

### Round 3 — PASS

The third fresh-context audit found no blocking mismatch in the frozen diff:

- **Receipt fidelity — PASS.** `## What changed` accurately describes all three tracks, and the verbatim non-receipt path inventory matches the changed and untracked files.
- **Checklist and implementation — PASS.** Every checked item is implemented, including Track 2's four checkboxes and Track 3's five acceptance criteria.
- **Round 1 closure — PASS.** Cursor serialization, bootstrap failure propagation, invoice insert guarding, gift consolidation, grant/burst/backstop coverage, and corrected prose are present.
- **Round 2 closure — PASS.** `outbox_item` physically uses `target_type`/`target_id`, and every non-receipt path appears verbatim above.
- **Governance honesty — PASS.** The two prior REFUTED audits and their resolutions remain transparent; Steering records no unsupported events; the empty pre-commit Costs table is honest; and verification includes the reproducible single-worker Gateway command and resource-timeout note.
