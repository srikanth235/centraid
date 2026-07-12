# Issue #374 — SQLite hardening: STRICT coverage, missing FK indexes, unsafe-integer reads, ingest validation gap

https://github.com/srikanth235/centraid/issues/374

## Checklist

- [x] STRICT for ext-band tables and the conversation ledger
- [x] JS-safe-integer CHECK bounds on ext integer columns
- [x] External-id doc guardrail on ExtColumnSpec
- [x] FK covering indexes across vault.db and journal.db
- [x] Runtime payload validation for ingest publishers
- [x] Export degrades per-table instead of aborting
- [x] PRAGMA optimize on connection close
- [x] Periodic PRAGMA quick_check integrity probe

## What changed

### STRICT for ext-band tables and the conversation ledger

Tier 1. `extTableDdl()` in `packages/vault/src/schema/ext.ts` now emits
`CREATE TABLE "..." (...) STRICT;` — it was the only DDL generator in the
repo omitting the suffix every canonical table already carries. The five
conversation-ledger tables in `packages/app-engine/src/stores/gateway-db.ts`
(`conversations`, `turns`, `items`, `attachments`, `automation_state`) get
the same `STRICT` suffix; every declared column type was already
STRICT-legal (TEXT/INTEGER/REAL) and the sole writer (`ConversationStore`)
already normalizes booleans to 0/1, so no column or caller changes were
needed. Existing dev DBs keep their old tables (`IF NOT EXISTS` skips) —
consistent with the v0 recreate-on-change convention.

### JS-safe-integer CHECK bounds on ext integer columns

