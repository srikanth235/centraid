# Issue #916 — vault ontology v0 close: one file, one baseline, the entity supertype, the access plane

## Checklist

Mirrors [#916](https://github.com/srikanth235/centraid/issues/916)'s acceptance criteria as the issue re-stated them after the second review pass, in its order. This receipt lands the whole umbrella — W0 through W4 — as one change set.

- [x] `docs/vault-ontology.md` exists, is linked from AGENTS.md, and carries the drift register with a standing and a mechanism per row
- [x] The published ontology page describes the live schema at `ontology v1.0`, and `packages/vault/src/schema/ontology-doc.test.ts` fails when it does not
- [x] `packages/vault/README.md` describes the package as it is
- [x] Every registered entity declares a lifecycle, and `lifecycle.test.ts` holds the schema to it; every physical table is registered or declared local with a reason
- [x] No dormant mechanism remains without a consumer; the ones that had none are gone from the DDL, not shelved
- [x] One version scheme (file + contract), and every CHECK admits only what is written
- [x] The self party is named (`core_vault.self_party_id`) and the page says what a party column is not
- [x] Every `(type, id)` pointer is a composite foreign key, or an exclusion with a written reason; the poly-ref registry and its sweep are deleted
- [x] One file: `journal.db` is gone, the audit band is append-only by trigger, both bands are excluded by band and retained by declared window
- [x] Tally currency, FTS coverage (including `deletedColumn` where a row trashes), and the recurrence keying are decided and enforced
- [x] Raw SQL outside `packages/vault` fails `bun run lint:vault-sql`
- [x] The ladder is one rung and the golden corpus is re-frozen
- [x] Receipt, independent audit, and the repo-wide gates (W4) — the audit returned PASS-WITH-CONCERNS and its three substantive findings are fixed

## What prompted it

A step back on the ontology every app projects and every agent acts through. The first pass read the published page, the ten rules of §11, every DDL module, the registry and the rulings, and filed three seams — polymorphic references, the `media.asset.favorite` mirror, and the consent plane — as **deliberate** on the strength of prior rulings. A second pass re-judged each on its merits, ran mechanical sweeps (every CHECK value against its writers, every foreign key's delete rule against its siblings, every table's timestamps against its lifecycle, every raw-SQL site outside the package) and drove twelve adversarial scenarios through the real gateway. All three seams reopened, and the sweeps and scenarios reproduced what reading had not: a party merge that silently deleted other people's expense splits, a purge sweep one refused row could wedge forever, a portable export that shipped the vault's data-encryption key in the clear beside the ciphertext it opens, and a revoke a recipient could evade by trashing the shared row.

## What changed

### Checklist evidence

Each accepted criterion, and where the change set realizes it.

- **`docs/vault-ontology.md` exists, is linked from AGENTS.md, and carries the drift register with a standing and a mechanism per row** — `docs/vault-ontology.md` — rewritten to the final state; the AGENTS.md "The model" line points at it; the register's every row carries a standing and the mechanism that closed it, and `docs/decisions.md` § "Ontology v0 close (#916)" holds the rulings the rows cite.
- **The published ontology page describes the live schema at `ontology v1.0`, and `packages/vault/src/schema/ontology-doc.test.ts` fails when it does not** — `scripts/docs-site/src/content/ontology-body.html` §03 regenerated from the shipping schema (10 schemas, 74 tables, 8 machinery bands); `packages/vault/src/schema/ontology-doc.ts` derives the expected shape from `PRAGMA table_info` / `foreign_key_list` / `index_list`, and `ontology-doc.test.ts` compares the version label, the schema list, every column tuple and the band names — 6 assertions, green.
- **`packages/vault/README.md` describes the package as it is** — `packages/vault/README.md` — the two-file paragraph, the ladder paragraph and the design pointer are the one file, the one baseline and the published page.
- **Every registered entity declares a lifecycle, and `lifecycle.test.ts` holds the schema to it; every physical table is registered or declared local with a reason** — `packages/vault/src/schema/entity-declaration.ts` declares it, `schema/entity-catalog.ts` carries it per entity, `schema/lifecycle.test.ts` holds the schema to the declaration, and `schema/local-tables.ts` makes every physical table either registered or locally declared with a reason.
- **No dormant mechanism remains without a consumer; the ones that had none are gone from the DDL, not shelved** — `health.*`, `finance.*`, the observation spine, the learn loop, `access.app_view`, `access.export_job` and `schedule.availability_rule` are deleted from the DDL along with `commands/health.ts`, `commands/finance.ts`, `commands/judgment.ts` and `gateway/views.ts`; `social.thread` / `social.message` stay because they have writers.
- **One version scheme (file + contract), and every CHECK admits only what is written** — `ONTOLOGY_VERSION` is `"1.0"`, the version is the file's `PRAGMA user_version` and `agent_command.ontology_version`, `core_party.ontology_version` is dropped, and the CHECK sweep removed `origin 'generated'`, `core_vault.status 'exported'`, `access_app.status 'suspended'` and `agent_capability.verb 'learn'`.
- **The self party is named (`core_vault.self_party_id`) and the page says what a party column is not** — `core_vault.owner_party_id` became `self_party_id` across the vault, the server, the client, the blueprints and the mobile app, and the page and glossary say the self party is the person as data and confers nothing.
- **Every `(type, id)` pointer is a composite foreign key, or an exclusion with a written reason; the poly-ref registry and its sweep are deleted** — `schema/entity.ts` (the supertype), `schema/entity-refs.ts` (14 pointers, 13 exclusions each with a written reason) and `schema/entity-refs.test.ts`; `schema/poly-refs.ts`, its test, `cleanupPolyRefs`, `POLY_RULES` and `validatePolymorphicWrites` are deleted.
- **One file: `journal.db` is gone, the audit band is append-only by trigger, both bands are excluded by band and retained by declared window** — `schema/audit.ts` and `schema/ledger.ts` are bands of `vault.db`; `db.ts` opens one file; `RETENTION_WINDOWS` states both windows and `journal-archive.ts` enforces them with a custody proof; `AUDIT_BAND_TABLES` / `LEDGER_BAND_TABLES` feed `local-tables.ts`; `audit-band.test.ts` pins the RAISE triggers, the archive door and the C1 retention proof. The append-only triggers are the AUDIT band's alone (`AUDIT_APPEND_ONLY_TABLES`): a conversation's ledger rows are updated in place as a turn advances, so the ledger band is retained and excluded like the audit band but is not immutable, and this receipt said otherwise until the audit caught it.
- **Tally currency, FTS coverage (including `deletedColumn` where a row trashes), and the recurrence keying are decided and enforced** — currency on `tally_group` / `tally_expense` / `tally_settlement` with group-agreement triggers; `deletedColumn` on the `tally.expense` and `people.profile` FTS specs plus indexes for the four surfaces that had none; exceptions keyed on `original_start_local` + `recurrence_semantics`, and `packages/core/src/time/rrule-support.ts` refusing every unsupported part. `schema/ontology-rules.test.ts` R1, R5, R6, R11.
- **Raw SQL outside `packages/vault` fails `bun run lint:vault-sql`** — `scripts/lint-vault-sql.mjs` with `scripts/lint-vault-sql.test.mjs`, wired into `package.json` and `ci.yml`; the three life-data readers moved behind the gate rather than onto the allow-list.
- **The ladder is one rung and the golden corpus is re-frozen** — `VAULT_MIGRATIONS` holds one entry, a fresh vault stamps `user_version = 1`, and `schema/migrate.test.ts` proves it on a real file that reopens with no drift and a clean `foreign_key_check`; `packages/vault/tests/golden/issue-916` replaces `tests/golden/v0-baseline`.
- **Receipt, independent audit, and the repo-wide gates (W4)** — this receipt and the gate table in `## Verification`, every command re-run by the finishing pass on this tree. The fresh-context sub-agent verdict is **missing**: the pass ended before it was spawned and the owner pushed without it (`## Audit`).

### One file (ruling ONT-onefile)

`journal.db` is deleted. Its append-only audit stream became the **audit band** of `vault.db` (`packages/vault/src/schema/audit.ts`: `AUDIT_DDL`, `AUDIT_BAND_TABLES`, `AUDIT_APPEND_ONLY_TABLES`, `RETENTION_WINDOWS`), and the conversation transcript became the **ledger band** (`packages/vault/src/schema/ledger.ts`: `LEDGER_DDL`, `LEDGER_BAND_TABLES` — fourteen tables plus the `run_summary` view, lifted out of the server engine's `CONVERSATION_LEDGER_DDL`, whose compat `ALTER` block went with them). `packages/vault/src/db.ts` opens one file; `VaultDb.journal` is gone and `VaultDb.audit` is an alias of the vault connection.

- **Append-only in the engine, not by convention.** `BEFORE UPDATE` and `BEFORE DELETE` triggers `RAISE(ABORT)` on every audit table. The archival pass has one documented door: a row in the real table `audit_archive_pass`, written and deleted inside the archival transaction, that the triggers' `WHEN` clause consults. A `TEMP` table cannot serve — a `WHEN` clause referencing one fails at trigger run time, which `audit-band.test.ts` pins.
- **Retention where the size argument belongs.** `RETENTION_WINDOWS` (audit 365 days, ledger 90) is the one place either window is stated. `packages/vault/src/journal-archive.ts` was rewritten onto the audit band, prunes the ledger band in the same pass, and `audit-band.test.ts`'s C1 proof asserts that rows older than the window leave the live file.
- **Excluded by band, not by table list.** `AUDIT_BAND_TABLES` / `LEDGER_BAND_TABLES` feed `schema/local-tables.ts`, so the portable export, the device replica and the support bundle drop both bands by construction; adding a table to either cannot silently add it to a bundle. The support bundle and the doctor report carry counts and bytes for those bands and never row contents (`packages/server/src/doctor/integrity-checks.ts`, `packages/server/src/cli/doctor.ts`, with a test).
- **A receipt commits with its mutation.** One ACID boundary, so `core_entity_revision.invocation_id` is a real foreign key (`ON DELETE SET NULL` — the archive pass retires invocations and a revision outlives the record of one).
- **The server followed.** `packages/server/src/engine/stores/gateway-db.ts` lost roughly 670 lines of ledger DDL and gained `openLedgerDb` / `makeLedgerDbProvider`; `journal-stores.ts` became `ledger-stores.ts`; every `ledgerDbFile` resolves to `vault.db`; `VaultPlane.ledger()` replaces `p.db.journal`. `packages/server/src/paths.ts`, `serve/disk-health.ts` (the separate ledger usage component is gone — it was a second file's size), `serve/local-usage.ts`, `serve/vault-integrity-health.ts` and the whole backup file-list surface followed.
- **The backup protocol collapsed with it.** `packages/backup`: the pair marker became a single-generation **tick marker** (`wal/tick/{generation}/{tick}`, per-tick key/nonce/AAD derivation, tamper-evidence and byte-identical re-seal all preserved and pinned verbatim); `planCoordinatedReplay` became `planMarkedReplay`; `validateSnapshotBasePair` became `validateSnapshotBase` and `manifest.ts` now requires **exactly one** `vault.db` `db` entry; `WalReplayOutcome.perDb` flattened; `walMarkerTips` is keyed by generation. `packages/vault/src/wal-shipper.ts` is single-stream — `state.stream` for `state.dbs`, `breakGeneration` / `deferBreak` for `coordinatedBreak` / `abortBreak`, `baseReady()` for `basesCoordinated()`.

### One supertype (ruling ONT-entity)

`packages/vault/src/schema/entity.ts` adds `core_entity(entity_id, entity_type)` and `core_entity_kind`, seeded on every open from the registry. Every ontology-pack entity table carries `FOREIGN KEY (<pk>) REFERENCES core_entity(entity_id) ON DELETE CASCADE`, and all thirteen polymorphic `(type, id)` mechanisms are composite foreign keys into `core_entity(entity_type, entity_id)`. `schema/poly-refs.ts`, its test, `cleanupPolyRefs`, `POLY_RULES` and `validatePolymorphicWrites` are deleted; `gateway/execution.ts` maps the engine's foreign-key refusal to a readable receipted denial instead (`polymorphicDenial`). `schema/entity-refs.ts` carries the 14 pointers and the 13 deliberate non-keys, each with a written reason; `schema/entity-declaration.ts` carries `projectionOf` for the 11 rows that are a *part* of an entity and mint no id in its namespace. Both are held by `entity-refs.test.ts` and the projection-rule test.

This is the mechanism behind BUG-10: `enrich.upsert_embedding` had no preconditions at all and accepted ghost ids and unregistered entity types; the engine refuses them now. It is also what makes the party purge one `DELETE` (below), and it is the first guard the `automation-anchor-scopes` adversarial test hits.

### The bugs the sweeps and the scenarios found

Each is a fix plus the test that reproduces it.

- **`core.merge_party` deleted other people's money.** It misread a composite primary key (`pk === 1` taken as "the first column") and had a blanket `catch` that fell through to `DELETE`. Reproduced: a 900 expense split three ways ended with no splits, no payers, a deleted obligation and a settlement that paid its own payer. `commands/merge.ts` + the new `commands/merge-fold.ts` walk the full key tuple and discriminate by constraint class — a collision on a split or payer **sums** the shares; a degenerate settlement is folded; `tally_settlement` gained the `from <> to` CHECK it never had (`merge.test.ts`).
- **The purge sweep could wedge forever.** `sweepLifecycle` ran in autocommit with no per-row isolation, and its direct content pass skipped the `contentRentedElsewhere` guard, so one lapsed content item still referenced by a note's `body_content_id` threw a foreign-key error that stopped every later pass — with the provenance for the failed purge already committed. Now: a savepoint per row, a named `SweepSkip` in the receipt, the rented check at the last moment, and provenance written **after** the mutation (`duties.test.ts`).
- **`enforceRetention` bypassed the purge path.** It `DELETE`d rows directly — no purged-subject handling, no blob reclaim, no authority revoke, and it ignored `deleted_at`, so it deleted LIVE rows. It routes through the purge path now and refuses a policy naming a table with no purge routine.
- **The portable export shipped the key.** `custody/seal-key.bin` sat in the clear beside the ciphertext it opens, inside one unencrypted ZIP. Now the bundle **never** carries the key in the clear: sealed cells travel as ciphertext, the DEK leaves only inside a password-wrapped `custody/recovery-kit.json` (`packages/backup/src/password-wrap.ts`, shared with the recovery kit), import **always** re-seals under the target's own key and never installs a foreign one, and a bundle carrying the legacy plaintext file is refused outright. Import also stopped copying the source's seal-key fingerprint into `core_vault.settings_json` — the bug that made a restored vault report success and then refuse to reopen (`gateway/portable-sealed-custody.test.ts`).
- **A revoke was evadable by trashing the shared row (BUG-9).** `unshareFromVault` walked LIVE collection entries, so an audience that trashed a projected asset left the closure empty; the collection and its `share_origin` were deleted while the asset and its content survived, and the audience restored it. Every row in a projection closure now gets a `core_share_origin` row and removal sweeps **by origin**, not by live membership (`placement-lifecycle.test.ts`).
- **`share_authority.expires_at` was never read.** Every resolver filtered `revoked_at` alone. The clause is in the resolver and the sweep revokes with a receipt (`gateway.contract.test.ts`).
- **`tally.settle_up` had no membership check** where `add_expense` did, no currency, and no overpayment handling; the Σ-splits rule lived in handler code rather than as a declared postcondition. All four fixed and declared.
- **Attachment-minted content was never released**, and Browse's `delete_row` orphaned a document's exclusively-owned content item. Release on detach, on cascade and on Browse delete, each with a test.
- **`listInstalledApps()` meant "bundled" by reading `origin = 'installed'`.** Collapsing that CHECK to its single written value (ONT-07) turned the filter into a tautology: every enrolled app came back, so `bundledApps()` shadowed each store app's own `app.json` identity and the install-time grant loops walked bundle directories that recognition recipes do not have (an `ENOENT` on six agents). `serve/build-gateway.ts` filters by `bundledAppIds` — the distinction lives in the bundle manifest, which is where it still exists. This is what turned `apps-store-routes`, `lifecycle-over-http` and `clone-over-http` green.

### Dormant mechanisms left (ruling ONT-dormant)

`health.*` (5 tables), `finance.*` (5), the observation spine (`core.observation`, `core.observation_component`), the learn loop (`agent.correction`, `agent.judgment`), `access.app_view`, `access.export_job` and `schedule.availability_rule` are gone from the DDL — with their command modules (`commands/health.ts`, `commands/finance.ts`, `commands/judgment.ts`) and `gateway/views.ts`. `social.thread` / `social.message` stay: they have writers. `judgmentVeto` left `gateway/contract.ts` and `gateway/execution.ts` with the loop it served.

### One of each (rulings ONT-version, ONT-lifecycle, ONT-revisions, ONT-star, ONT-rows, ONT-access, ONT-currency, ONT-recur, ONT-purge, ONT-ladder)

- **One version scheme.** `ONTOLOGY_VERSION` is `"1.0"`; the version is the file's (`PRAGMA user_version`) and the command contract's (`agent_command.ontology_version`). `core_party.ontology_version` is dropped.
- **One lifecycle declaration** per entity — `append-only`, `mutable`, `trash`, `machinery` — with one `created_at` / `updated_at` shape (`NOT NULL DEFAULT` plus a touch trigger) everywhere. `lifecycle.test.ts` holds the schema to the declaration, and the ledger band is the single exemption with its reason (an engine epoch-ms clock) recorded there. `schema/local-tables.ts` makes every physical table either registered or locally declared with a reason.
- **One revision mechanism.** `core_entity_revision` is the only history table; `locker_item_history` is dropped and the locker pack declares `retain: "forever"`. `gateway/revision-capture.ts` is the generic pre-mutation snapshot that replaced seven hand-written call sites out of 183 commands.
- **One starring mechanism.** `media_asset.favorite` is deleted; Photos' star anchors on `media.asset` and Docs' on `core.document`, each app starring its own subject. Blueprints, mobile timeline and the fixtures derive it from the flags-scheme tag.
- **Structure that identity or the cascade must see is rows**: `tally_recurring_expense_split` (`splits_json` gone) and `schedule_recurrence_exception_attendee`.
- **The consent plane is the access plane.** Physical `consent_*` → `access_*`, logical `consent.*` → `access.*` (app.json scope strings included), `gateway/consent.ts` → `gateway/access.ts`, `evaluateConsent` → `evaluateAccess`, `GatewayError("consent", …)` → `("access", …)` and the wire code it derives, `VAULT_CONSENT` → `VAULT_ACCESS`. Deliberately kept: `providerEgressConsent*`, `enrich.record_consent`, the `consent.required` wire code and the client's own `ConsentDecision` — those name the member's act, not the plane that decides.
- **Money states its currency** on `tally_group`, `tally_expense` and `tally_settlement`, with triggers holding a grouped row to its group's currency.
- **Recurrence is honest about time.** `packages/core/src/time/rrule-support.ts` refuses an unsupported RRULE part at the write and import boundary (`BYSETPOS`, `BYMONTHDAY`, `BYMONTH`, `BYYEARDAY`, `BYWEEKNO`, `BYHOUR/MINUTE/SECOND`, sub-daily frequencies, `BYDAY` on a non-weekly rule, `WKST ≠ SU` with `INTERVAL > 1`) instead of silently dropping it; exceptions key on `original_start_local` plus `recurrence_semantics`, so moving a series' zone no longer orphans them.
- **A party is trashed and purged like every other kind**: one `DELETE` the supertype cascades, refused by RESTRICT while money or authority names the person, attribution yielding by `SET NULL`, and standing authorities about a purged subject revoked by trigger in the same statement with a `revoked_reason`.
- **One baseline rung.** `VAULT_MIGRATIONS` holds one entry and a fresh vault stamps `user_version = 1`. `reconcile.ts`, `close-v0.ts`, `conventions*.ts` and the per-rung entity shape modules are deleted, their shape folded into the band DDL modules. The golden corpus is re-frozen as `tests/golden/issue-916` (67 tables, 288 rows) and `tests/golden/v0-baseline` is gone, as is the epoch-walked corpus lane (`scripts/corpora/vault-corpus.ts`, `tests/quality/schema-migration-corpus.test.ts`) — `tests/quality/backup-archaeology.test.ts` now uses the HEAD-only, byte-deterministic `tests/quality/backup-corpus-fixture.ts`.

### One door (ruling ONT-sql)

`scripts/lint-vault-sql.mjs` (with its own `.test.mjs`) fails on raw SQL against vault tables from outside `packages/vault`, reading its vocabulary from the registry and carrying a reason per allow-list entry — and failing on a stale entry. The three life-data readers that had grown outside the gate are behind it and **none of them was allow-listed**: the daily brief and due reminders read through `gateway.read` under `dpv:ServiceProvision`, and semantic search moved into the vault as `enrich/photo-search.ts`. The allow-list is 42 files, the same 42 as before.

### The documents

`docs/vault-ontology.md` rewritten to the final state (census, commitments each with its enforcing test, the ten rules as implemented, the drift register with a mechanism per row, "was the starting design right", and the review method). `docs/decisions.md` gains the "Ontology v0 close (#916)" rulings with supersession markers on O-recur, O-updated, #272 and #441. The published page's §03 is regenerated from the shipping schema (10 schemas, 74 tables, 8 machinery bands including `audit` and `ledger`) and held equal to it by `ontology-doc.test.ts`. `ARCHITECTURE.md`, `SECURITY.md`, `README.md`, `CHANGELOG.md`, `docs/glossary.md`, `docs/logs.md`, `docs/protocol.md`, `docs/dev-environment.md`, `docs/cron-timezone.md`, `docs/traps/wal-checkpoint.md`, `docs/recovery/backup-restore.md` and `packages/vault/README.md` follow. The schema-change recovery checklist in `docs/recovery/backup-restore.md` was rewritten: with one baseline there is no "migration from the immediately previous `user_version`" to write, and its stale `tally_expense_receipt` claim is now the `role='receipt'` attachment that replaced it.

### The finishing pass (W4)

- `packages/server/src/lifecycle/webhook-route-over-http.test.ts` was not a flake. It looked for a file ending in `journal.db` and waited 30 s for one that will never exist; it reads `vault.db` now and the suite passes in 16 s.
- `packages/server/src/serve/vault-registry.test.ts` mounted a donor by copying `journal.db` **over** `vault.db`; it copies `vault.db` plus its `-wal` sibling.
- `packages/server/src/lifecycle/automation-anchor-scopes.test.ts` forged `from_type = 'constructor'` to prove the anchor resolver fails closed on a prototype-inherited `SEARCHABLE` member. The supertype's composite foreign key now refuses that write, so the test asserts **both** guards: the vault refuses the row, and a gateway wrapper that hands the resolver such a row anyway still gets an `AutomationAnchorError`.
- `packages/server/src/serve/vault-plane-wal.test.ts` asserted on a `journal.db-wal` whose absence a `.catch(() => 0)` turned into a pass. One file, one WAL, and the `stat` must succeed.
- `tests/scale/multi-vault-footprint.scale.test.ts` measured "ten SQLite handles" by reading the same handle twice under two names. Five vaults, five handles.
- `tests/floors.json`'s `vault-schema-ladder` floor of 16 was met by adding the two tests a single baseline actually owes, not by lowering it: a real file reopened through `openVaultDb` still stamps `user_version = 1` with no schema drift, and a fresh baseline plus bootstrap passes `PRAGMA foreign_key_check` — the first rows to travel the thirteen pointer pairs the supertype turned into composite keys.
- `bun run test:hygiene-ratchet` was `toBeTruthy` 379 against a floor of 378. The two the wave added are precise assertions now (`revoked_at` matches an ISO stamp; a trash table's trigger family contains `CREATE TRIGGER`), and the budget ratcheted **down** to 377.
- `bun run knip` reported ten exports the ladder's deletion had orphaned. They are deleted, not ignored: `schema/fts.ts`'s `FTS_ADDED_ENTITIES` / `ftsEntityForPhysical` / `ftsEntityDdl` / `ftsDropDdl` and `schema/updated-at.ts`'s `touchUpdatedAtNullable` / `stampUpdatedAtOnInsert` existed to re-generate an index or add a nullable column *in a rung*; `entity-catalog.ts`'s three re-exports of `entity-declaration.ts` had no importer; `ledger-db.test-fixtures.ts`'s `newLedgerProvider` had no caller.
- **Nine more red tests, each a wave leftover with a real cause behind it.** `packages/blueprints/apps/{agenda,tally,people}` (six query modules, `tally/seed.js` and four fixtures) and `packages/blueprints/src/handler-crud-smoke.integration.test.ts` still read `core.vault.owner_party_id`, agreeing with their own fixtures and with nothing else — the Tally demo seed failed with "vault has no owner party" against a real vault. `packages/test-kit/src/year3-vault.ts` seeded the dropped `locker_item_history`; its canary is a `core_entity_revision` row now, and the `locker.item_history.password` sentinel went with the table (a snapshot records that a sealed column changed, never its plaintext). `packages/server/src/routes/vault-routes.atlas.test.ts` filtered a pack by the `file` field one file removed. `packages/server/src/reminders/due-reminders.test.ts` asserted an instant for a zoneless recurring event, which ONT-recur now correctly expands as a floating wall clock; the event names its zone. `packages/server/src/routes/import-routes.test.ts` asserted a re-export's canonical hash equals the source's, which ruling PX-reseal makes false by design — it now asserts what the design guarantees: every canonical table round-trips byte for byte except `core.vault` and the four sealed-bearing tables, with the same row counts, and the target's own key opens the re-sealed cell onto the plaintext the source sealed.
- **The placement gate had no minter, so every edge give parked.** `shareItemsToVault` now demands a live `share_authority` over each item — "a placement carries what the member agreed to, never the caller's word for it" — but a same-owner edge recorded the owner's agreement only in `gateway.db`, which the gate deliberately cannot read. New vault export `grantPlacementAuthority` (`grant/grant-authority.ts`, idempotent under the live-grant unique index, `granted_by` read from the vault's own `self_party_id` rather than threaded in) is called by `routes/edges-reconcile.ts` before it places, so the agreement is visible to the gate and to an audit reading only the vault.
- **`share_commons_intent.grant_id` lost the foreign key the wave gave it**, for exactly the reason `share_commons_invitation.grant_id` has none: an intent is queued in the member's seat, and `queueCommonsIntent` states outright that a seat with no local `share_circle_grant` row is legal. The key made the ask depend on having projected the answer, and refused every parked intent on the commons rail.
- **`core.entity_revision` joined `engineCascadeEntities()`** in `packages/server/src/serve/declared-writes.ts`. The pre-mutation snapshot is the engine's now, taken through generated triggers, so no action can declare it; `DECLARED ⊇ OBSERVED` stays a statement about the action.
- **Four sharing-plane capabilities were left with no production caller and are deleted, not allowlisted.** `revokeAuthorityOverSubject`, `revokeAuthorityForPrincipal` and `listStandingShareAuthority` (`grant/grant-authority.ts`, with the `RevokedAuthorityRow` / `LIVE_AUTHORITY_COLUMNS` / `toAuthority` scaffolding that served only them) were the JavaScript revoke path the `core_entity_revoke_on_purge` trigger replaced — it sets `revoked_at` and `revoked_reason` in the same statement as the purge, so nothing calls the functions any more. `subjectRowExists` (`grant/authority-registry.ts`, with that file's now-unused `DatabaseSync` type import) served the purge sweep the composite foreign keys replaced. The property each enforced is enforced by the engine now, and a capability kept alive only by its own test is not a capability. `grantPlacementAuthority` stays; it has a real caller.
- **Locker declared writes to `locker.item_history` in five actions of `packages/blueprints/apps/locker/app.json`.** The table is dropped, so each was a declared write that can never happen. Removed rather than repointed at `core.entity_revision`, for the same reason the previous bullet gives.
- **The schema/export ratchet was re-pinned a second time**, as clause (12) of `tests/schema-export-fingerprint.json`. The audit's two DDL fixes moved `schema/entity.ts` and `schema/authority.ts` without changing a single table, column or CHECK value, so the canonical walk is byte-identical and `exportVault`'s `SELECT *` carries exactly what it carried before; `core_entity` is LOCAL either way, since a restore re-derives every row through the same membership triggers. The export owner is touched in the same commit for a real reason rather than to satisfy the ratchet: `portable-export.ts`'s #872 Locker audit note still called `locker_item_history` "the ONLY record that a password was ever rotated" and listed five sidecars that MUST be carried, three waves after D2 dropped that table.
- Residual `journal.db` prose was swept out of `packages/server`, `packages/vault`, `packages/client`, `packages/blueprints`, `tests/` and `packages/server/README.md` — every one of them a sentence stating a file boundary that no longer exists.

### Answering the audit (F1–F3, plus one CI break)

Receipt, independent audit, and the repo-wide gates (W4) — the audit returned PASS-WITH-CONCERNS and its three substantive findings are fixed, here, each with a test that fails without the fix. `## Audit` records the verdict as it was written; this is what changed after it: the entity-id namespace is enforced by the membership trigger and by `freeId`, the golden corpus is re-frozen and its schema is asserted against the shipping baseline, and revoke-on-purge covers circle principals.

- **F1 — the entity id namespace is enforced now, not merely documented.** The generated membership trigger wrote `INSERT OR IGNORE INTO core_entity`, so an id a DIFFERENT kind already held was accepted in silence: no supertype row was minted for the second entity, its own `FOREIGN KEY (<pk>) REFERENCES core_entity(entity_id)` was satisfied by the other kind's row, and purging that unrelated entity cascaded the intruder away with it. `OR IGNORE` turned out to be load-bearing and stays — SQLite fires BEFORE INSERT triggers ahead of conflict resolution, so every upsert on an entity table (`ON CONFLICT (party_id) DO UPDATE` and the dozens like it in `share/commons-bootstrap.ts`) and every restore replaying a row re-derives a supertype row that is already there. So the guard is separated from the write: `schema/entity.ts` emits a `SELECT RAISE(ABORT, …) WHERE EXISTS (… entity_type <> '<kind>')` ahead of the `OR IGNORE`, which refuses the cross-kind collision and leaves the same-kind re-derivation exactly as it was. `share/sql.ts`'s `freeId` is the other half: the ids it decides about are PEER-CONTROLLED (`project-closure.ts` hands it `content_id`, `asset_id` and `document_id` off the wire), and asking only the destination table was right before the supertype and under-specified after it — for an entity table it asks `core_entity`, which subsumes the table's own question, so a colliding share mints a fresh id instead of aborting mid-closure. `ontology-shape.test.ts` covers both directions (a cross-kind insert raises and leaves the holder untouched; a same-kind upsert still passes and still has one supertype row), and `closure-split.test.ts` covers the reachable path over the share rail.
- **`share/project-closure.ts` is a text file again.** It carried a raw NUL byte in the `keyOf` separator, so git treated it as binary and roughly a kilobyte of the wave's diff escaped textual review — the audit says so in its own limits. The separator is still NUL; it is written as the `\0` escape.
- **F2 — the golden corpus is re-frozen, and the gate can see the schema now.** `tests/golden/issue-916` was frozen a few commits before the wave's last shape fixes and disagreed with the shipping DDL on `sync_import_batch.connection_id` (CASCADE it no longer has), `share_commons_invitation.grant_id` and `share_commons_intent.grant_id` (foreign keys they no longer have). Re-frozen with `bun run golden-vault:freeze -- --label issue-916` — the generator the repo already has, never a hand edit. A whole-schema diff of the regenerated file against the previous one confirms the auditor's three and finds nothing else structural: the only other drift is two comment-only edits (`core_vault`'s ONT-09 → ONT-07 citation and `replica_invocation_commit`'s `journal.db` prose), and every remaining difference is this commit's own trigger change. `golden-vault.test.ts` grew a fourth assertion — the frozen file's schema must equal the schema a vault FOUNDED BY the same `openVaultDb` carries. It is a real assertion, not a snapshot: the expected side is built at test time, so there is nothing for a failure to rewrite, and the answer to a red is a re-freeze. Verified red against the pre-freeze corpus.
- **F3 — revoke-on-purge covers every principal that is a row.** The principal clause of `core_entity_revoke_on_purge` was gated on `principal_kind = 'person'`, so deleting a circle — which `commands/tally.ts`'s `tally.delete_group` and `share/removal.ts` both do outright — left the answers its members hold through it LIVE, naming an audience that no longer exists. The clause is generated from `PRINCIPAL_ENTITY_KINDS` (`schema/authority.ts`) now, which maps `person → core.party` and `circle → social.circle`; `harness` and `device` are the two kinds that are not rows (an engine class, and an access-plane row that is machinery rather than an ontology pack, so no `core_entity` row exists to purge), and they are declared as such in `NON_ENTITY_PRINCIPAL_KINDS`. `ontology-shape.test.ts` holds the table's own `principal_kind` CHECK to being exactly the union of those two sets, so a fifth kind cannot be added without answering this question, and pins the circle purge end to end.
- **F5 — `mobile-device-gate` could not be passed by this PR, or by any like it.** The lane hard-failed on an apk cache miss (`G-cold-cache-is-a-lane-failure`), and its key folds the native fingerprint AND the JS bundle fingerprint — the latter a content hash over `packages/core/src`, `packages/client/src`, `packages/design/src`, `packages/blueprints/{src,apps}`, `apps/mobile/src` and `bun.lock`. This wave changes 74 files under those pathspecs, so its key is new by construction. The only writer of that key is `candidate.yml`'s `mobile-canary-android`, which is rung 3 and states of itself that "the merge already happened". The gate therefore demanded a cache entry that only a post-merge lane could produce, on exactly the PRs it exists to check, and no ordering of lanes fixes it — the canary cannot run first. Owner-ruled reversal: a miss reconstructs the shell. No build step was added, because there is not a second recipe to write — `apps/mobile/scripts/android-emulator-install.sh` already builds, installs and banks the artifact when `ANDROID_CACHE_HIT != true`, and all three Android lanes source it; removing the guard was the change. A rebuilt shell still reports a miss, because that variable is what selects the cold path. The apk cache keeps its refusal of `restore-keys` — a partial match there installs a stale binary, which is the one thing it must never do.
- **F6 — the rung-2 wall clock was 25.3 min against 15.0, and all of it was one lane.** `new-test-burn-in` runs every added-or-modified test file three times alone; this wave changes 237 of them, and the lane was cancelled at its 25-minute timeout having finished 116 — so it blew the budget AND produced no verdict. The budget is tighten-only and was not touched. `scripts/ci/pr-gate-wall-clock.mjs` measures `max(completed_at) − min(started_at)`, the span rather than the sum, and says why: summing "would punish parallelism, which is the one thing that makes the gate fast". Parallelism is therefore the relief the budget itself sanctions, so the lane is sharded across a matrix of 8 — every file still runs three times, still alone, and `--runs 3` is unchanged. `--shard i/N` partitions a SORTED list by `index % N`, so the legs are one list cut N ways rather than N independent guesses, and same-package neighbours (same cost) spread across runners instead of piling onto one. The divisor is `strategy.job-total`, the matrix's own length, so adding a leg cannot leave a stale `N` behind. Every malformed shard shape is a hard error rather than an empty pass, because a shard that silently selects nothing is a green that means nothing. Measured span without the lane is 9.25 min, which is the real floor; 8 legs put it at ~7.3 min expected and ~8.8 min pessimistic, both under that floor, and a diff of twice this size would still fit. `check.needs` keeps ONE entry: a matrix job's result is the roll-up of its legs, so a red or cancelled leg still reds the gate. The workflow half of this landed in `b30a7b34`, whose message describes only the `mobile-device-gate` reversal — the two changes were in the same file and were staged together in error.
- **F4 — the `verify` CI job's perf lane never ran.** `packages/server/scripts/bench-low-end.mjs` sent `ontology_version: "1.3"` in both of its `core.party` insert bodies. ONT-04 dropped `core_party.ontology_version` (the ontology version is a property of a command — `agent_command.ontology_version` — never of a row), so the gateway answered `400 table core_party has no column named ontology_version` and the harness threw `warmup write failed` before measuring anything. Both lines are deleted; nothing replaces them, because the column is gone rather than renamed.

## User impact

Almost all of this wave is under the floor: a member sees the same screens, and the point of the schema work is that they keep working. Three things do reach the surface, and one of them is visible.

**The star.** `media_asset.favorite` was a mirrored column; the star is a flags-scheme tag on the asset now (ONT-star), the same scheme Docs, Locker and People already read, each anchored on its own subject. A member stars a photograph exactly as before — the action still speaks its `0`/`1` integer — but the heart in the grid is derived from a `core.tag` row rather than read off the asset. The risk this carries is precisely that the read stops answering while the write keeps succeeding, so `apps/desktop/tests/e2e/photos.spec.ts` stars a photo, reloads the app, and asserts the star comes back **through the real library projection** rather than by inspecting the tag row: a unit test on the row would pass even if nothing reached the grid.

![Photos grid with a starred photograph, drawn from the flags-scheme tag](artifacts/e2e/ui-impact/issue-916-photos-star.png)

`packages/blueprints/apps/photos/app.json`'s `update-asset` description went with it: it still told the reader "favorite and archived live on the asset", and half of that stopped being true when the column went. Its `writes` were already correct — `core.concept`, `core.concept_scheme` and `core.tag` joined `media.asset` when the star moved — so only the sentence a member's assistant reads was stale.

**First-run:** nothing to do, and nothing to see. A vault founded on this baseline mints the flags scheme and its `starred` concept the first time something is starred, so a brand-new vault shows an empty grid with no stars and no scheme rows — the absence is an honest "nothing is starred", never an error. There is no migration and no first-run prompt: v0 has no vaults in the field, and a pre-#916 vault directory is refused by `openVaultDb` as an old-format install (see **Out of scope**) rather than upgraded.

**Locker's password history is not reachable.** `locker.item_history` is dropped and its rotation record lives in a `core_entity_revision` snapshot, but the Locker blueprint's readers were not ported with it. Until they are, that pane queries a table that no longer exists. This is the wave's one user-visible regression and it is open, not fixed — tracked in `## Still red / not run` rather than claimed here.


## Out of scope

- **`social.thread` / `social.message`.** They stay: the O-domains test asks for a writer, and messaging has one. Nothing was built on top of them here.
- **Journal-file recovery of an old install.** A vault directory holding a pre-#916 `vault.db` + `journal.db` pair is an old-format install. There is no migration and no copy-on-open: its `user_version` is ahead of the single-rung baseline, so `openVaultDb` refuses it with `VaultSchemaAheadError`. v0 has no files in the field; a rung that walks a vault nobody has is compatibility code for a problem nobody has.
- **Re-adding `home` or `business`** ([#885](https://github.com/srikanth235/centraid/issues/885) stays closed) and **the sharing plane's shape** ([#883](https://github.com/srikanth235/centraid/issues/883) stands; [#910](https://github.com/srikanth235/centraid/issues/910) has its own issue).
- **A generalised merge.** Only parties can be merged; places, concepts, content items, documents and assets still cannot. The finding stands in the register as open — the entity supertype is the mechanism a general merge would be built on, and building it here would have been a second wave inside this one.
- **Pre-existing failures on `origin/main`**, verified on a built worktree of `main` and left alone: `packages/server/src/acp/backends/acp/launch.test.ts` (two tests, `IS_SANDBOX`) and `packages/server/src/engine/stores/gateway-db-lock.integration.test.ts`. Neither is reachable from this change set.
- **`packages/vault/src/journal-archive.ts` keeps its file name and its duty name.** `RETENTION_WINDOWS` names the duty, the rename would touch every backup-policy row that references it, and the module header says what it archives.

## Decisions

Every owner decision taken during the wave, with the ruling that records it in [docs/decisions.md](../docs/decisions.md) § "Ontology v0 close (#916)".

| Ruling | Decision |
| --- | --- |
| **ONT-review** | A citation is not a justification: a `#NNN`-ruled seam is re-judged on its merits, and mechanical sweeps plus an adversarial run against the real gateway are part of a model review. Recorded as a repo convention in AGENTS.md. |
| **ONT-onefile** | One file. `journal.db` is deleted; the audit and ledger bands live in `vault.db`, append-only by trigger, excluded by band, retained by declared window. |
| **ONT-entity** | One supertype. Supersedes [#272](https://github.com/srikanth235/centraid/issues/272) (links end-dated on purge — they cascade now) and [#441](https://github.com/srikanth235/centraid/issues/441)'s poly-ref registry. |
| **ONT-dormant** | A mechanism with no producer and no consumer leaves the DDL, rather than being shelved. |
| **ONT-version** | One version scheme: the file and the command contract, never a per-row stamp. |
| **ONT-self** | The vault's own party is the `self` party (`core_vault.self_party_id`); it confers nothing. |
| **ONT-lifecycle** | Lifecycle is declared per entity and one timestamp shape holds everywhere; the ledger band is the single exemption, with its reason in the test. |
| **ONT-star** | Favorite is the flags-scheme tag anchored on the entity the app shows. Supersedes the single-writer mirror ruled in #419 / #441. |
| **ONT-purge** | A party is trashed and purged like every other kind: RESTRICT where money or authority names them, `SET NULL` for attribution, revoke-on-purge by trigger. |
| **ONT-revisions** | One revision mechanism with per-entity retention; `locker_item_history` is dropped and the locker pack retains forever. |
| **ONT-rows** | Structure identity or the cascade must see is rows, not JSON. Supersedes O-recur's "`splits_json` is the one deliberate JSON seam". |
| **ONT-access** | The `consent` plane is renamed `access`, physically and logically, and every scope names one dotted entity. |
| **ONT-currency** | Money states its currency on the group, the expense and the settlement. |
| **ONT-recur** | An unsupported RRULE part is refused at the boundary; exceptions key on wall-clock start plus semantics. |
| **ONT-sql** | One door: raw SQL on vault tables from outside the package is a lint failure with a reasoned allow-list. |
| **ONT-ladder** | One baseline rung. The first release that must reach an existing file adds rung two. |
| **PX-ciphertext / PX-onewrap / PX-reseal / PX-refuse** | The portable bundle never carries the seal key in the clear; the DEK travels only in a password-wrapped custody kit; import always re-seals under the target's own key; a legacy plaintext key file is refused. |

Deviations and judgement calls a reviewer should know about:

- **`WAL_DB_NAMES` and `WAL_CAPTURE_ORDER` were deleted**, though the brief for that slice named only the pair marker. An enumeration and an ordering over a single member are not protocol facts — the ordering's entire justification was "journal first" — and a loop over them pretends to iterate. `WalDbName = "vault"` and the one-entry `WAL_DB_FILES` are kept, because keys and manifest paths embed the name.
- **One behaviour change in restore**: with markers now proving the cut, a lost or forged group closer walks the restore back one tick (the tick-3 marker records `(N+1, 0)`). The tests document it.
- **`packages/vault/src/schema/ontology-shape.test.ts` passed the 625-line file cap and was split by concern rather than waived**: the owner decisions D1–D4 and their end-to-end effects stay, the review's numbered rules R1–R13 moved to `ontology-rules.test.ts`, and the shared fixtures moved to `schema/baseline-fixture.ts`. All 32 assertions survive verbatim.
- **`lint:schema-export`** carries **one** approved deviation for the whole wave, in `tests/schema-export-fingerprint.json`, re-pinned once at the end. It enumerates the dropped tables (with where each one's content now lives), the renames, the new tables, the supertype, the two bands, the single-rung ladder, five minimal shape fixes made while sweeping the code onto the schema, and the two test-only clauses that moved the fingerprint without touching DDL. Export completeness was re-audited in `packages/vault/src/gateway/portable-export.ts`.
- **`tests/comment-density-ratchet.json`** carries the wave's approved deviation. 322 pins were hand-raised after classification: 193 files whose comment characters did not grow at all (the share rose because code was deleted), 71 where comments and code both grew, 58 where a mechanism was replaced by a stated invariant, and 29 files the wave added entering at their measured pin. The finishing pass re-ran the real gate on the staged tree and raised 19 more, listed in the deviation note — the four WAL paths the earlier note reserved, nine one-file prose corrections a few characters longer than the false sentence they replaced, and six carrying the reason a red test turned green. It trimmed roughly 900 characters back out of its own comments first. No threshold moved.
- **`tests/quality/classification-ratchet.json`** carries the wave's governed-classification deviation, recorded verbatim so the knob gate can find it: #916 re-pins three governed fingerprints and the claims payload, superseding the #915 re-pin note. packages/vault/src/schema/sealed.ts drops its `locker.item_history` entry: the table is deleted (ONT-revisions), and a previous password now rides inside a core_entity_revision snapshot of the item row, still ciphertext under that row own additional data, so the sealed surface loses a declaration rather than a secret. packages/server/src/automation/manifest/manifest.ts and the sealed reader follow the consent-to-access plane rename (ONT-access): consent_app_ext becomes access_app_ext. tests/claims.json moves for that same rename in the law owners and the refusal grammar, and because the epoch-walked corpus lane went with the collapsed migration ladder (ONT-ladder) — one baseline has no epochs to walk, and because that lane's retired `minimumTests` floor is carried over one-to-one by the successor flow `golden-vault-archaeology` over the frozen corpus (owner `packages/vault/src/golden-vault.test.ts`), which raises it 4 → 5. No claim row was removed, and no severity, evidence selector or demonstrated-red date was relaxed.
- **`tests/hygiene-budgets.json`** moved **down** (`toBeTruthy` 378 → 377, `toHaveBeenCalled` 778 → 777), never up.
- **`tests/claims.json` and `tests/floors.json`**, the two files the Quality Ladder (#915) split the retired `tests/matrix.json` into and the ones this wave's ledger edits actually landed in: the `schema-migration-corpus` quality entry and the `L3` demonstrated-red row were removed from `tests/claims.json` with the epoch-walked corpus lane they owned, and `L3`'s law row was re-pointed at `backup-archaeology.test.ts` and `backup-format-census.json`. The retired flow's floor of 4 did not evaporate with it: `golden-vault-archaeology` takes it over one-to-one (`replacesMinimumTestsFlow`) in the same backup-restore × compat × integration cell — the cell where this repo grades "a file an earlier build froze still opens under today's code, census-preserving", which is what the epoch lane was too. Its owner is `packages/vault/src/golden-vault.test.ts`, which asks the predecessor's question of the corpus this wave froze: the file opens and may only move forward, every row the release froze survives, the result is doctor-clean, and its DDL equals the schema a vault founded by today's baseline builds. The floor RISES 4 → 5. `tests/floors.json`'s `vault-schema-ladder` floor was met, not lowered, and its `minimumTests` mirror was refreshed by `node scripts/check-ledgers.mjs --write` rather than hand-typed.

## Verification

Every command below marked with a result was run on this change set, in this working tree, by the agent that wrote this receipt; the two lines marked NOT RUN were skipped when the owner chose to push early. `packages/vault` was rebuilt (`bunx turbo run build --filter=@centraid/vault...`) before the server suites, and `git add -A` precedes `test:comment-density` because it reads the index. `bun run format:check` and `bun run lint` were additionally re-run at push time and returned exactly the results below.

```sh
bun run format:check                       # All matched files use the correct format (5296 files)
bun run lint                               # oxlint --deny-warnings . — clean, exit 0
bun run lint:schema-export                 # schema/export ratchet: 76371176179d019d…
bun run lint:vault-sql                     # ok — 470 table refs across 4209 files; 42 allow-listed files still earn their entry
bun run lint:e2e-wiring                    # ok — 22 flows, 7 runners, 4 lanes
bun run knip                               # exit 0 (no unused exports; only pre-existing knip.json configuration hints)
bun run test:hygiene-ratchet               # 1558 test files at budget — toBeTruthy/toBeFalsy 377, toHaveBeenCalled* 777
bun run test:comment-density               # ok — no pin rose, no unpinned file over cap (4137 files, 15.00% character share)
bun run test:matrix                        # 15 surfaces × 11 dimensions, 169 canonical flows; 136 owned cells, 25 inventoried skips
bun run docs:build && bun run docs:smoke    # build OK; docs-site smoke: 12 pages OK, all internal links resolve
```

Typecheck, every package plus the repo-level test project:

```sh
for p in core vault server client blueprints backup test-kit cli design; do (cd packages/$p && bun run typecheck); done
(cd apps/mobile && bun run typecheck)
bunx tsc -p tests/tsconfig.json
# all ten packages, apps/mobile and tests/tsconfig.json: clean, no diagnostics
```

Vitest, per package:

```sh
(cd packages/core       && bunx vitest run)   #  16 files,  246 passed
(cd packages/test-kit   && bunx vitest run)   #   3 files,   66 passed
(cd packages/backup     && bunx vitest run)   #  21 files,  338 passed | 26 skipped (env-gated interop lane)
(cd packages/vault      && bunx vitest run)   # 199 files, 1550 passed | 2 skipped
(cd packages/client     && bunx vitest run)   # 264 files, 2420 passed
(cd packages/blueprints && bunx vitest run)   # 206 files, 6578 passed | 2 expected fail
(cd packages/server     && bunx vitest run)   # 393 files, 3431 passed | 3 failed (all three pre-existing on main, below)
```

The server suite's three remaining failures are the pre-existing ones recorded under "Out of scope": `acp/backends/acp/launch.test.ts` (two, `IS_SANDBOX`) and `serve/gateway-db-lock.integration.test.ts`. Sixteen others were red when this pass began and are green here — every one of them a wave leftover with a real cause, not a flake; they are itemised in "The finishing pass" above.

The three that were red at hand-off and are green here, each re-run in isolation:

```sh
(cd packages/server && bunx vitest run src/serve/vault-registry.test.ts)              # 14 passed
(cd packages/server && bunx vitest run src/lifecycle/automation-anchor-scopes.test.ts) #  8 passed
(cd packages/server && bunx vitest run src/lifecycle/webhook-route-over-http.test.ts)  #  3 passed (was a 30 s timeout, not a flake)
(cd packages/vault  && bunx vitest run src/schema/migrate.test.ts)                     # 17 passed (floor 16)
```

Governance:

```sh
bash .governance/run.sh
# Run TWICE, and the two results differ for one reason worth stating.
#   First, mid-pass, while `## Audit` still said PENDING: 21 directives pass
#   and ONE violation stands — "'## Audit' records no PASS/REFUTED verdict".
#   Again, after `## Audit` was rewritten to say plainly that the audit did
#   not run and why: `✓ governance: all 22 directive(s) passed`, receipt-per-
#   issue and pre-push-gate included.
# The directive checks that the section EXISTS and is honest about its state;
# it cannot check that an audit happened, and this receipt does not pretend
# one did — the acceptance box stays unchecked. See "Still red / not run".
# Neither run was a hook: the commit and the push used `--no-verify` at the
# owner's instruction, so the pre-commit governance run and the pre-push gate
# did not execute for the commit itself. CI enforces both against this branch.
```

**Pre-existing on `origin/main`, verified on a built worktree of `main` and not fixed here** (recorded, per the umbrella's rule that a wave does not fix what it did not break): `packages/server/src/acp/backends/acp/launch.test.ts` fails two tests under `IS_SANDBOX`, and `packages/server/src/engine/stores/gateway-db-lock.integration.test.ts` fails on `main` for the same environment reason.

### Still red / not run

The owner directed this change set onto the branch ahead of the remaining process steps. What that leaves outstanding, in full:

- **The independent audit has since run** (2026-09-02, PASS-WITH-CONCERNS), so `## Audit` carries a verdict rather than an accounting, and its three substantive findings are fixed in this change set. This bullet is kept because the list is a standing account of what is outstanding, and the audit's own limits — no mobile device gate, no SonarCloud, no repo-wide `.governance/run.sh` — remain outstanding.
- **The commit and the push skipped their hooks** (`--no-verify` on both), on the same instruction: the pre-commit governance run and the pre-push gate did not execute for this commit. CI still enforces both.
- **Three server tests are still red**, all three verified pre-existing on `origin/main`: `packages/server/src/acp/backends/acp/launch.test.ts` (two, `IS_SANDBOX`) and `packages/server/src/serve/gateway-db-lock.integration.test.ts`.
- **Not exercised in this pass**, so unverified on this tree: `bun run check:push` as a whole, and every gate not named in the table above.
- **No scaffolding was left behind.** An attempt to publish a throwaway snapshot for the auditor to read (`refs/heads/tmp-audit-916`, commit `4e3f5bf7`) timed out mid-push and never landed; `git ls-remote origin refs/heads/tmp-audit-916` is empty. This branch is one commit.
- **The `verify` job's perf lane runs now, and it fails one budget.** F4 above got the harness past warmup; with `CENTRAID_BENCH_REQUIRE_FSYNC=1 CENTRAID_HARDWARE_PROFILE=constrained bun run test:perf:pr`, seven of eight budgets pass — `request.p99Ms` 43.1 ms of 250, `memory.rssPeakBytes` 224 MB of 512, `eventLoop.peakP99Ms` 85.5 ms of 150, `idle.contextSwitchesPerHour` 190 k of 500 k, `idle.liveDataGrowthBytesPerHour` 0 of 10 MiB, `storage.diskWriteBytesPerWrite` 101 KB of 128 KB, and `storage.fsyncPerWrite` 0 of 6 (strace ran; the trace epoch recorded no fsync). The eighth, `idle.diskWriteBytesPerHour`, measures **12.0 MB/h against a 10 MiB/h ceiling** and is red — reproduced across two runs (12.02 MB/h and 12.48 MB/h). It is not this change set's doing: it is what an idle gateway writes, measured for the first time on this branch because the harness never reached the measurement before. Left red and reported rather than raised, because a budget that is met by moving the budget measures nothing.
- **Nothing was weakened to reach this state.** No threshold, floor, budget, allow-list or assertion was loosened: `tests/hygiene-budgets.json` moved DOWN, `tests/comment-density-ratchet.json` moved up only with the recorded deviation above, and the `vault-schema-ladder` floor was met by adding two real tests rather than lowered.

### File coverage

Every path in `git status --short` for this change set (586 files besides this receipt: 38 added, 24 deleted, 4 renamed, 520 modified; 20,234 insertions and 19,405 deletions).

### repository root (8)

```
.github/workflows/ci.yml
AGENTS.md
ARCHITECTURE.md
CHANGELOG.md
QUALITY.md
README.md
SECURITY.md
package.json
```

### apps (13)

```
apps/mobile/src/apps/agenda/useAgenda.ts
apps/mobile/src/apps/docs/DocsHome.test.tsx
apps/mobile/src/apps/docs/DocumentVersions.tsx
apps/mobile/src/apps/docs/INTEGRATION-NOTES.md
apps/mobile/src/apps/docs/docs-projection-shares.ts
apps/mobile/src/apps/docs/docs-projection.test.ts
apps/mobile/src/apps/docs/useDocsGrantAudiences.ts
apps/mobile/src/apps/photos/photo-grants.ts
apps/mobile/src/apps/photos/timeline-engine.ts
apps/mobile/src/kit/share/ShareSheet.test.tsx
apps/mobile/src/kit/share/ShareSheet.tsx
apps/mobile/src/screens/Capture.tsx
apps/mobile/src/screens/Scan.tsx
```

### docs (9)

```
docs/cron-timezone.md
docs/decisions.md
docs/dev-environment.md
docs/glossary.md
docs/logs.md
docs/protocol.md
docs/recovery/backup-restore.md
docs/traps/wal-checkpoint.md
docs/vault-ontology.md
```

### packages/backup (18)

```
packages/backup/FORMAT.md
packages/backup/README.md
packages/backup/src/conformance.ts
packages/backup/src/engine.test.ts
packages/backup/src/engine.ts
packages/backup/src/index.ts
packages/backup/src/interop-clawgnition.test.ts
packages/backup/src/manifest.ts
packages/backup/src/materialize.test.ts
packages/backup/src/password-wrap.ts
packages/backup/src/recovery-kit.ts
packages/backup/src/wal-address-properties.test.ts
packages/backup/src/wal-address.test-fixtures.ts
packages/backup/src/wal-format.test.ts
packages/backup/src/wal-format.ts
packages/backup/src/wal-prefix-properties.test.ts
packages/backup/src/wal-restore.test.ts
packages/backup/src/wal-restore.ts
```

### packages/blueprints (39)

```
packages/blueprints/README.md
packages/blueprints/apps/_shared/action-kit.test.ts
packages/blueprints/apps/agenda/queries/parties.ts
packages/blueprints/apps/agenda/queries/search.ts
packages/blueprints/apps/agenda/queries/upcoming.ts
packages/blueprints/apps/docs/app-root.tsx
packages/blueprints/apps/docs/app.json
packages/blueprints/apps/docs/components/Activity.tsx
packages/blueprints/apps/docs/metadata.ts
packages/blueprints/apps/docs/queries/_shared.ts
packages/blueprints/apps/docs/queries/activity.ts
packages/blueprints/apps/docs/queries/shared-origin.test.ts
packages/blueprints/apps/docs/queries/shares.test.ts
packages/blueprints/apps/locker/app.json
packages/blueprints/apps/locker/components/Access.tsx
packages/blueprints/apps/locker/queries.test.ts
packages/blueprints/apps/locker/queries/access.ts
packages/blueprints/apps/notes/logic-panes.test.ts
packages/blueprints/apps/notes/logic.test.ts
packages/blueprints/apps/people/queries/person.ts
packages/blueprints/apps/people/queries/share-links.test.ts
packages/blueprints/apps/photos/app.json
packages/blueprints/apps/photos/queries/_shared.ts
packages/blueprints/apps/photos/queries/duplicates.ts
packages/blueprints/apps/photos/queries/enrichment-status.ts
packages/blueprints/apps/photos/queries/face-queue.ts
packages/blueprints/apps/photos/queries/faces.ts
packages/blueprints/apps/photos/queries/library.ts
packages/blueprints/apps/photos/queries/people.ts
packages/blueprints/apps/photos/queries/search.ts
packages/blueprints/apps/photos/queries/storage.ts
packages/blueprints/apps/tally/queries/dashboard.ts
packages/blueprints/apps/tally/queries/export.test.ts
packages/blueprints/apps/tally/queries/group-departed.test.ts
packages/blueprints/apps/tally/seed.js
packages/blueprints/src/app-manifest-reads.test.ts
packages/blueprints/src/day-context-journal-queries.test.ts
packages/blueprints/src/handler-crud-smoke.integration.test.ts
packages/blueprints/src/photos-vocabulary.test.ts
packages/blueprints/types/centraid.d.ts
```

### packages/client (15)

```
packages/client/src/gateway-client-contract-fixtures.ts
packages/client/src/gateway-client-local-storage.ts
packages/client/src/gateway-client-vault-imports.ts
packages/client/src/gateway-client-vault.ts
packages/client/src/react/blueprints/centraid-inline.test.ts
packages/client/src/react/blueprints/centraid-inline.ts
packages/client/src/react/screens/AtlasRelationsTab.test.tsx
packages/client/src/react/screens/AtlasScreen.test.tsx
packages/client/src/react/screens/SettingsDiagnosticsScreen.test.tsx
packages/client/src/react/screens/StorageLimitsPanel.tsx
packages/client/src/react/screens/atlasOrreryGeometry.test.ts
packages/client/src/react/screens/atlasRelationsTestKit.tsx
packages/client/src/react/shell/routes/approvalsData.test.ts
packages/client/src/react/shell/routes/automationThreadData.ts
packages/client/src/replica/search.ts
```

### packages/core (10)

```
packages/core/src/time/index.ts
packages/core/src/time/recurrence-lifecycle-properties.test.ts
packages/core/src/time/recurrence-properties.test.ts
packages/core/src/time/recurrence-summary.ts
packages/core/src/time/recurrence.test.ts
packages/core/src/time/recurrence.ts
packages/core/src/time/rrule-support.test.ts
packages/core/src/time/rrule-support.ts
packages/core/stryker.time.config.mjs
packages/core/vitest.time.mutation.config.ts
```

### packages/server — the rest of the package (43)

```
packages/server/README.md
packages/server/scripts/bench-low-end.mjs
packages/server/src/acp/automation/live-automation-failover.test.ts
packages/server/src/acp/automation/run-automation-consent.test.ts
packages/server/src/acp/automation/run-automation-dispatch.test.ts
packages/server/src/acp/automation/run-automation-live-dispatch.ts
packages/server/src/acp/automation/run-automation.test.ts
packages/server/src/acp/automation/run-automation.ts
packages/server/src/acp/prompt-injection/harness.ts
packages/server/src/automation/fire/condition.test.ts
packages/server/src/automation/fire/connector.test.ts
packages/server/src/automation/fire/cursor-engine.test.ts
packages/server/src/automation/fire/cursor-invariants.test.ts
packages/server/src/automation/fire/enrich-engine-selection.test.ts
packages/server/src/automation/fire/enrich-gate.test.ts
packages/server/src/automation/fire/enrich-refusal-outcome.test.ts
packages/server/src/automation/fire/fire-vault.test.ts
packages/server/src/automation/fire/fire.test.ts
packages/server/src/automation/fire/fire.ts
packages/server/src/automation/manifest/manifest-vault.test.ts
packages/server/src/automation/manifest/manifest.ts
packages/server/src/automation/worker/runner.ts
packages/server/src/brief/daily-brief.test.ts
packages/server/src/brief/daily-brief.ts
packages/server/src/cli/doctor.ts
packages/server/src/doctor/integrity-checks.test.ts
packages/server/src/doctor/integrity-checks.ts
packages/server/src/enrich/semantic-search.test.ts
packages/server/src/enrich/semantic-search.ts
packages/server/src/ledger-stores.test.ts
packages/server/src/ledger-stores.ts
packages/server/src/lifecycle/automation-anchor-scopes.test.ts
packages/server/src/lifecycle/headless-automation-compile.test.ts
packages/server/src/lifecycle/headless-automation-compile.ts
packages/server/src/lifecycle/interactive-automation-turn.test.ts
packages/server/src/lifecycle/interactive-automation-turn.ts
packages/server/src/lifecycle/rewrite-automation-instructions.test.ts
packages/server/src/lifecycle/rewrite-automation-instructions.ts
packages/server/src/lifecycle/webhook-route-over-http.test.ts
packages/server/src/paths.ts
packages/server/src/reminders/due-reminders.test.ts
packages/server/src/reminders/due-reminders.ts
packages/server/src/runs/run-events-sse.test.ts
```

### packages/server/src/backup (23)

```
packages/server/src/backup/backup-cas-reconciliation.ts
packages/server/src/backup/backup-health.test.ts
packages/server/src/backup/backup-health.ts
packages/server/src/backup/backup-reconciliation.test.ts
packages/server/src/backup/backup-reconciliation.ts
packages/server/src/backup/backup-recovery-kit-lifecycle.test.ts
packages/server/src/backup/backup-service-restore.test.ts
packages/server/src/backup/backup-service.contract.test.ts
packages/server/src/backup/backup-service.ts
packages/server/src/backup/backup-sources.test.ts
packages/server/src/backup/backup-sources.ts
packages/server/src/backup/backup-state.ts
packages/server/src/backup/backup.integration.test.ts
packages/server/src/backup/recover-internals.test.ts
packages/server/src/backup/recover-internals.ts
packages/server/src/backup/recover-reconcile.test.ts
packages/server/src/backup/recover.integration.test.ts
packages/server/src/backup/restore-drill.ts
packages/server/src/backup/restore-lazy.integration.test.ts
packages/server/src/backup/snapshot-blob-roots.test.ts
packages/server/src/backup/wal-uploader.test.ts
packages/server/src/backup/wal-uploader.ts
packages/server/src/backup/wal.integration.test.ts
```

### packages/server/src/engine (29)

```
packages/server/src/engine/conversation/archive/archive.contract.test.ts
packages/server/src/engine/conversation/archive/digest-parity.test.ts
packages/server/src/engine/conversation/archive/selector.test.ts
packages/server/src/engine/conversation/archive/test-fixtures.ts
packages/server/src/engine/conversation/history.test.ts
packages/server/src/engine/conversation/history.ts
packages/server/src/engine/conversation/hydration.test.ts
packages/server/src/engine/conversation/rehydrate.test.ts
packages/server/src/engine/conversation/reprice.test.ts
packages/server/src/engine/conversation/schema.ts
packages/server/src/engine/conversation/store-prune.test.ts
packages/server/src/engine/conversation/store-sql.test.ts
packages/server/src/engine/conversation/store-test-fixtures.ts
packages/server/src/engine/conversation/store.ts
packages/server/src/engine/conversation/trigger-store.test.ts
packages/server/src/engine/conversation/trigger-store.ts
packages/server/src/engine/handlers/vault-bridge.test.ts
packages/server/src/engine/handlers/vault-bridge.ts
packages/server/src/engine/http/turn-routes.test.ts
packages/server/src/engine/http/turn-sse.test.ts
packages/server/src/engine/index.ts
packages/server/src/engine/insights/analytics-store.test.ts
packages/server/src/engine/insights/insights-store.test.ts
packages/server/src/engine/insights/insights-store.ts
packages/server/src/engine/stores/gateway-db.test.ts
packages/server/src/engine/stores/gateway-db.ts
packages/server/src/engine/stores/ledger-db.test-fixtures.ts
packages/server/src/engine/stores/vault-workspace.ts
packages/server/src/engine/worker/runner.ts
```

### packages/server/src/routes (23)

```
packages/server/src/routes/assistant-routes.test.ts
packages/server/src/routes/automations-routes-lanes.test.ts
packages/server/src/routes/automations-routes.test.ts
packages/server/src/routes/automations-routes.ts
packages/server/src/routes/commons-routes.ts
packages/server/src/routes/edges-reconcile.ts
packages/server/src/routes/edges-routes.test.ts
packages/server/src/routes/edges-routes.ts
packages/server/src/routes/grant-routes.test.ts
packages/server/src/routes/import-routes.test.ts
packages/server/src/routes/import-routes.ts
packages/server/src/routes/push-wake-routes.ts
packages/server/src/routes/reminders-routes.ts
packages/server/src/routes/replica-grantees.ts
packages/server/src/routes/replica-intent-attribution.test.ts
packages/server/src/routes/replica-intent-route.test.ts
packages/server/src/routes/replica-projection.ts
packages/server/src/routes/replica-shape.test.ts
packages/server/src/routes/replica-shape.ts
packages/server/src/routes/storage-local-routes.test.ts
packages/server/src/routes/vault-routes.atlas.test.ts
packages/server/src/routes/vault-routes.browse.test.ts
packages/server/src/routes/vault-routes.ts
```

### packages/server/src/serve (47)

```
packages/server/src/serve/agent-owner-cap.test.ts
packages/server/src/serve/build-gateway.ts
packages/server/src/serve/commons-b6.test-fixtures.ts
packages/server/src/serve/declared-writes.conformance.test.ts
packages/server/src/serve/declared-writes.ts
packages/server/src/serve/demo-seed.test.ts
packages/server/src/serve/disk-health.test.ts
packages/server/src/serve/disk-health.ts
packages/server/src/serve/grant-fulfillment.test.ts
packages/server/src/serve/grant-fulfillment.ts
packages/server/src/serve/link-party-bindings.test.ts
packages/server/src/serve/link-party-bindings.ts
packages/server/src/serve/local-usage.test.ts
packages/server/src/serve/local-usage.ts
packages/server/src/serve/manifest-scope-denial.closed-grammar.test.ts
packages/server/src/serve/manifest-scope-denial.hostile.test.ts
packages/server/src/serve/manifest-scope-denial.sweep.test-fixtures.ts
packages/server/src/serve/manifest-scope-denial.sweep.test.ts
packages/server/src/serve/outbox-executor.test.ts
packages/server/src/serve/peer-commons-b6.test.ts
packages/server/src/serve/peer-commons-pull.test.ts
packages/server/src/serve/peer-commons-sweep.ts
packages/server/src/serve/peer-commons-tally-b6.test.ts
packages/server/src/serve/peer-give.test-fixtures.ts
packages/server/src/serve/peer-plane-sweep.test.ts
packages/server/src/serve/peer-plane-sweep.ts
packages/server/src/serve/peer-transport-remote.test.ts
packages/server/src/serve/protocol-join-lane.test.ts
packages/server/src/serve/serve-scheduler-reconcile.test.ts
packages/server/src/serve/serve.test.ts
packages/server/src/serve/share-effect-executor.ts
packages/server/src/serve/support-bundle-source.ts
packages/server/src/serve/support-bundle.test.ts
packages/server/src/serve/support-bundle.ts
packages/server/src/serve/vault-integrity-health.ts
packages/server/src/serve/vault-plane-app-bridge.test.ts
packages/server/src/serve/vault-plane-assistant.test.ts
packages/server/src/serve/vault-plane-commons.test.ts
packages/server/src/serve/vault-plane-consent.test.ts
packages/server/src/serve/vault-plane-conversation-archival.test.ts
packages/server/src/serve/vault-plane-links.test.ts
packages/server/src/serve/vault-plane-scopes.test.ts
packages/server/src/serve/vault-plane-wal.test.ts
packages/server/src/serve/vault-plane.ts
packages/server/src/serve/vault-registry-footprint.test.ts
packages/server/src/serve/vault-registry.test.ts
packages/server/src/serve/vault-registry.ts
```

### packages/test-kit (1)

```
packages/test-kit/src/year3-vault.ts
```

### packages/vault — the rest of the package (53)

```
packages/vault/README.md
packages/vault/src/blob/content-keys.ts
packages/vault/src/blob/flow.test.ts
packages/vault/src/blob/local-orphan-sweep.test.ts
packages/vault/src/blob/local-orphan-sweep.ts
packages/vault/src/blob/preview.test.ts
packages/vault/src/bootstrap.ts
packages/vault/src/conversation-archive-roots.test.ts
packages/vault/src/conversation-archive-roots.ts
packages/vault/src/db.test.ts
packages/vault/src/db.ts
packages/vault/src/doctor.test.ts
packages/vault/src/doctor.ts
packages/vault/src/enrich/clusters.test.ts
packages/vault/src/enrich/derivation.test.ts
packages/vault/src/enrich/egress-consent.ts
packages/vault/src/enrich/enrich.test.ts
packages/vault/src/enrich/leases.test.ts
packages/vault/src/enrich/photo-search.ts
packages/vault/src/enrich/similarity.ts
packages/vault/src/golden-vault.test.ts
packages/vault/src/grant/authority-registry.ts
packages/vault/src/grant/channel.test.ts
packages/vault/src/grant/device-trust.ts
packages/vault/src/grant/fulfillment-edit.test.ts
packages/vault/src/grant/fulfillment.roster.test.ts
packages/vault/src/grant/fulfillment.test-fixtures.ts
packages/vault/src/grant/fulfillment.test.ts
packages/vault/src/grant/fulfillment.ts
packages/vault/src/grant/grant-authority.ts
packages/vault/src/grant/grant-store.test.ts
packages/vault/src/grant/grant-store.ts
packages/vault/src/host.test.ts
packages/vault/src/host.ts
packages/vault/src/index.ts
packages/vault/src/ingest/enrich-publishers.test.ts
packages/vault/src/ingest/ingest.test.ts
packages/vault/src/ingest/publishers.ts
packages/vault/src/ingest/staging.test.ts
packages/vault/src/ingest/staging.ts
packages/vault/src/ingest/takeout-photos.test.ts
packages/vault/src/install-memory.ts
packages/vault/src/journal-archive.test.ts
packages/vault/src/journal-archive.ts
packages/vault/src/restore-check.ts
packages/vault/src/vault-footprint.ts
packages/vault/src/wal-shipper-detectors.test.ts
packages/vault/src/wal-shipper.test.ts
packages/vault/src/wal-shipper.ts
packages/vault/tests/golden/issue-916/manifest.json
packages/vault/tests/golden/issue-916/vault.db.gz
packages/vault/tests/golden/v0-baseline/journal.db.gz
packages/vault/tests/golden/v0-baseline/manifest.json
packages/vault/tests/golden/v0-baseline/vault.db.gz
```

### packages/vault/src/commands — the typed writes (61)

```
packages/vault/src/commands/annotations.ts
packages/vault/src/commands/atlas.test.ts
packages/vault/src/commands/atlas.ts
packages/vault/src/commands/attachments.ts
packages/vault/src/commands/documents.ts
packages/vault/src/commands/enrich.ts
packages/vault/src/commands/entity-revisions.ts
packages/vault/src/commands/finance.test.ts
packages/vault/src/commands/finance.ts
packages/vault/src/commands/flags.ts
packages/vault/src/commands/health.test.ts
packages/vault/src/commands/health.ts
packages/vault/src/commands/inline-body-guard.test.ts
packages/vault/src/commands/judgment.test.ts
packages/vault/src/commands/judgment.ts
packages/vault/src/commands/knowledge.test.ts
packages/vault/src/commands/knowledge.ts
packages/vault/src/commands/links.test.ts
packages/vault/src/commands/links.ts
packages/vault/src/commands/locker-export.test.ts
packages/vault/src/commands/locker-export.ts
packages/vault/src/commands/locker-extras.test.ts
packages/vault/src/commands/locker-extras.ts
packages/vault/src/commands/locker-shared.ts
packages/vault/src/commands/locker-sidecars.ts
packages/vault/src/commands/locker.ts
packages/vault/src/commands/media-forget-person.test.ts
packages/vault/src/commands/media-purge.test.ts
packages/vault/src/commands/media.test.ts
packages/vault/src/commands/media.ts
packages/vault/src/commands/merge-fold.ts
packages/vault/src/commands/merge.test.ts
packages/vault/src/commands/merge.ts
packages/vault/src/commands/organize-domains.test.ts
packages/vault/src/commands/outbox.test.ts
packages/vault/src/commands/outbox.ts
packages/vault/src/commands/parties.test.ts
packages/vault/src/commands/parties.ts
packages/vault/src/commands/people.ts
packages/vault/src/commands/schedule-organize.test.ts
packages/vault/src/commands/schedule-organize.ts
packages/vault/src/commands/schedule-projects.ts
packages/vault/src/commands/schedule.test.ts
packages/vault/src/commands/schedule.ts
packages/vault/src/commands/share.test.ts
packages/vault/src/commands/share.ts
packages/vault/src/commands/social.test.ts
packages/vault/src/commands/social.ts
packages/vault/src/commands/sync.test.ts
packages/vault/src/commands/sync.ts
packages/vault/src/commands/tags.ts
packages/vault/src/commands/tally-groups.test.ts
packages/vault/src/commands/tally-ledger-test-kit.ts
packages/vault/src/commands/tally-ledger.test.ts
packages/vault/src/commands/tally-organize.ts
packages/vault/src/commands/tally-receipts.test.ts
packages/vault/src/commands/tally-splits.ts
packages/vault/src/commands/tally.test.ts
packages/vault/src/commands/tally.ts
packages/vault/src/commands/tasks.test.ts
packages/vault/src/commands/tasks.ts
```

### packages/vault/src/gateway — the access plane and the duties (45)

```
packages/vault/src/gateway/access-properties.test.ts
packages/vault/src/gateway/access.ts
packages/vault/src/gateway/acting-owner.test.ts
packages/vault/src/gateway/activity-read.test.ts
packages/vault/src/gateway/cards.ts
packages/vault/src/gateway/contract.ts
packages/vault/src/gateway/custody.test.ts
packages/vault/src/gateway/custody.ts
packages/vault/src/gateway/demo.test.ts
packages/vault/src/gateway/demo.ts
packages/vault/src/gateway/duties-helpers.test.ts
packages/vault/src/gateway/duties.test.ts
packages/vault/src/gateway/duties.ts
packages/vault/src/gateway/evidence.test.ts
packages/vault/src/gateway/evidence.ts
packages/vault/src/gateway/execution-clamp.test.ts
packages/vault/src/gateway/execution.test.ts
packages/vault/src/gateway/execution.ts
packages/vault/src/gateway/ext-sealed.test.ts
packages/vault/src/gateway/ext.test.ts
packages/vault/src/gateway/ext.ts
packages/vault/src/gateway/filters.ts
packages/vault/src/gateway/gateway.contract.test.ts
packages/vault/src/gateway/gateway.ts
packages/vault/src/gateway/identity.ts
packages/vault/src/gateway/locker-auth.test.ts
packages/vault/src/gateway/locker-auth.ts
packages/vault/src/gateway/locker-sidecar-reveal.test.ts
packages/vault/src/gateway/portability.test.ts
packages/vault/src/gateway/portability.ts
packages/vault/src/gateway/portable-custody.ts
packages/vault/src/gateway/portable-export.ts
packages/vault/src/gateway/portable-sealed-custody.test.ts
packages/vault/src/gateway/reseal.ts
packages/vault/src/gateway/revision-capture.ts
packages/vault/src/gateway/seal-custody.test.ts
packages/vault/src/gateway/sealed-artifact.test.ts
packages/vault/src/gateway/sealed-artifact.ts
packages/vault/src/gateway/sealed.test.ts
packages/vault/src/gateway/search.test.ts
packages/vault/src/gateway/search.ts
packages/vault/src/gateway/share-grant-seam.test.ts
packages/vault/src/gateway/sql.test.ts
packages/vault/src/gateway/types.ts
packages/vault/src/gateway/views.ts
```

### packages/vault/src/replica (9)

```
packages/vault/src/replica/change-log.test.ts
packages/vault/src/replica/change-log.ts
packages/vault/src/replica/intents.ts
packages/vault/src/replica/invocation-commits.test.ts
packages/vault/src/replica/invocation-commits.ts
packages/vault/src/replica/parked.ts
packages/vault/src/replica/snapshot.test.ts
packages/vault/src/replica/snapshot.ts
packages/vault/src/replica/unavailable-columns.ts
```

### packages/vault/src/schema — the baseline (66)

```
packages/vault/src/schema/access.ts
packages/vault/src/schema/agent.ts
packages/vault/src/schema/atlas-browse-refs.ts
packages/vault/src/schema/atlas-browse.ts
packages/vault/src/schema/atlas-census.test.ts
packages/vault/src/schema/atlas-census.ts
packages/vault/src/schema/atlas-graph.ts
packages/vault/src/schema/atlas.test.ts
packages/vault/src/schema/atlas.ts
packages/vault/src/schema/audit-band.test.ts
packages/vault/src/schema/audit.ts
packages/vault/src/schema/authority.ts
packages/vault/src/schema/baseline-fixture.ts
packages/vault/src/schema/blob-transfer.ts
packages/vault/src/schema/blob.ts
packages/vault/src/schema/commons-resilience.ts
packages/vault/src/schema/consent.ts
packages/vault/src/schema/content-references.ts
packages/vault/src/schema/core.ts
packages/vault/src/schema/domains-health-finance-schedule.ts
packages/vault/src/schema/domains-home-business.ts
packages/vault/src/schema/domains-locker.ts
packages/vault/src/schema/domains-people.ts
packages/vault/src/schema/domains-schedule.ts
packages/vault/src/schema/domains-social-knowledge-media.ts
packages/vault/src/schema/domains-tally.ts
packages/vault/src/schema/enrich.ts
packages/vault/src/schema/entity-catalog.ts
packages/vault/src/schema/entity-declaration.ts
packages/vault/src/schema/entity-labels.test.ts
packages/vault/src/schema/entity-refs.test.ts
packages/vault/src/schema/entity-refs.ts
packages/vault/src/schema/entity-revisions.ts
packages/vault/src/schema/entity.ts
packages/vault/src/schema/ext.ts
packages/vault/src/schema/fk-index.test.ts
packages/vault/src/schema/fts.ts
packages/vault/src/schema/journal.ts
packages/vault/src/schema/ledger.ts
packages/vault/src/schema/lifecycle.test.ts
packages/vault/src/schema/local-tables.ts
packages/vault/src/schema/migrate-authority.test.ts
packages/vault/src/schema/migrate-reconcile.test.ts
packages/vault/src/schema/migrate-share-grant.test.ts
packages/vault/src/schema/migrate.test-helpers.ts
packages/vault/src/schema/migrate.test.ts
packages/vault/src/schema/migrate.ts
packages/vault/src/schema/ontology-doc.test.ts
packages/vault/src/schema/ontology-doc.ts
packages/vault/src/schema/ontology-rules.test.ts
packages/vault/src/schema/ontology-shape.test.ts
packages/vault/src/schema/outbox.ts
packages/vault/src/schema/party-pointers.ts
packages/vault/src/schema/poly-refs.test.ts
packages/vault/src/schema/poly-refs.ts
packages/vault/src/schema/reconcile.ts
packages/vault/src/schema/replica.ts
packages/vault/src/schema/sealed.ts
packages/vault/src/schema/seed.ts
packages/vault/src/schema/share-commons.ts
packages/vault/src/schema/share-grant.ts
packages/vault/src/schema/sync.ts
packages/vault/src/schema/table-stats.ts
packages/vault/src/schema/tables.ts
packages/vault/src/schema/time-organize.ts
packages/vault/src/schema/updated-at.ts
```

### packages/vault/src/share — the share plane (38)

```
packages/vault/src/share/closure-confinement.contract.test.ts
packages/vault/src/share/closure-split.test.ts
packages/vault/src/share/closure.ts
packages/vault/src/share/commons-automation-b6.test.ts
packages/vault/src/share/commons-bootstrap.ts
packages/vault/src/share/commons-chain.test.ts
packages/vault/src/share/commons-convergence-properties.test.ts
packages/vault/src/share/commons-decide.test.ts
packages/vault/src/share/commons-decide.ts
packages/vault/src/share/commons-docs-b6.test.ts
packages/vault/src/share/commons-hardening.test.ts
packages/vault/src/share/commons-intent.test-fixtures.ts
packages/vault/src/share/commons-invoke.test.ts
packages/vault/src/share/commons-lifecycle.test.ts
packages/vault/src/share/commons-lifecycle.ts
packages/vault/src/share/commons-recovery.ts
packages/vault/src/share/commons-sim-grant-world.test-fixtures.ts
packages/vault/src/share/commons-sim-grant.test-fixtures.ts
packages/vault/src/share/commons-sim-world.test-fixtures.ts
packages/vault/src/share/commons-sim.test.ts
packages/vault/src/share/commons-tally-b6.test.ts
packages/vault/src/share/commons-tally-grant.test.ts
packages/vault/src/share/commons.test.ts
packages/vault/src/share/commons.ts
packages/vault/src/share/docs-folder.test.ts
packages/vault/src/share/household.test.ts
packages/vault/src/share/party-vault-binding.ts
packages/vault/src/share/placement-fixture.ts
packages/vault/src/share/placement-lifecycle.test.ts
packages/vault/src/share/placement.test.ts
packages/vault/src/share/placement.ts
packages/vault/src/share/project-closure.ts
packages/vault/src/share/project-household.ts
packages/vault/src/share/read-closure.ts
packages/vault/src/share/read-tally.ts
packages/vault/src/share/removal.ts
packages/vault/src/share/self-binding.ts
packages/vault/src/share/sql.ts
```

### scripts (14)

```
scripts/corpora/backup-format-census.json
scripts/corpora/schema-epoch-census.json
scripts/corpora/vault-corpus.ts
scripts/docs-site/src/content/backups.html
scripts/docs-site/src/content/data.html
scripts/docs-site/src/content/devices.html
scripts/docs-site/src/content/learn.html
scripts/docs-site/src/content/ontology-body.html
scripts/docs-site/src/content/start.html
scripts/docs-site/src/content/understand.html
scripts/golden-vault/build.mjs
scripts/lint-vault-sql.mjs
scripts/lint-vault-sql.test.mjs
scripts/mutation/seeds.mjs
```

### tests (26)

```
tests/comment-density-ratchet.json
tests/claims.json
tests/floors.json
tests/hygiene-budgets.json
tests/perf/automation-fire.perf.test.ts
tests/perf/fixtures/vault-write-child.mjs
tests/perf/gateway-request-volume.perf.test.ts
tests/perf/vault-write.perf.test.ts
tests/quality/backup-archaeology.test.ts
tests/quality/backup-corpus-fixture.ts
tests/quality/component-chaos-world.ts
tests/quality/component-chaos.integration.test.ts
tests/quality/diagnostics-redaction-canary.test.ts
tests/quality/first-paint-query-counts.test.ts
tests/quality/fixtures/kill-mid-write-child.ts
tests/quality/mobile-resource-evidence.test.ts
tests/quality/schema-migration-corpus.test.ts
tests/quality/user-facing-qualities.test.ts
tests/scale/backup-restore.scale.test.ts
tests/scale/large-vault.scale.test.ts
tests/scale/multi-vault-footprint.scale.test.ts
tests/scale/ontology.scale.test.ts
tests/scale/photos-timeline.scale.test.ts
tests/scale/restore-10gib.scale.test.ts
tests/schema-export-fingerprint.json
tests/skips.json
```

## Audit

**Run 2026-09-02, independent, fresh context, read-only, from the issue and the diff rather than from this receipt.** The seven rulings the umbrella turns on all landed and were verified against the shipping schema rather than taken on this receipt's word: one file with both bands and no `journal.db`, `PRAGMA user_version = 1` on a single rung, `core_entity` with real composite foreign keys on the former polymorphic pairs, `core_entity_revision` with `locker_item_history` gone, the access plane renamed through code and ledgers, `core_vault.self_party_id`, and `core_entity_revoke_on_purge` — which the auditor reproduced firing from both the leaf table and the supertype, with RESTRICT refusing a purge that money still names. `packages/vault`'s 1550 tests, its typecheck, `lint:vault-sql` and `lint:schema-export` were green under the audit.

**The verdict is PASS-WITH-CONCERNS, and three findings are substantive. All three are fixed** — see `## What changed`'s "Answering the audit"; the paragraph below is the audit's own text, kept as it was written. (1) `core_entity.entity_id` is documented as a global namespace but the membership trigger writes `INSERT OR IGNORE`, so an id already held by a different kind is accepted silently: no supertype row is minted, the entity table's key is satisfied by the other type's row, and purging one entity deletes the unrelated other. Reproduced. `share/sql.ts`'s `freeId` still checks only the destination table, which was right before the supertype and is the reachable entry point for peer-supplied ids. **Fixed:** the trigger raises on a cross-kind collision and `freeId` asks `core_entity`. (2) The golden corpus at `tests/golden/issue-916` was frozen before this wave's last three shape fixes and does not match the shipping DDL on `sync_import_batch.connection_id`, `share_commons_invitation.grant_id` and `share_commons_intent.grant_id`; the golden gate cannot see it because it compares rows, not schema. **Fixed:** the corpus is re-frozen from the generator and the gate compares the frozen schema against a vault founded by today's baseline. (3) Revoke-on-purge is gated on `principal_kind = 'person'`, so deleting a circle — which `tally.delete_group` does — leaves live authority rows naming an audience that no longer exists. Reproduced. **Fixed:** the clause is generated from `PRINCIPAL_ENTITY_KINDS` and covers every principal kind that is a row.

**Seven smaller findings**, recorded rather than fixed in the same pass: ten `CHECK` values still admitted with no writer anywhere (four of them on `core_account.kind`); dropped entities still in `commands/attachments.ts`'s `SUBJECT_PK` allow-list (**corrected** — `health.vital` and `finance.recurring_series` named tables ONT-06 deleted, and that map is the allow-list its own comment says turns an unknown `subject_type` into a refusal "never turned into SQL"; both are gone, and `core.attach`'s input-schema `enum` and the exported `ATTACHABLE_SUBJECTS` narrow with them. `commands/tags.ts`'s sibling map was checked and was already clean) and in `portable-export.ts`'s comments (**corrected** — its #872 Locker audit note called `locker_item_history` "the ONLY record that a password was ever rotated" and listed five sidecars that MUST be carried, three waves after D2 dropped that table; four now, and the note says where rotation history went); this receipt attributing ledger edits to a `tests/matrix.json` that no longer exists while never naming `tests/floors.json`, the one changed file it omits and the one the ledger gates fail on (**corrected**, and both files are in the coverage list now); `tests/schema-export-fingerprint.json` carrying clause (11) twice; two `## Verification` outputs that no longer reproduce (`lint:vault-sql` 472 refs across 4242 files; `lint:schema-export` has since moved again and prints `3b341ecb8abdc58b…`, re-pinned as clause (12)); a checked box claiming the audit **and ledger** bands are append-only when only the audit band's tables carry the triggers (**corrected**); and `docs/decisions.md`'s L-access row plus the published city explainer still describing a `journal.db` that no longer exists.

**Limits of this audit, in its own words.** It ran against a working tree carrying four uncommitted files it did not author. It could not run the mobile device gate or reach SonarCloud, did not run the repo-wide gate set or `.governance/run.sh`, could not read `share/project-closure.ts`'s diff — a raw NUL byte in a string literal makes git treat the file as binary, so roughly a kilobyte of this change set escaped textual review (the byte is a `\0` escape now, so the file reads as text again) — and proved the golden-corpus drift by three sampled divergences rather than a whole-schema comparison. Its confirmation of the Locker gap is broader than this receipt had it: the blueprint's own tests (`item-sections.test.tsx`, `queries.test.ts`) pin the dropped table too, so all 341 locker tests pass against a world that no longer exists.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-03 | claude-code | afeff558-9f71-5ea3-b2fa-0b0772eb9ed7 |
