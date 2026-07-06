# issue-290 — data into the vault: scenario seeds, file-drop imports, connectors-as-published-code

GitHub issue: [#290](https://github.com/srikanth235/centraid/issues/290)

First principle: **agents write code, not data.** The harness owns auth and
reach; the gateway/vault owns contracts and audit; the LLM appears at
authoring/repair time, never in the per-sync loop. Four phases, each landing
as its own commit series.

## Checklist

Phase 1 — scenario seeds:

- [x] Commit 1 — vault demo register
- [x] Commit 2 — host wiring, generators, shell

Phase 2 — file-drop import spine:

- [x] Commit 3 — vault import spine
- [x] Commit 4 — gateway + shell import surface

Phase 3 — interactive one-shot pulls:

- [ ] Commit 5 — `sync.stage_rows` / `sync.publish_batch` typed commands:
  agents stage freely, publishing parks for the owner (risk asymmetry is the
  consent story)

Phase 4 — connections + broker invariants:

- [ ] Commit 6 — vault: connection cursors + run log; connector runtime
  contract (principal pinning, requires-as-allowlist, `ctx.agent` forbidden
  in connector handlers, liveness states)

## What changed

Commit 1 — vault demo register:

- `packages/vault/src/schema/seed.ts` (new) — `consent_seed_row` DDL +
  the `seed.demo` / `seed.purge` provenance activity constants.
- `packages/vault/src/schema/migrate.ts` — v6 migration step (SEED_DDL).
- `packages/vault/src/schema/tables.ts` — `consent.seed_row` joins the
  logical↔physical registry.
- `packages/vault/src/gateway/types.ts` — `InvokeRequest.demo?: {appId}`,
  the demo register flag.
- `packages/vault/src/gateway/gateway.ts` — owner-only gate on demo
  invokes (receipted deny otherwise); agent-credentialed reads structurally
  exclude registered demo rows; the change feed skips `seed.demo`
  provenance; `purgeDemo` / `demoStatus` owner surfaces.
- `packages/vault/src/gateway/execution.ts` — demo writes stamp
  `seed.demo` provenance (command name kept in `used_json`) and register
  in `consent_seed_row` inside the command transaction; `pkColumn`
  exported for the purge and the read exclusion.
- `packages/vault/src/gateway/demo.ts` (new) — newest-first multi-pass
  purge with FK-blocked honesty, `seed.purge` provenance, one receipt;
  per-app status counts.
- `packages/vault/src/gateway/demo.test.ts` (new) — 9 tests: register
  semantics, provenance, non-owner deny, agent-read + change-feed
  exclusion, purge (full / per-app / blocked / owner-only).
- `packages/vault/src/index.ts` — exports.

Commit 2 — host wiring, generators, shell:

- `packages/app-engine/src/index.ts` — `runHandler` exported for host
  surfaces that run app-authored modules outside the dispatcher.
- `packages/gateway/src/serve/vault-plane.ts` — `demoBridgeFor` (owner
  credential + demo register; read/search/invoke/describe only),
  `purgeDemo`, `demoStatus`.
- `packages/gateway/src/serve/vault-registry.ts` — `demoBridgeFor`
  passthrough against the active vault.
- `packages/gateway/src/routes/demo-routes.ts` (new) —
  `GET/POST/DELETE /centraid/_vault/demo[/<appId>]`.
- `packages/gateway/src/serve/build-gateway.ts` — route mounted before
  the generic `_vault` handler.
- `packages/gateway/src/serve/demo-seed.test.ts` (new) — end-to-end: all
  four shipped generators run in the real worker through the demo bridge,
  provenance/registry agree, purge leaves domain tables empty.
- `packages/blueprints/apps/tasks/seed.js`,
  `packages/blueprints/apps/notes/seed.js`,
  `packages/blueprints/apps/people/seed.js`,
  `packages/blueprints/apps/tally/seed.js` (new) — scenario generators
  (relative dates, deterministic from `input.seed`).
- `packages/blueprints/manifest.json` — regenerated (seed.js in file lists).
- `apps/desktop/src/renderer/gateway-client-vault.ts` — demo client calls.
- `apps/desktop/src/renderer/app-vault.ts` — "Demo data" section in the
  per-app Vault tab (load / reset).
- `apps/desktop/src/renderer/styles.css` — demo actions row style.
- `receipts/issue-290-data-flows-connectors.md` (this receipt).

Commit 3 — vault import spine:

- `packages/vault/src/schema/sync.ts` (new) — the sync domain DDL (v7):
  `sync_connection` (kind/label/principal/status/trust),
  `sync_external_entity` (the universal `(connection, external_id) → entity`
  map with content hash + `gone_upstream`), `sync_import_batch` +
  `sync_import_row` (the staging band), `sync_connection_cursor` +
  `sync_connection_run` (phase-4 runtime state, defined with the domain).
- `packages/vault/src/schema/migrate.ts` — v7 step.
- `packages/vault/src/schema/tables.ts` — `sync.*` joins the registry.
- `packages/vault/src/ingest/staging.ts` (new) — the spine:
  `ensureConnection`, `stageCandidates` (map-hash dispositioning + domain
  probes), `publishBatch` (one transaction, per-entity `import.<kind>`
  provenance, map upsert incl. adopted rows, per-row failure honesty, one
  batch receipt), `discardBatch`.
- `packages/vault/src/ingest/publishers.ts` (new) — per-entity appliers:
  core.event (ical_uid), core.party (identifier resolution + handle
  backfill; the vault wins — imports never rewrite a person's name),
  social.message (thread find-or-create by normalized subject, sender
  party resolve-or-mint, canonical content bodies), core.transaction
  (account find-or-create by name).
- `packages/vault/src/ingest/mbox.ts` (new) — RFC 4155 parsing (headers,
  mboxrd unquoting, address + thread-key extraction).
- `packages/vault/src/ingest/csv.ts` (new) — statement CSV parsing
  (RFC 4180 fields, column aliases, signed amounts → minor units).
- `packages/vault/src/ingest/zip.ts` (new) — minimal central-directory
  ZIP reader (stored + deflate) for Takeout archives.
- `packages/vault/src/ingest/stage-file.ts` (new) — extension routing,
  Takeout recursion into one mixed batch, unrouted entries reported.
- `packages/vault/src/ingest/import.ts` — ICS/vCard wrappers rebased onto
  the spine (stage + publish in one act; contract preserved).
- `packages/vault/src/commands/merge.ts` (new) — `core.merge_party`:
  engine FKs discovered via `PRAGMA foreign_key_list`, polymorphic
  (type, id) follow, identifiers demote-never-drop, uniqueness collisions
  dedupe, external-id map re-targets; risk `high`.
- `packages/vault/src/commands/parties.ts` — merge registration.
- `packages/vault/src/gateway/gateway.ts` — `stageImportFile` /
  `publishImport` / `discardImport` owner surfaces.
- `packages/vault/src/ingest/staging.test.ts` (new) — 7 tests: staged
  drafts, re-import skip/update, discard, MBOX threading, CSV accounts,
  Takeout zip routing, owner-only.
- `packages/vault/src/commands/merge.test.ts` (new) — 3 tests: full
  re-point + demotion + map, owner-merge refusal, self-merge refusal.
- `packages/vault/src/index.ts` — exports.

Commit 4 — gateway + shell import surface:

- `packages/gateway/src/routes/import-routes.ts` (new) —
  `POST/GET /centraid/_vault/imports`, `GET /imports/<batchId>`,
  `POST /imports/<batchId>/publish|discard` (128 MB body cap for
  mailboxes/Takeouts).
- `packages/gateway/src/routes/import-routes.test.ts` (new) — over-HTTP:
  stage → review → publish → history; unroutable file is a clean 400.
- `packages/gateway/src/serve/build-gateway.ts` — route mounted.
- `apps/desktop/src/renderer/gateway-client-vault.ts` — import client calls.
- `apps/desktop/src/renderer/app-import.ts` (new) — the Import settings
  page: file picker → staged draft with disposition rows → Publish/Discard,
  plus history.
- `apps/desktop/src/renderer/app-settings.ts` — Import page registered
  (Account section).
- `apps/desktop/src/renderer/styles.css` — import row/history styles.

## Decisions

- **Registry beside provenance, not instead of it.** The issue said
  "provenance is what makes demo data safe"; condition triggers evaluate
  consented reads over vault rows, which cannot join journal.db — so the
  vault-side `consent_seed_row` registry carries the exclusion and the
  purge, while `seed.demo` provenance stays the journal-side truth. One
  extra table, no per-domain `is_demo` columns.
- **Agent-plane exclusion is identity-shaped, not trigger-shaped.** All
  agent-credentialed reads exclude demo rows (not just trigger
  evaluations): automations and the assistant's enrolled agent never act
  on scenario data. Owners and apps see demo rows — rendering them is the
  scenario's point. `search` for agent credentials does not yet exclude
  demo rows (noted limitation; triggers ride `read`/`changes`, which do).
- **Blocked purge over forced purge.** A demo row a non-demo FK still
  references is reported blocked and stays registered, rather than
  cascading a delete through real data.
- **Generators are code, not a fixtures DSL** (per the standing
  handler-is-source-of-truth doctrine): `seed.js` runs in the same worker
  sandbox as app handlers with `ctx.vault` bound to the demo bridge.
- **Staging is a band of rows, not a draft twin of every canonical table.**
  The issue sketched "generalize the ext draft-twin"; twinning every
  canonical table for imports would explode DDL for no review benefit.
  `sync_import_row` (payload JSON + disposition + target) delivers the same
  gesture — draft → review diff → publish — with one table.
- **The sync schema is `sync.*`, not `core.*`.** The issue's "core.connection
  domain" wording is honored as its own schema namespace, consistent with
  how every other domain landed (locker, tally, people); consent scopes can
  name it as a unit.
- **Adopted rows join the map on publish.** A probe hit (row the vault
  already held) records a `sync_external_entity` entry with the candidate's
  hash, so the NEXT import of the same source diffs instead of re-probing —
  the upgrade from append-on-dedup to true sync.
- **Programmatic ICS/vCard imports stay one-call** (stage + publish in the
  same act) — the pre-spine contract and tests hold; only owner-facing file
  drops pause at review.
- **Merge fallback rule:** a re-pointed row that trips a uniqueness
  constraint means the survivor already holds that relation — the duplicate
  deletes, EXCEPT identifiers, which demote to non-primary (a handle is
  never lost in a merge).

## Out of scope

- OAuth machinery in the vault (harness-ambient credentials are the bet —
  see the issue's decision 4).
- Bidirectional sync / write-back to sources.
- Argument-level tool scoping (confinement is tool-level).
- A capability-abstraction layer over MCP (connections pin concrete tools).
- Migrating existing vaults' data (v0: no data migrations; new tables land
  as forward-only schema steps).

## Verification

- Phase 1: vault 257 tests green (incl. 9 new demo-register tests);
  gateway 143 green (incl. the seed end-to-end suite running all four
  shipped generators through the real worker + demo bridge, then purging
  clean); app-engine 224 green; blueprints 95 green; typecheck green across
  vault/gateway/app-engine/blueprints/desktop.

- Phase 2: vault 267 tests green (incl. 7 staging + 3 merge tests over the
  new spine; the pre-spine ingest suite passes unchanged on the rebased
  wrappers); gateway 145 green (incl. the over-HTTP import-route suite);
  desktop typecheck green.

```sh
npx turbo run typecheck test \
  --filter=@centraid/vault --filter=@centraid/gateway \
  --filter=@centraid/app-engine --filter=@centraid/blueprints
```

- The desktop Vault-tab demo section and the Import settings page were not
  interactively click-tested.

## Audit

1. **"## What changed" faithfully describes the diff (Commits 1–4, both committed and working-tree)**: PASS — Receipt fully describes all 35 files across Phase 1 (Commits 1–2, both landed on main) and Phase 2 (Commits 3–4, working-tree staged/untracked). Commit 3 spine file counts: sync.ts DDL (1), staging.ts (2 core + 1 test), publishers.ts (1), mbox.ts (1), csv.ts (1), zip.ts (1), stage-file.ts (1), merge.ts (2 core + 1 test) = 10 files. Commit 4 surface: import-routes.ts (2 core + 1 test), app-import.ts (1), gateway-client-vault.ts additions, app-settings.ts, styles.css (5 files). All changes to migrate.ts, schema/tables.ts, parties.ts, import.ts, gateway.ts, build-gateway.ts are present in the diff. No omissions or misrepresentations.

2. **Each [x] checklist item is realized (Commits 1–4)**: PASS — Phase 1 Commits 1–2: all 21 items present in git log (demo register, generators, purge, shell demo section). Phase 2 Commit 3: 8 checklist items — (a) sync domain DDL (sync.ts v7 migration step, tables.ts registry, schema precisely matches receipt: connection/external_entity/import_batch/import_row/connection_cursor/connection_run), (b) staging spine (staging.ts ensureConnection/stageCandidates/publishBatch/discardBatch, publishers.ts per-entity appliers for event/party/message/transaction), (c) file ingesters (mbox.ts RFC 4155, csv.ts RFC 4180, zip.ts Takeout recursion, stage-file.ts extension routing), (d) merge command (merge.ts core.merge_party with PRAGMA discovery + polymorphic re-point + identifier demotion), (e) gateway surfaces (gateway.ts stageImportFile/publishImport/discardImport owner-only), (f) ingest tests (staging.test.ts 7 tests, merge.test.ts 3 tests, both cover named scenarios), (g) vault exports (index.ts exports staging/publishers/mbox/csv/zip/stageFile). Phase 2 Commit 4: 4 checklist items — (a) import routes (import-routes.ts POST/GET /imports, 128 MB cap, import-routes.test.ts over-HTTP suite), (b) gateway mount (build-gateway.ts route mounted), (c) desktop client (gateway-client-vault.ts import client calls vaultImportStage/List/Rows/Publish/Discard), (d) import page (app-import.ts 201 lines, app-settings.ts registration, styles.css import row/history styling). All 12 Phase 2 items verified.

3. **The "## Checklist" mirrors issue #290's phased scope**: PASS — Issue #290 "Suggested phasing" phase 2 reads: "File-drop imports — Takeout/CSV/MBOX importers over the existing ingest/ spine; generalized staging band + review diff; external_entity map; core.merge_party." Receipt Commits 3–4 deliver exactly: (1) file ingesters (mbox/csv/zip) = done, (2) staging band (sync_import_batch/sync_import_row + stageCandidates/publishBatch) = done, (3) external_entity map (sync_external_entity with connection-id/external_id PK) = done, (4) merge (core.merge_party command with FK re-point + polymorphic handling) = done. Decision 6 policy stances (vault wins conflicts, upstream deletions never delete, one-way ingestion) are encoded in sync.ts schema design (gone_upstream flag, update-not-overwrite staging logic, no write-back columns). The scope exactly matches the phasing outline in issue #290.

## Steering

1. **Human-steering events (interrupts / redirects mid-task) recorded in the ledger**: PASS — Session 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 has no mid-work steering corrections. All user messages are forward-working: design-phase clarifications precede `/goal` (scope-setting, not steering), and Phase 1 + Phase 2 execution shows no interrupts or mid-task redirects. The transcript contains only task messages, goal directives, and continuation prompts — no evidence of user-initiated course corrections or architectural pivots once work began.

2. **No non-steering messages are recorded as steering**: PASS — Zero false positives. The `/goal` command and "continue" prompts are task-control directives (scope-setting and execution triggers), not mid-work interrupts. Design-phase feedback ("the direction is...") is exploration-phase ordinary conversation. The transcript correctly reflects that Phase 1 and Phase 2 execution proceeded uninterrupted by user corrections to the original scope or approach.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-18f9dd6d-2f0-1783304512-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 49384 | 1605952 | 53235842 | 283952 | 1939288 | 88.0017 | 49384 | 1605952 | 53235842 | 283952 | feat(vault): the demo register — seed.demo provenance, seed registry, one-act pu |
| claude-code-18f9dd6d-2f0-1783304548-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2068 | 1164 | 633976 | 636 | 3868 | 0.7010 | 51452 | 1607116 | 53869818 | 284588 | feat(vault): the demo register — seed.demo provenance, seed registry, one-act pu |
| claude-code-18f9dd6d-2f0-1783304591-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 6 | 16863 | 952710 | 1110 | 17979 | 1.2191 | 51458 | 1623979 | 54822528 | 285698 | x |
| claude-code-18f9dd6d-2f0-1783304861-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 12946 | 49365 | 6293822 | 34402 | 96713 | 8.7604 | 64404 | 1673344 | 61116350 | 320100 | feat(vault): the demo register — seed.demo provenance, seed registry, one-act pu |
| claude-code-18f9dd6d-2f0-1783304890-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2 | 4987 | 344595 | 139 | 5128 | 0.4139 | 64406 | 1678331 | 61460945 | 320239 | feat(vault): the demo register (#290)Issue: #290 |
| claude-code-18f9dd6d-2f0-1783304916-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2 | 229 | 349582 | 132 | 363 | 0.3591 | 64408 | 1678560 | 61810527 | 320371 | xIssue: #290 |
| claude-code-18f9dd6d-2f0-1783304982-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 656 | 7426 | 2106176 | 7003 | 15085 | 2.5557 | 65064 | 1685986 | 63916703 | 327374 | feat(vault): the demo register — seed.demo provenance, seed registry, one-act pu |
| claude-code-18f9dd6d-2f0-1783305013-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 4 | 3134 | 706978 | 1024 | 4162 | 0.7974 | 65068 | 1689120 | 64623681 | 328398 | feat(gateway+blueprints+desktop): scenario seeds — generators, demo bridge, rout |
| claude-code-18f9dd6d-2f0-1783305041-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2 | 582 | 355056 | 133 | 717 | 0.3690 | 65070 | 1689702 | 64978737 | 328531 | xIssue: #290 |
| claude-code-18f9dd6d-2f0-1783305072-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 6 | 5166 | 1066914 | 2523 | 7695 | 1.2577 | 65076 | 1694868 | 66045651 | 331054 | feat(gateway+blueprints+desktop): scenario seeds — generators, demo bridge, rout |
| claude-code-18f9dd6d-2f0-1783305101-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2 | 1011 | 357360 | 437 | 1450 | 0.3919 | 65078 | 1695879 | 66403011 | 331491 | feat(gateway+blueprints+desktop): scenario seeds — generators, demo bridge, shel |
| claude-code-18f9dd6d-2f0-1783306222-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 17187 | 213298 | 43248152 | 198299 | 428784 | 56.0012 | 82265 | 1909177 | 109651163 | 529790 | feat(vault): the import spine — sync domain, staging band, file-drop customs, co |
| claude-code-18f9dd6d-2f0-1783306260-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2 | 1939 | 455325 | 658 | 2599 | 0.5125 | 82267 | 1911116 | 110106488 | 530448 | feat(vault): import spine — sync domain, staging band, merge_party (#290)One ing |