Tier 4.2. `columnDdl()` in `packages/vault/src/schema/ext.ts` appends
`CHECK ("<col>" IS NULL OR "<col>" BETWEEN -9007199254740991 AND 9007199254740991)`
to every declared `integer` column, and `columnAddDdl()` in
`packages/vault/src/gateway/ext.ts` applies the identical bound on the
ALTER TABLE ADD COLUMN path (shared as the exported
`JS_SAFE_INTEGER_BOUND`). An INTEGER past 2⁵³−1 stores fine but node:sqlite
`.get()/.all()` throw on read ("Value is too large to be represented as a
JavaScript number") — the CHECK turns that silent poisoned-row into a loud
write-time rejection. Generated DDL stays a pure function of the spec;
`canonicalSpecJson` is untouched, so no spurious ext-table diffs.

### External-id doc guardrail on ExtColumnSpec

Tier 4.1. Doc comment on `ExtColumnSpec.type` in
`packages/vault/src/schema/ext.ts` steering app/connector authors to `text`
for opaque external identifiers (platform snowflake IDs routinely exceed
2⁵³−1), mirroring the TEXT external-id convention `core.ts` already follows.

### FK covering indexes across vault.db and journal.db

Tier 2. Measured 122 FK child column-sets with no covering index as a
leftmost prefix (115 in vault.db, 7 in journal.db — SQLite never
auto-indexes the child side, so with `PRAGMA foreign_keys = ON` every
parent DELETE/UPDATE full-scanned every uncovered child, including
`commands/merge.ts`'s FK re-pointing). Added a covering index for each,
placed beside its table in the module that declares it:
`packages/vault/src/schema/core.ts` (29), `consent.ts` (11), `agent.ts` (3),
`sync.ts` (2), `domains-health-finance-schedule.ts` (17),
`domains-social-knowledge-media.ts` (14), `domains-home-business.ts` (21),
`domains-people.ts` (7), `domains-locker.ts` (1), `domains-tally.ts` (6),
`outbox.ts` (4), `journal.ts` (7). New regression test
`packages/vault/src/schema/fk-index.test.ts` walks
`PRAGMA foreign_key_list`/`index_list`/`index_info` over both files and
asserts the uncovered list stays empty, keeping future tables honest.
Composite-PK coverage (leftmost column counts as covered via the implicit
PK index) and gateway-enforced comment-only FKs handled correctly.

### Runtime payload validation for ingest publishers

Tier 3. New `packages/vault/src/ingest/payload-schemas.ts` declares JSON
schemas for all ten ingest payload shapes plus `assertPayload<T>()`, which
reuses the existing `validateJson` from `gateway/json-schema.ts` and throws
a field-level error caught by `applyBatchTx`'s per-row try/catch. All 18
bare `payload as unknown as X` casts in the create/update write paths of
`packages/vault/src/ingest/publishers.ts` (9 — `messagePublisher` has no
update) and `packages/vault/src/ingest/enrich-publishers.ts` (9 — same
seam, found along the way) now go through the gate, so no write path is exempt by
omission: a future connector feeding decimal-string amounts is rejected
before any SQL runs. Read-only `probe()` methods intentionally keep bare
casts (see Decisions).

### Export degrades per-table instead of aborting

Tier 4.3. `exportVault()` in `packages/vault/src/gateway/portability.ts`
wraps each entity's `SELECT *` in try/catch: on failure it records
`{entity, error}` into the new optional `VaultExport.skippedTables` and
continues, instead of one poisoned row anywhere aborting the entire
export. `verifyHash` covers exactly the tables that made it into the
artifact, so round-trip verification stays sound; the export receipt
`detail` carries `skippedTableCount`/`skippedTables`. `importVaultExport`
needed no change. No consumer currently assumes the artifact is exhaustive
(grepped: `exportVault` has no HTTP route or backup-engine caller yet).

### PRAGMA optimize on connection close

Tier 5. `close()` in `packages/vault/src/db.ts` runs `PRAGMA optimize` on
both the vault and journal handles before closing, each independently
try/caught so best-effort planner maintenance can never block the real
close. Previously the planner ran with zero statistics across 188 tables
while `gateway/sql.ts` allows arbitrary joins and recursive CTEs.

### Periodic PRAGMA quick_check integrity probe

Tier 5. New probe `packages/gateway/src/serve/vault-integrity-health.ts`
(`createVaultIntegrityHealthProbe`), registered in
`packages/gateway/src/serve/build-gateway.ts` beside the sibling probes,
runs `PRAGMA quick_check` on vault.db and journal.db for every mounted
vault: `ok` iff the sole result row is literally 'ok', otherwise `error`
with the first failure lines. Self-throttled to an hourly cadence per
vault (quick_check is a full logical scan, not a per-tick read), so silent
page corruption is caught while an uncorrupted backup generation still
exists.

### Files

- `packages/app-engine/src/stores/gateway-db.test.ts`
- `packages/app-engine/src/stores/gateway-db.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/vault-integrity-health.test.ts`
- `packages/gateway/src/serve/vault-integrity-health.ts`
- `packages/vault/src/db.test.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/gateway/ext.test.ts`
- `packages/vault/src/gateway/ext.ts`
- `packages/vault/src/gateway/portability.test.ts`
- `packages/vault/src/gateway/portability.ts`
- `packages/vault/src/ingest/enrich-publishers.ts`
- `packages/vault/src/ingest/payload-schemas.test.ts`
- `packages/vault/src/ingest/payload-schemas.ts`
- `packages/vault/src/ingest/publishers.ts`
- `packages/vault/src/schema/agent.ts`
- `packages/vault/src/schema/consent.ts`
- `packages/vault/src/schema/core.ts`
- `packages/vault/src/schema/domains-health-finance-schedule.ts`
- `packages/vault/src/schema/domains-home-business.ts`
- `packages/vault/src/schema/domains-locker.ts`
- `packages/vault/src/schema/domains-people.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `packages/vault/src/schema/domains-tally.ts`
- `packages/vault/src/schema/ext.ts`
- `packages/vault/src/schema/fk-index.test.ts`
- `packages/vault/src/schema/journal.ts`
- `packages/vault/src/schema/outbox.ts`
- `packages/vault/src/schema/sync.ts`
- `receipts/issue-374-sqlite-hardening.md`

## Decisions

- **gateway-db.ts brought in line, not exempted.** The issue asked for a
  conscious call on the app-engine ledger tables; STRICT everywhere is the
  repo convention, all column types were already STRICT-legal, and
  `IF NOT EXISTS` means existing dev DBs are untouched (v0, no-compat).
- **Integer CHECK bound generated for ALL ext integer columns**, not just
  doc guidance — the DDL is platform-generated (apps never run DDL), the
  issue verified the CHECK converts a read-crash into a write-time
  rejection, and nothing in the schema needs values past 2⁵³−1
  (`readBigInts: true` was considered and rejected in the issue for the
  same reason).
- **`probe()` methods keep bare casts.** Validation there would abort the
  whole staging batch (`stageBatchTx` calls `probe()` uncaught) instead of
  failing per-row like create/update inside `applyBatchTx`; the gate is
  scoped to write paths.
- **quick_check self-throttles hourly inside the probe** because the health
  registry snapshot calls every probe on every poll with no built-in
  interval mechanism.
- **Nullable payload fields are presence-checked but not union-typed** —
  the reused `validateJson` has no union support; the fields that actually
  needed hardening (amounts, confidence, byte sizes, enums) are strictly
  typed.

## Out of scope

- Reformatting the 44 files that fail `format:check` on the base commit
  (pre-existing debt from earlier merges; none are in this change set).
- The pre-existing `@centraid/blueprints` tokens-sync test failure
  (`vendor-tokens.mjs --check`) — no blueprint file is touched here.
- Hardening `importVaultExport` against a partial export that skipped a
  heavily-referenced table (post-load `foreign_key_check` can still fail;
  natural follow-up surfaced by the new portability test).
- Wiring `exportVault` to an HTTP route or the backup engine; whoever does
  must handle `skippedTables` rather than assume completeness.
- Union-type support in `gateway/json-schema.ts`'s `validateJson`.

## Verification

```sh
bun run ci                    # oxfmt --check + oxlint + turbo typecheck + lint:types
npx turbo run test --filter=@centraid/vault --filter=@centraid/gateway --filter=@centraid/app-engine
npx vitest run packages/vault/src/schema/fk-index.test.ts          # 2/2
npx vitest run packages/vault/src/gateway/ext.test.ts packages/vault/src/gateway/ext-sealed.test.ts  # 26/26
npx vitest run packages/vault/src/ingest                           # 20/20
npx vitest run packages/vault/src/gateway/portability.test.ts packages/vault/src/db.test.ts packages/gateway/src/serve/vault-integrity-health.test.ts  # 16/16
```

- STRICT for ext-band tables and the conversation ledger: generated ext DDL
  ends `STRICT` and a TEXT-into-INTEGER insert throws against a real
  `node:sqlite` DatabaseSync; `sqlite_master` confirms every ledger table's
  SQL ends `STRICT` (new tests in `ext.test.ts` and `gateway-db.test.ts`).
- JS-safe-integer CHECK bounds on ext integer columns: `9007199254740993n`
  is rejected at insert while the bound value `9007199254740991n` succeeds,
  on both CREATE-time and ALTER-added columns.
- FK covering indexes across vault.db and journal.db: audit walk went
  122 uncovered → 0; `fk-index.test.ts` asserts empty forever after.
- Runtime payload validation for ingest publishers: decimal-string
  `amountMinor` ("19.99") rejected before any row lands; missing required
  fields rejected; valid transaction/party payloads publish unchanged.
- Export degrades per-table instead of aborting: with `prepare` stubbed to
  throw node:sqlite's real too-large error for one entity, export
  completes, `skippedTables` names it, `verifyHash` validates against the
  partial artifact, and the artifact reimports cleanly.
- PRAGMA optimize on connection close: `close()` issues the pragma on both
  handles and still closes both if the pragma itself throws.
- Periodic PRAGMA quick_check integrity probe: healthy pair reports ok,
  quick_check failure surfaces as error with failure text, re-check happens
  only after the interval elapses (spy-counted), cached failures keep
  surfacing between re-checks.
- Full package suites: vault 55 files / 537 passed / 1 skipped
  (env-gated disk-full e2e), app-engine 23 files / 278 passed, gateway
  69 files / 477 passed / 2 skipped (independently re-run by the audit
  sub-agent; two publish-flow tests that timed out once under a fully
  parallel turbo run pass in isolation — parallel-load flakes, not
  regressions).
- Repo-wide gates on this diff: `typecheck` and `lint:types` green;
  `oxlint` reports 22 errors, none in this change set; `format:check`
  fails on 44 files on the base commit / 42 with this diff applied (the
  diff itself reformatted 2 previously-failing files, `build-gateway.ts`
  and `db.ts`) — none of the remaining failures are in this change set,
  and every changed file in this diff passes `format:check`.

## Audit

PASS — fresh-context audit against the diff, issue #374, and live working tree; all 8 checklist items are realized in the diff and the issue's full suggested scope (tiers 1, 2, 3, 4.1–4.3, 5a/5b) is covered, with the remaining issue threads (importVaultExport partial-export hardening, exportVault consumers, validateJson unions) honestly listed under Out of scope. Evidence: (1) file coverage exact — all 24 modified + 6 new files in the diff appear in the receipt's Files list, no omissions or phantom entries; (2) load-bearing claims spot-checked in source: `extTableDdl()` emits `) STRICT;` (packages/vault/src/schema/ext.ts:294), all 5 gateway-db.ts ledger tables end `) STRICT;`, `columnDdl`/`columnAddDdl` both append the JS_SAFE_INTEGER_BOUND (9007199254740991) CHECK, `exportVault()` records `skippedTables` per-table in try/catch with verifyHash over tables-as-assembled, `close()` runs `PRAGMA optimize` on both handles in independent try/catch (db.ts:232/237), and the quick_check probe is wired into build-gateway.ts; (3) FK tier independently recounted from the raw diff — the per-file index tally matches exactly (29+11+3+2+17+14+21+7+1+6+4+7 = 122) and fk-index.test.ts asserts the uncovered list `toEqual([])` against a live schema walk of both DBs; (4) the ingest count matches measurement — `grep -c assertPayload` returns 9 in publishers.ts (messagePublisher has create but no update) and 9 in enrich-publishers.ts, 18 total, with the only remaining `as unknown as` casts in read-only probe() paths as the Decisions section states; (5) all 7 new/changed test files run directly (51/51 passed) and the full @centraid/gateway suite (69 files / 477 passed / 2 skipped, build-gateway.test.ts 9/9); (6) repo-wide gates verified: `typecheck` 22/22 green, `lint:types` all-ok, `oxlint` reports exactly 22 errors with none in change-set files, `format:check` fails on 44 files on the base commit / 42 with this diff applied (2 previously-failing files reformatted incidentally), none in this change set. No implementation defects found.

## Steering

PASS Zero genuine steering events detected. All 69 user-type entries in the transcript (62 tool-result blocks, 6 XML command outputs, 1 session-scoped Stop hook instruction) are machine-generated system messages. The session was started with a single autonomous /goal directive; no human-authored prose interrupts, corrections, or redirections appear in the transcript.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-ce6f46f7-a6a-1783825671-1 | claude-code | ce6f46f7-a6a9-4d68-9c4d-6c2f3baec4a7 | #374 | claude-sonnet-5 | 56228 | 1228693 | 13719920 | 167101 | 1452022 | 11.3988 | 56228 | 1228693 | 13719920 | 167101 | fix(vault,app-engine): STRICT tables + JS-safe-integer bounds (#374)extTableDdl( |
| claude-code-ce6f46f7-a6a-1783825725-1 | claude-code | ce6f46f7-a6a9-4d68-9c4d-6c2f3baec4a7 | #374 | claude-sonnet-5 | 7540 | 7066 | 467671 | 1167 | 15773 | 0.2069 | 63768 | 1235759 | 14187591 | 168268 | perf(vault): add covering index for every uncovered FK column (#374)SQLite auto- |
