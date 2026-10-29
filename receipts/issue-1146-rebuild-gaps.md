# Issue #1146 — Fix what the vault-model rebuild skipped, and remove the journal from v0

Worked as an umbrella by orchestration ([#1146](https://github.com/srikanth235/centraid/issues/1146)). The root agent holds the plan and the owner's rulings; lanes run **serially in the root checkout**, on one branch, sharing one warm `target/` (R-1146-0-1, the precedent of R-1135-0-1 under [#1135](https://github.com/srikanth235/centraid/issues/1135)). A lane appends one `###` section under `## What changed` and nothing before it, so `doc-integrity` sees a byte-prefix.

## Audit

No verdict is recorded here. An independent reviewer, who did not write the lanes, writes one.

## Verification

Each lane records its own commands and outcomes in its section below. The umbrella's closing run is the close lane's.

## What changed

### Lane 1A — Locker without receipts

Owner rulings D1 and D2 of #1146: drop Locker's `receipt` table, give each item a `last_used_at` and the Locker a failed-unlock count and time; keep Locker searchable and visible to the assistant as today (nothing in search or the assistant's reach was touched).

- **The vault.** `contracts/migrations/001_baseline.sql` founds no `receipt` table, indexes or trigger; `locker_item` gains `last_used_at`, `locker_key` gains `failed_unlocks` and `failed_unlock_at`. `CommandCtx::write_receipt` and the `journal_seq` it carried are gone. `locker.reveal_receipt` is `locker.mark_used` (input `item_id` only); `locker.totp_code` stamps the item; `locker.export` stamps none; `locker.mark_unlocked` and `locker.mark_unlock_failed` are new. `Vault::locker_failed_unlocks` reads the figures.
- **The core.** `reveal` and `totp` run their stamp before they open a cell, as the receipt was; `unlock` runs `locker.mark_unlocked`; a new session step `LockerUnlockFailed` runs `locker.mark_unlock_failed`. Every session answer carries `failed_unlocks` and the latest refusal as a local day and minute; `receipt_id` leaves every answer.
- **The screens.** The Access screen, its route, strings and tests are deleted. An item's Details say "Last used 30 Jun" or "Never". The locked wall says "N failed unlocks · last <when>"; Locker's home says it once, under its status line, after the unlock that cleared it. The wall and the chat's unlock report the owner check's `FAILED` and `LOCKED_OUT` outcomes.
- **The wire.** `locker.access` (app query 64, route 403, event 404, state 403) and `LockerAccess*` are removed with their numbers and names `reserved`; `receipt_id` is `reserved` on `LockerSessionResponse`, `LockerRevealed`, `LockerTotp` and `LockerExported`; `LockerStateAsk`, `LockerUnlock` and `LockerUnlockFailed` carry a `tz`.
- **The app.** `crates/apps/locker` drops the `access` query and the `receipt` scope; its `reveal` action now stamps. `contracts/assist/export/metadata.json` is regenerated: the command name and an empty `names` for `reveal`, and nothing in the model-facing prompt or tool files moved.
- **The native views.** The Compose `LockerAccessScreen` and the SwiftUI `LockerAccessView` are deleted with their hosts' cases. No new control was needed: the new lines ride the item's rows, the wall's `notice` and the home's `status_line`.

#### Rulings

- **R-1146-1A-1** — _Finding:_ a table of every reveal, with one reader. _Choice:_ no log; a stamp on the item, written before the cell opens, that is not an edit; export stamps nothing. _Why:_ owner ruling D1. `last_used_at` is named in the commitment that nothing computable is stored (`STATED_NOT_COMPUTED` in `crates/vault/tests/commitments.rs`) with its reason, the one allowlist row this lane adds; the alternative, a column named to dodge the pattern, would have hidden the same fact.
- **R-1146-1A-2** — _Finding:_ the core never hears that the OS refused an unlock (`LockerUnlock` is the shell's report of success only). _Choice:_ the key row holds the count and time; a failed unlock is reported as its own session step and its own command, because a refused command writes nothing; a successful unlock resets the count and keeps the time. The generation is named first so a phone whose first unlock failed has a row to count on. _Why:_ the Locker has exactly one key row, so the figures need no table of their own.
- **R-1146-1A-3** — _Finding:_ a count that resets on success is invisible after the success. _Choice:_ the locked wall says it, and the unlock's answer carries what it cleared so the home says it once. _Why:_ otherwise the member who passes the prompt straight away never sees it.
- **R-1146-1A-4** — _Choice:_ only `FAILED` and `LOCKED_OUT` count; a dismissal, no passcode and an unasked probe do not.

All four are recorded in `docs/decisions.md` under Locker, with the rows they supersede marked.

#### Red-first

Four tests in `crates/vault/tests/locker_commands.rs` were written against HEAD 4c1c05f3 and failed for the right reason: `a_use_stamps_last_used_at_without_editing_the_item`, `a_code_stamps_the_item_and_an_export_stamps_none`, `a_failed_unlock_is_counted_and_a_successful_unlock_resets_it` and `a_founded_vault_has_no_receipt_table` — "4 failed", each at `no such column: last_used_at` (the first three) or the table's presence. The core and screens tests for the refusal count (`a_refused_unlock_is_counted_told_by_every_answer_and_cleared_by_the_next_unlock`, `a_refused_check_is_counted_said_on_the_wall_and_told_once_after_the_unlock`) were written with the code, not before it; their falsifications are below.

#### Falsification of the two riskiest claims

1. _"A use is not an edit."_ `stamp_use` was made to call `ctx.touch(item_id)` as well. `a_use_stamps_last_used_at_without_editing_the_item` failed: `a use changed `entity`: ["entity", "locker_item"]`. Reverted.
2. _"A refused unlock persists, even on a phone whose first unlock failed."_ The `locker_generation()` call in `unlock_failed` was removed. `a_refused_unlock_is_counted_told_by_every_answer_and_cleared_by_the_next_unlock` failed: `locker.mark_unlock_failed did not execute: the Locker has no key yet, so there is no unlock to record`. Reverted.

The wall's half of 2 (the shell's report reaches the core) was falsified too: with the `report_refusal` call disabled in `Wall::answered`, `a_refused_check_is_counted_said_on_the_wall_and_told_once_after_the_unlock` failed at its first notice assertion (`Not recognised. Try again, or use the passcode.` with no count). Reverted. A defect the first write of the wall had — it kept what an unlock cleared after a relock, so the locked wall said failures the core had cleared — was found by reading and is fixed by its own commit, with the assertion that closes it.

#### Verification

- `cargo xtask gate --profile local` — **PASS** (cold: 973 s of the 3,200 s cold ceiling; fmt, clippy `-D warnings`, `cargo test --workspace`, restore-drill, rules, doc-links and ledgers all ok). The first two attempts failed for reasons that were not the code: the container's quota filled with rustc's incremental cache (17 GB) mid-test, and clippy's `too_many_arguments` caught the `tz` argument added to the core's `unlock` (fixed in its own commit).
- `cargo test -p centraid-vault` — every binary green (227 unit; `locker_commands` 29; `commitments` 18; `ontology_page` 5).
- `cargo test -p centraid-apps-locker -p centraid-screens -p centraid-api-proto` — green (screens 368 lib plus every integration binary, the two new Locker tests among them).
- `cargo test -p centraid-core` — green (269 lib; `query_plans` 2, with the wire's query count 61 to 60: its subject, `locker.access`, is gone).
- `cargo test -p centraid-apps-kit -p centraid-nativetools -p centraid-assist` — green.
- Regenerated by their own commands and equal to a fresh render: `contracts/schema/vault-ddl.sql` (`export-ladder-ddl`), `contracts/schema/vault-commands.txt` (`export-commands`), the published ontology page (`export-ontology-page`), `crates/screens/src/catalog.rs` (`cargo xtask screens-catalog`) and `contracts/assist/export` (`nativetools export`).
- `grep -rn "INTO receipt\|FROM receipt\|journal_seq\|receipt_id\|reveal_receipt" crates mobile contracts` — only the four `reserved "receipt_id"` lines of `locker.proto`.
- `cargo xtask gate --profile mobile-jvm` — **PASS** on the fifth run (`:core:jvmTest`, the ABI round trip against the real cdylib, and the design-table drift check). The first four stopped at Gradle resolving its locked dependencies (`Received status code 429 from server: Too Many Requests` from Maven Central) with the cache growing each time; none reached a Kotlin or Swift file of this lane's, which `:core:jvmTest` does not compile.

#### Not done, and why

- **The native app views are not compiled here** (no Android SDK, no Xcode); `:core:jvmTest` does not build `mobile/androidApp` or `mobile/iosApp`. The Kotlin and Swift edits are deletions of the Access screen and its hosts' cases. The Swift and Kotlin protos are generated at build time and were not regenerated here. Owner hand-off: build both apps and open Locker, an item, and the lock wall after a refused prompt.
- **The on-device model's retrain.** `contracts/assist/export/metadata.json` changed in the `reveal` action's command and `names`; the prompt and tool files did not. Whether to refreeze the training data is the owner's.
- **Journal-side "receipt" wording** (the backup `History.receipts`, `RECEIPT_TABLE`, the custody README's "receipted refusal", `phone.proto`) is lane 1B's.

#### Files

Changed:

- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `SECURITY.md`
- `contracts/assist/export/metadata.json`
- `contracts/migrations/001_baseline.sql`
- `contracts/schema/vault-commands.txt`
- `contracts/schema/vault-ddl.sql`
- `crates/api-proto/proto/centraid/core/v1/app_query.proto`
- `crates/api-proto/proto/centraid/core/v1/envelope.proto`
- `crates/api-proto/proto/centraid/core/v1/locker.proto`
- `crates/api-proto/proto/centraid/core/v1/locker_screens.proto`
- `crates/api-proto/proto/centraid/core/v1/route.proto`
- `crates/api-proto/proto/centraid/core/v1/screens.proto`
- `crates/apps/kit/src/search_corpus.rs`
- `crates/apps/locker/README.md`
- `crates/apps/locker/manifest.json`
- `crates/apps/locker/src/commands.rs`
- `crates/apps/locker/src/lib.rs`
- `crates/apps/locker/src/manifest.rs`
- `crates/apps/locker/src/phone.rs`
- `crates/apps/locker/src/queries.rs`
- `crates/apps/locker/src/totp.rs`
- `crates/apps/locker/src/transfer.rs`
- `crates/apps/locker/src/types.rs`
- `crates/assist/src/native/park.rs`
- `crates/centraid/src/bin/seed-demo-vault.rs`
- `crates/centraid/tests/seed_demo_vault.rs`
- `crates/core/README.md`
- `crates/core/src/api.rs`
- `crates/core/src/app_query.rs`
- `crates/core/src/app_query/locker.rs`
- `crates/core/src/app_query/locker_tests.rs`
- `crates/core/src/handle.rs`
- `crates/core/src/load.rs`
- `crates/core/src/locker/mod.rs`
- `crates/core/src/locker/phone.rs`
- `crates/core/src/locker/transfer.rs`
- `crates/core/tests/assist_channel.rs`
- `crates/core/tests/query_plans.rs`
- `crates/core/tests/search_budget.rs`
- `crates/screens/src/catalog.rs`
- `crates/screens/src/chat/turn.rs`
- `crates/screens/src/locker/home.rs`
- `crates/screens/src/locker/item.rs`
- `crates/screens/src/locker/mod.rs`
- `crates/screens/src/locker/shared.rs`
- `crates/screens/src/locker/transfer.rs`
- `crates/screens/src/locker/trash.rs`
- `crates/screens/src/locker/types.rs`
- `crates/screens/src/locker/wall.rs`
- `crates/screens/src/pairing/laptop.rs`
- `crates/screens/src/shell/tiles.rs`
- `crates/screens/src/strings/locker.rs`
- `crates/screens/tests/locker_item.rs`
- `crates/screens/tests/locker_support/mod.rs`
- `crates/screens/tests/locker_transfer.rs`
- `crates/screens/tests/locker_wall.rs`
- `crates/screens/tests/words_filing.rs`
- `crates/vault/src/access.rs`
- `crates/vault/src/commands/locker.rs`
- `crates/vault/src/commands/mod.rs`
- `crates/vault/src/custody/locker_key.rs`
- `crates/vault/src/ontology_doc.rs`
- `crates/vault/src/page.rs`
- `crates/vault/tests/commands.rs`
- `crates/vault/tests/commitments.rs`
- `crates/vault/tests/ladder_ddl.rs`
- `crates/vault/tests/locker_commands.rs`
- `crates/vault/tests/locker_plaintext_gate.rs`
- `docs/decisions.md`
- `docs/external-review-scope.md`
- `docs/glossary.md`
- `docs/release/v1-handoffs.md`
- `docs/vault-ontology.md`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/RustRoot.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/locker/LockerTransferScreens.kt`
- `mobile/iosApp/Sources/RustScreenHost.swift`
- `mobile/maestro/flows/selectors.md`
- `scripts/docs-site/src/content/ontology-body.html`

Deleted:

- `crates/screens/src/locker/access.rs`
- `mobile/iosApp/Sources/Locker/LockerAccessView.swift`

Added:

- `receipts/issue-1146-rebuild-gaps.md`

### Lane 1B — No journal; a format that names itself

Owner rulings J, D3, D4 and the revision rule of #1146. The vault kept a `journal` row for every command it was asked to run, and the input of a typed secret or chat turn lived there as a token while everything else lived there whole; it is gone. Its three jobs now have a home each, the entity `version` that nothing compared is dropped, a file names its format, and a revision cannot be deleted by hand.

- **The vault.** `contracts/migrations/001_baseline.sql` founds no `journal` table, index or trigger. `action_key (key, asked, at) STRICT, WITHOUT ROWID` (plus `action_key_by_at`) is written in the executed command's own commit by `action_key::remember`, which also forgets the keys older than thirty days; `Vault::execute_keyed` finds a key inside the commit and answers `replayed` with nothing run, so two deliveries racing for the lock still run once. A refusal, a failed precondition and a handler error write nothing (the old "failed" row, written after the rollback, is gone). `vault.writes` and `vault.written_at` are bumped in the commit guard (`bump_writes`) when the census saw a reportable row or a `WITHOUT ROWID` table touched, with the census muted for the bump. `entity.version` is dropped and `touch` stamps `updated_at` only. `revision_is_kept` refuses a direct DELETE while the entity exists. `crates/vault/src/format.rs` holds `APPLICATION_ID` (`CEN2`), `EARLIER_APPLICATION_ID` (`CEN1`), `SCHEMA_DIGEST` and `schema_digest`; `Vault::open` and restore check them. `journal.rs` is deleted; the sealed scrub moved to `commands/sealed.rs`, and the tokeniser that fed the journal (`redact_command_input`) went with it, since nothing stores an input.
- **The backup plane.** `History` reads `writes` and `written_at` from the vault row (`receipts` renamed `writes`); the manifest is version 3 and carries `writes` and `written_at_ms` (no census count of a table, `RECEIPT_TABLE` gone); `head_is_ahead` in `crates/core/src/phone/pair.rs` compares them. Restore adds a `schema` check after the header and refuses an earlier-model file before the partial is renamed.
- **The core.** `act` and `command_keyed` use `action_key::{KeyMark, Recalled}`; `invocation_id` leaves `CommandOutcome` and `ActResponse` (field 5 reserved). The page door's refusal sweep names `action_key` where it named `journal`.
- **Docs Activity.** The `activity` query, its `journal` scope, core arm, route data (`DocsDocumentData` 9 and 10, chrome 6), strings, `DocsActivity*` messages, `app_query` 33 (both arms) and the two native views are removed, the numbers and names reserved. `docs/decisions.md` R-1135-5-11 is marked superseded.
- **Notes.** `NotesNote.row_version` (field 9) and `NoteRow.version`/`EditorNote.row_version` are removed; the proto number and name are reserved.
- **The harness.** `nativetools` tests counted the commands run through the journal. The vault keeps no such record, so `vaultio::watch` and `vaultio::commands_run` count what `Handle::run` ran for a file a test watches (nothing else is counted); the tests' `journal(world)` helper reads that.

#### Rulings

R-1146-1B-1 to R-1146-1B-7 are the root's (action keys; no invocation id; the write counter; Docs Activity gone; no version; format identity; revision is kept) and are implemented as written. All nine are in `docs/decisions.md` under "The journal is gone (#1146)", with R-FP-10, and the rows they supersede are marked.

- **R-1146-1B-8** — _Finding:_ the manifest's `census` carried the journal's row count; a census count of `vault` (one row) cannot stand in. _Choice:_ the manifest is version 3 with `writes` and `written_at_ms` as fields; a version-2 manifest is refused by its version, with no compatibility (R-FP-10). _Why:_ the figure takeover compares should be the counter itself. [#1146](https://github.com/srikanth235/centraid/issues/1146)
- **R-1146-1B-9** — _Finding:_ SQLite stores the statement text it was given, comments included, so a digest of the raw text changes when a comment is edited, and the FTS5 shadow tables are worded by the module, which differs between SQLite builds. _Choice:_ the digest reads statements without comments and with collapsed whitespace and leaves out `sqlite_*` rows (the statistics `PRAGMA optimize` writes among them) and the shadow tables; `Vault::open` checks it for a file at the head (after the climb for one that was behind) and `Vault::create` does not. _Why:_ any change to a table or index must move the constant, and nothing else may.
- **R-1146-1B-10** (receipt only) — _Finding:_ `nativetools` tests proved "this write ran once" and "a parked write reached the vault" by reading `journal`. _Choice:_ a recorder in the harness's own door, for watched files only. The alternative, the vault's write counter, says that something was written, not which command, and `verb_coverage` needs the command.
- **R-1146-1B-11** (receipt only; **superseded by R-1146-0-3**, below) — _Finding:_ `entity.retitle` refuses a chat with "a chat is renamed with `thread.rename`", and its comment gave the journal as the reason (a title is the first thing the member said). With no journal the reason is gone. _Choice:_ behaviour kept, the words that named the journal removed. _Why:_ not mine to change; recorded in the report for the owner.

#### Red-first

Tests written against aa1c47d9 and run before the fix, each failing for the reason it names:

- `crates/vault/tests/action_keys.rs`: `a_keyed_act_is_answered_replayed_after_a_restart_and_runs_once`, `a_refused_or_failed_command_writes_nothing_anywhere` and `the_write_counter_grows_by_one_per_changing_commit_and_not_for_a_no_op` failed at `no such column: writes`; `a_key_older_than_thirty_days_is_trimmed_by_the_next_keyed_commit` at `no such table: action_key`; `a_founded_vault_has_no_journal_and_holds_action_keys_instead` at `nothing in the founded file is the journal`; the entity-version assertion printed the founded column list `["n", "id", "kind", "title", "created_at", "updated_at", "version", "deleted_at", "purge_at"]`.
- `crates/vault/tests/revision_kept.rs`: the direct DELETE succeeded — `refused: CommitResult { value: (), rows: 1, tables: ["revision"] }` from `expect_err`.
- `crates/vault/tests/format_identity.rs`: `a_file_of_the_earlier_model_is_refused_with_a_sentence` and `a_file_whose_schema_is_not_this_versions_is_refused_with_a_sentence` failed at `the file was opened`.
- `crates/vault/tests/backup_snapshot.rs`: `a_restore_refuses_a_file_of_an_earlier_model_or_another_schema_and_leaves_nothing` failed because the restore succeeded (`expect_err` got `Restored { … }`).

Tests whose subject the journal was were deleted or rewritten: `commands.rs` (`a_command_executes_and_the_gate_writes_its_journal_row`, `every_command_is_journalled_in_order_and_seq_is_the_position` and `the_journal_refuses_a_rewrite_and_allows_retention` deleted or rewritten to what a refusal now leaves; `touch_stamps_once_per_commit` reads `updated_at`), `chat.rs` (`the_journal_keeps_a_token_never_what_was_said` became `a_refusal_never_quotes_what_was_said`), `locker_commands.rs` (`a_duplicates_nested_field_ciphertext_never_lands_in_the_journal` deleted; its scrub is covered by `commands::sealed::tests::a_secret_inside_an_array_element_is_scrubbed`), `locker_plaintext_gate.rs` (the journal reader reads `action_key`), `core/tests/{action_plane,replay,assist_channel}.rs` (no `invocation_id`), `core/tests/query_plans.rs` (59 queries, not 60), `crates/apps/docs` (the activity cases) and the `shared_verbs`, `money_health` and `notes` tests that read `version` (now `updated_at`, with the clock moved). In `plans.rs` the two full-scan cases that queried `entity.version` query the unindexed `note.body`, so the finder is still exercised.

#### Falsification of the two riskiest claims

1. _"The bump is not among the commit's tables."_ The `muted` check in the hook was removed. `the_write_counter_grows_by_one_per_changing_commit_and_not_for_a_no_op` failed: `the bump is not a change a screen re-reads: ["container", "entity", "vault"]`. Restored.
2. _"A purge still removes a revision with its entity."_ The trigger's `WHEN EXISTS (SELECT 1 FROM entity …)` guard was removed. `a_revision_cannot_be_deleted_but_goes_with_its_entity` failed on the purge: `runs: Sqlite(SqliteFailure(… ConstraintViolation …, Some("a revision is kept while its entity is")))`. Restored; the cascade runs after the entity row is gone, so the guard finds none.

#### Verification

- `cargo xtask gate --profile local` — **PASS** (cold: 889 s of the 3,200 s cold ceiling; fmt, clippy `-D warnings`, `cargo test --workspace` (825.8 s; `cargo-nextest` is not installed, so the whole workspace ran), restore-drill, the 15 rules, doc-links and ledgers all ok). Two earlier attempts failed for reasons that were mine: `sql-confinement` refused the SQL string literals of the new core-ffi contract test (the two ways to make a file this build refuses are now `testdoor::stamp_earlier_model` and `add_stray_table`), and clippy's `items_after_test_module` caught the same two functions placed after `mod tests` in `testdoor.rs`. A third attempt's test step died with `No such file or directory` because the container's quota was full and I deleted stale test executables while it ran; nothing in the tree was at fault.
- `cargo xtask gate --profile mobile-jvm` — **PASS** on the first run (208 s of 420 s; no Maven `429`).
- `cargo test -p centraid-vault` — 434 green (227 unit incl. `format::tests`, `action_keys` 6, `revision_kept` 1, `format_identity` 3, `commitments` 18, `backup_snapshot` 4, `restore_drill`, `ladder_ddl` 3, `ontology_page`).
- `cargo test -p centraid-core` — 448 green (269 lib; `action_plane`, `replay`, `assist_channel`, `assist_door`, `phone_backup`, `query_plans` with the wire at 59 queries).
- `cargo test -p centraid-apps-docs -p centraid-apps-notes -p centraid-api-proto -p centraid-core-ffi -p centraid-assist -p centraid` — 46, 36, 10, 56 (the refusals-at-open test among them), 188 and 9 green; `-p centraid-screens` 368 lib plus 903 across every integration binary; `-p centraid-nativetools` 733 across every integration binary (run a few binaries at a time, the disk being what it was). `cargo test -p centraid-core-ffi --test spike` needed `cargo build -p centraid-core-ffi` first (the stale-cdylib trap in `crates/core-ffi/tests/spike.rs`).
- Regenerated by their own commands and equal to a fresh render, `git diff --exit-code contracts/schema` clean: `contracts/schema/vault-ddl.sql` (`export-ladder-ddl`), `contracts/schema/vault-commands.txt` (`export-commands`; no command added or removed), the published ontology page (`export-ontology-page`), `crates/screens/src/catalog.rs` (`cargo xtask screens-catalog`) and `contracts/assist/export` (`nativetools export`: only the Docs `activity` query left `metadata.json`).
- `grep -rnw journal crates mobile contracts` (`.rs .sql .proto .kt .swift`) outside the Notes and People "journal" feature — what is left is `journal_mode`/`journal_size_limit`, SQLite's rollback journal and `-journal` sidecar, the comments in the proto `reserved` blocks, `ladder_ddl.rs`'s `nothing_the_model_deleted_is_founded` list, `action_keys.rs`' own subject, and the name of the `journal(world)` helper in the `nativetools` tests (it reads the harness recorder now).
- `grep -rn "invoke_key\|journal_by\|RECEIPT_TABLE\|invocation_id\|row_version" crates mobile contracts` — `invocation_id` and `row_version` only as `reserved` names and the prose that says they are reserved; `invoke_key` only as `ActRequest`'s own field (and the comments about it). **`row_version` also stays on `locker_item_field` and `locker_item_passkey`** (`contracts/migrations/001_baseline.sql`, with `contracts/schema/vault-ddl.sql`): it is the recursion guard of those two tables' `touch_updated_at` triggers, not a compared version; see "Not done".
- `grep -n version contracts/migrations/001_baseline.sql` — no `entity.version`.

#### Not done, and why

- **The native app views are not compiled here** (no Android SDK, no Xcode); `:core:jvmTest` does not build `mobile/androidApp` or `mobile/iosApp`. The Kotlin and Swift edits are deletions of the Docs Activity list (`DocsDocumentView.swift`, `DocsScreens.kt`) and of one assertion each in `NotesQueryRoundTripSpec.kt` and `DocsQueryRoundTripSpec.kt`. The Swift protos are generated at build time (none is tracked), so none was regenerated. Owner hand-off: build both apps and open a document in Docs.
- **`row_version` on `locker_item_field` and `locker_item_passkey`** is not removed. The ruling is about `entity.version`; these columns stop their triggers re-firing, and dropping them means giving those triggers another guard. Recommended: a follow-up that does it, or an owner ruling to keep them.
- **`entity.retitle` still refuses a chat** (R-1146-1B-11): the sentence that named the journal is gone and the refusal stays. With no journal, a chat's title could take the shared verb; the owner decides.
- **The on-device model's retrain.** `contracts/assist/export/metadata.json` lost the Docs `activity` query; the prompt and tool files did not change. Whether to refreeze the training data is the owner's.
- **Old-format manifests and files** are refused, not read (R-FP-10); there is no migration to write.
### Owner rulings — chat retitle and Locker row_version

Two rulings of 2026-10-29 in [#1146](https://github.com/srikanth235/centraid/issues/1146).

**What changed.**

- **R-1146-0-3** (supersedes R-1146-1B-11) — _Finding:_ `entity.retitle` refused a chat and a second verb, `thread.rename`, renamed it. _Choice:_ the refusal is removed and `thread.rename` is deleted; the shell action `rename-chat` runs `entity.retitle` with input `id` and `title` (was `thread_id`). _Why:_ the refusal's reason was the journal. `thread.rename` did only what a retitle can do on a chat (set the title, touch the entity) plus three things that were not chat-specific once the journal went: the sealed `title` key (it only kept a refusal's sentence from quoting the title, and no other kind's title is sealed), a cut of the title to 60 characters with whitespace run together (`title_of`, the rule for a title derived from a question, applied to a title the member typed) and the "needs words" refusal (`entity.retitle` already says "a chat needs a name"). The manifest's `sealed` for the action is now empty. `thread.clear`, `thread.save_turn` and `thread.settle_proposal` are unchanged.
- **R-1146-0-2** — `locker_item_field.row_version` and `locker_item_passkey.row_version` stay. No code change; `contracts/migrations/001_baseline.sql` now says beside both columns that it is the recursion guard of the `touch_updated_at` trigger, never compared, not an entity version (comments are outside the schema digest; `vault-ddl.sql` regenerated).

**Red line.** `a_chat_is_renamed_and_deleted_by_its_own_door_and_leaves_nothing` (`crates/vault/tests/chat.rs`), now asserting `entity.retitle` on a chat succeeds and trims, and that a blank title is refused "needs a name" → before the fix: `assertion left == right failed: entity.retitle: Some("a chat is renamed with `thread.rename`")`. The tests that called `thread.rename` (`search_finds_a_thread_by_its_title...`, `chat_tests.rs` drawer search, `assist_history.rs`) now call `entity.retitle`. `a_refusal_never_quotes_what_was_said` tested the rename's sealed title; it now exercises the same seal on `thread.settle_proposal`'s `text`. Found on the way, not changed: `thread.save_turn`'s sealed key `turn` does not cover its nested paths, so a question past 8000 characters fails the schema with `/turn/question/text: "<the question>" is longer than 8000 characters`, quoting the words in the refusal sentence.

**Files.** `crates/vault/src/commands/entity.rs` (the refusal removed), `crates/vault/src/commands/thread.rs` (the rename, its schema, precondition and module note removed), `crates/vault/tests/chat.rs`, `crates/vault/tests/commands.rs`, `crates/core/src/shell.rs`, `crates/core/src/shell/manifest.json`, `crates/core/src/app_query/chat_tests.rs`, `crates/core/tests/assist_history.rs`, `crates/screens/src/catalog.rs` (generated), `crates/screens/src/chat/drawer.rs`, `crates/api-proto/proto/centraid/core/v1/chat.proto` (a comment), `contracts/schema/vault-commands.txt`, `contracts/schema/vault-ddl.sql`, `contracts/migrations/001_baseline.sql`, `docs/decisions.md`.
- `contracts/assist/catalog-census.csv`
- `contracts/assist/export/kind_card.txt`
- `contracts/assist/export/metadata.json`
- `contracts/assist/export/prompt.compact.txt`
- `contracts/assist/export/prompt.full.txt`
- `contracts/assist/export/prompt.sig.txt`
- `contracts/ledgers/query-plans.json`
- `contracts/migrations/001_baseline.sql`
- `contracts/schema/vault-commands.txt`
- `contracts/schema/vault-ddl.sql`
- `crates/api-proto/proto/centraid/core/v1/app_query.proto`
- `crates/api-proto/proto/centraid/core/v1/imports_screens.proto`
- `crates/api-proto/proto/centraid/core/v1/money.proto`
- `crates/api-proto/proto/centraid/core/v1/money_screens.proto`
- `crates/api-proto/proto/centraid/core/v1/people.proto`
- `crates/api-proto/proto/centraid/core/v1/people_screens.proto`
- `crates/api-proto/proto/centraid/core/v1/photos.proto`
- `crates/api-proto/proto/centraid/core/v1/photos_home_screens.proto`
- `crates/api-proto/proto/centraid/core/v1/photos_lightbox_screens.proto`
- `crates/api-proto/proto/centraid/core/v1/route.proto`
- `crates/api-proto/proto/centraid/core/v1/screens.proto`
- `crates/apps/kit/src/manifest.rs`
- `crates/apps/locker/README.md`
- `crates/apps/locker/src/transfer.rs`
- `crates/apps/money/README.md`
- `crates/apps/money/manifest.json`
- `crates/apps/money/src/engine.rs`
- `crates/apps/money/src/import/csv.rs`
- `crates/apps/money/src/import/mod.rs`
- `crates/apps/money/src/import/ofx.rs`
- `crates/apps/money/src/phone.rs`
- `crates/apps/money/src/queries.rs`
- `crates/apps/money/src/rules.rs`
- `crates/apps/money/tests/import_corpus.rs`
- `crates/apps/money/tests/vault.rs`
- `crates/apps/people/README.md`
- `crates/apps/people/manifest.json`
- `crates/apps/people/src/commands.rs`
- `crates/apps/people/src/lib.rs`
- `crates/apps/people/src/manifest.rs`
- `crates/apps/people/src/person.rs`
- `crates/apps/people/src/queries.rs`
- `crates/apps/people/tests/reads.rs`
- `crates/apps/photos/README.md`
- `crates/apps/photos/manifest.json`
- `crates/apps/photos/src/lib.rs`
- `crates/apps/photos/src/manifest.rs`
- `crates/apps/photos/tests/collections.rs`
- `crates/apps/photos/tests/reads.rs`
- `crates/apps/photos/tests/year3.rs`
- `crates/core/src/app_query.rs`
- `crates/core/src/app_query/locker_tests.rs`
- `crates/core/src/app_query/money.rs`
- `crates/core/src/app_query/people.rs`
- `crates/core/src/app_query/photos.rs`
- `crates/core/src/catalog.rs`
- `crates/core/src/load.rs`
- `crates/core/tests/photos_screens.rs`
- `crates/core/tests/query_plans.rs`
- `crates/media/README.md`
- `crates/media/src/lib.rs`
- `crates/nativetools/tests/catalog.rs`
- `crates/screens/src/catalog.rs`
- `crates/screens/src/imports/camera_roll.rs`
- `crates/screens/src/money/rules.rs`
- `crates/screens/src/people/person/data.rs`
- `crates/screens/src/people/person/mod.rs`
- `crates/screens/src/photos/home/collections.rs`
- `crates/screens/src/photos/lightbox.rs`
- `crates/screens/src/photos/mod.rs`
- `crates/screens/src/strings/money.rs`
- `crates/screens/src/strings/people.rs`
- `crates/screens/src/strings/photos.rs`
- `crates/screens/src/strings/photos_home.rs`
- `crates/screens/src/strings/photos_lightbox.rs`
- `crates/screens/tests/imports_camera_roll.rs`
- `crates/screens/tests/people_person.rs`
- `crates/screens/tests/photos_common.rs`
- `crates/screens/tests/photos_home.rs`
- `crates/vault/src/commands/follow.rs`
- `crates/vault/src/commands/mod.rs`
- `crates/vault/src/commands/money.rs`
- `crates/vault/src/commands/rule.rs`
- `crates/vault/tests/commitments.rs`
- `crates/vault/tests/money_health.rs`
- `docs/photos/README.md`
- `docs/photos/derived-ledger.md`
- `docs/vault-ontology.md`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/RustRoot.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/money/MoneyPages.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/people/PeoplePersonScreen.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/session/LibraryRoll.kt`
- `mobile/iosApp/Sources/Money/MoneyManageViews.swift`
- `mobile/iosApp/Sources/People/PeoplePersonView.swift`
- `mobile/iosApp/Sources/PhoneLibrary.swift`
- `mobile/iosApp/Sources/PhotosCollectionsView.swift`
- `mobile/iosApp/Sources/RustScreenHost.swift`
- `scripts/docs-site/src/content/ontology-body.html`

Deleted:

- `crates/apps/photos/src/duplicates.rs`
- `crates/media/src/duplicates.rs`
- `crates/screens/src/photos/duplicate_review.rs`
- `crates/screens/src/photos/duplicates.rs`
- `crates/screens/tests/photos_duplicates.rs`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/photos/PhotosDuplicatesScreens.kt`
- `mobile/iosApp/Sources/PhotosDuplicatesViews.swift`

Added:

- `crates/apps/people/tests/touches_relations_birthday.rs`
- `crates/vault/src/commands/person_reminder.rs`
- `crates/vault/tests/money_opening_rename.rs`

Added: `receipts/issue-1146-rebuild-gaps.md` (this section).

#### Owner hand-offs

- Build the Android and iOS apps and open: Money → Rules (add and edit a rule with "Show as"), Money → import a statement against such a rule; Photos → Collections (no Duplicates door) and the camera-roll import of a geotagged photo and a video (pixel box, length and a place on the photograph); Locker → import a LastPass and a Bitwarden export holding a secure note; People → a person with a relationship (both people's sheets) and a birthday (the bell toggles it).
- Native files changed: `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/money/MoneyPages.kt`, `.../screens/RustRoot.kt`, `.../session/LibraryRoll.kt`, `.../screens/people/PeoplePersonScreen.kt`; deleted `.../screens/photos/PhotosDuplicatesScreens.kt`; `mobile/iosApp/Sources/Money/MoneyManageViews.swift`, `.../PhoneLibrary.swift`, `.../PhotosCollectionsView.swift`, `.../RustScreenHost.swift`, `.../People/PeoplePersonView.swift`; deleted `.../PhotosDuplicatesViews.swift`.
- The on-device model's retrain (the export changed, above).

#### Changelog line

Money remembers the day an opening balance is as of, so a statement from before it no longer counts twice, and a rule can give a payee a name of your own; the Photos Duplicates screen is gone, and photos you import now keep their size, length and place; a secure note exported from LastPass or Bitwarden imports as a Locker note with its body sealed; a person's sheet shows their relationships from both sides, a touch in the trash no longer counts as the last time you were in touch, and a birthday reminder can be turned off.

#### Decision rows

| **R-1146-6-1** | An account's opening balance is as of a day (`account.opening_on`, required with a non-zero amount); a balance counts the lines after that day, and an account with no day counts every line. _Why:_ a statement imported from before the opening day was counted twice. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-6-2** | A rule may carry a display name (`rule.display_name`); `rule.apply` and a newly followed statement line take it, a line the member named keeps its name unless `overwrite`, and the bank's words in `source.stated` are never written. _Why:_ the payee is the member's name for the line; the bank's words are evidence. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-6-3** | Photos has no Duplicates screen, query or clustering; the wire numbers are reserved. Supersedes R-1135-5-15 and the `duplicates` query of R-1135-5-12. _Why:_ owner ruling D5. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-6-4** | The camera roll writes the library's pixel box, a movie's length and a coordinate pair (as a place) when the asset has them, and nothing when it does not; an edit inherits its place from its original. _Why:_ `photo.add` already took them (M20). [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-6-5** | A CSV row whose address is `http://sn` (LastPass) or whose type is `note` (Bitwarden) imports as a Locker `note` with the body sealed as `content` and nothing in plain `notes`. _Why:_ owner ruling D2c. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-6-6** | A person's sheet shows the `related` edges that start and end at them, live relatives only, each read from its own side. _Why:_ owner ruling D8; the vault stores one label per edge and no inverse. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-6-7** | A touch in the trash does not count toward the log, last contacted or the cadence, in the one read every figure shares. _Why:_ M21. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-6-8** | The birthday reminder is a per-person switch (`person.birthday_reminder`, `person.set_birthday_reminder`), on by default. _Why:_ the birthday is the person's column and has no event to carry a reminder. [#1146](https://github.com/srikanth235/centraid/issues/1146) |

### Wave 5 — Search

Four search gaps, each red-first in `crates/search/tests/door.rs` (and `matching.rs`).

**What changed.** (1) An untitled photo is indexed (its text holds `Photo · 12 Mar 2026` and the full month name, from `taken_at`) and the door answers it under that label in `query` and `query_each`; the door's filter is `(e.title <> '' OR e.kind = 'photo')`. (2) `query` walks STAGES: stage 0 is the title matches, stage k the k-th slab of `TAIL_ROWS` other matches (`LIMIT 500 OFFSET 500·(k-1)`); a later stage is read only when the one before did not fill the window; the cursor's tier is the stage, so `tier:rank` is unchanged. `query_each` still reads slab 1. (3) `text_of` joins every label's title with `deleted_at IS NULL` (lists, albums, tags, notebooks, folders, projects, sections, calendars, categories, accounts, places, relations); a trash or restore touches the label and `reindex` already re-indexes its members through `DEPENDENTS`, in the same commit. (4) `text_of` appends the digit-only forms of each phone (person contact points, Locker `phone`); a query written as a number (≥ 2 digit groups, ≥ 5 digits, only digits and ` -().+`) also asks for its joined digits.

**Findings → test → red line.**

- Untitled photos → `an_untitled_photo_is_found_by_its_date_and_answered_under_a_date_label` → `assertion left == right failed  left: []  right: ["p1"]` (door.rs:910).
- Past the newest 500 → `a_match_older_than_the_newest_five_hundred_is_reached_by_paging` → `left: 500  right: 520` ("every match"); the old `the_tail_is_the_newest_five_hundred_and_a_title_match_is_never_cut` asserted the cap itself and is replaced by `the_tail_pages_newest_first_in_slabs_of_five_hundred_after_the_title_matches` (`left: 501  right: 521`) — its subject was decided away by the issue.
- Trashed label → `a_trashed_label_stops_finding_its_members_and_a_restored_one_finds_them_again` → `assertion failed: world.ask(&["photo"], "zebrafish").is_empty()` (seen by reverting the album join's liveness predicate; see falsification).
- Phone digits → `a_phone_number_is_found_without_its_punctuation` → `assertion left == right failed: 5551234  left: []  right: ["p1"]`; `matching::tests::a_number_typed_with_its_punctuation_is_also_its_digits` covers the compiled expression.

**Rulings.**

- **R-1146-5-1** Untitled photos: index them and label them by date rather than dropping the filter for everything. The label is built in the door (`centraid_vault::index::untitled_label`), so every reader of a `Target` (Home's search included) gets a readable row; the Photos app reads ids from its own legs and is unchanged. Other kinds with an empty title stay non-targets.
- **R-1146-5-2** Paging: slabs by `OFFSET`, cursor tier = stage, not a rowid keyset. Rank order within a slab is kept (the first page is exactly what it was); an old slab costs the matches it skips, paid only by a page that reaches it.
- **R-1146-5-3** Trashed labels: liveness join in `text_of` plus the re-index the trash/restore already causes (the label is touched, `DEPENDENTS` brings its members), not a new member-touching step. Cost is that of renaming the label, already accepted; a label with very many members pays it in the trash command's commit.
- **R-1146-5-4** Phones: digits-only form, plus the national part after a `+` country code of 1–3 digits (the index matches word starts, so `5551234` must start a word of its own). Numbers under 5 digits get no form. Digit queries are OR-ed only when they have ≥ 2 groups and ≥ 5 digits, so dates and small numbers are not read as phones. Locker keeps its search as is (its `phone` gets the same forms; nothing else added). A snippet for such a hit may show the digit line.

**Falsification.** (a) Reverted the `h.deleted_at IS NULL` predicate on the list/album join: the trashed-label test failed with the line above; restored. (b) The paging claim: the old test (cap of 500) fails on the new walk and the new one fails on the old code (`left: 500 right: 520`), the two sides of the same break.

**Exit list.** Red-first tests: failing on the base (quoted above), passing now. `cargo test -p centraid-search -p centraid-vault -p centraid-core` green. No schema change: `contracts/schema` untouched. `cargo xtask gate --profile pr`: fmt, clippy, test, restore-drill, rules, doc-links, ledgers, release-build, ts-static, emitters, advisory, lockfile, call-budget, search-budget, fault-door ok; buf, deny, ci-policy, secrets, osv SKIP (tools absent); the run took 1689.5 s against its 1500 s budget on this cold tree, every step green — a time overrun of the environment, not a step failure. `search-budget`: worst p95 50.5 ms (notes, in-word fragment) and 49.8 ms (home), ceiling 80 ms, ledger untouched; no base measurement taken (the base was not rebuilt in release), so no before/after delta is claimed. `mobile-jvm` not run: no `mobile/` change. The pre-push hook passed after `git fetch origin main` (its `origin/main` ref was missing).

**Changed files.** `crates/search/src/sqlite.rs`, `crates/search/src/matching.rs`, `crates/search/tests/door.rs`, `crates/search/README.md`, `crates/vault/src/index.rs`, `crates/vault/src/index/text.rs`, `docs/vault-ontology.md`, `receipts/issue-1146-rebuild-gaps.md`. Deleted: none. Owner hand-offs: none.

#### Changelog line

Search now finds photos that have no title (shown by the day they were taken), reaches older matches by scrolling past the first 500, stops finding things through a label you moved to the trash, and finds phone numbers typed without punctuation.

#### Decision rows

| **R-1146-5-1** | An untitled photo is indexed with a date label (`Photo · 12 Mar 2026`, from `taken_at`) that the door also answers it under; other kinds with no title stay non-targets. _Why:_ the row needs words to show, and the label is built once in the door so every reader gets it. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-5-2** | The search tail pages in slabs of 500 (`OFFSET`), the cursor's tier being the slab; the first page reads slab 1 only. _Why:_ a match older than the newest 500 was unreachable, and the first-page cost is the budget's. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-5-3** | A trashed label lends no words to its members; trash and restore re-index the members in their own commit. _Why:_ the label is already touched and `DEPENDENTS` already re-indexes members, so a liveness join costs nothing more than a rename. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-5-4** | A phone number is also indexed as its digits (and the national part after a `+` country code), and a number-shaped query also asks for its joined digits. _Why:_ the index matches word starts, so punctuation hid the number; Locker search is otherwise unchanged. [#1146](https://github.com/srikanth235/centraid/issues/1146) |

### Wave 6 — Apps

Owner rulings D9 (Money), D5 (Photos), D2c (Locker import) and D8 (People), and the findings M20 and M21, of [#1146](https://github.com/srikanth235/centraid/issues/1146). Worked on `claude/zen-darwin-fuharm-w6` from `aa1c47d9`, in parallel with lane 1B; none of the journal, `entity.version`, `application_id`, Docs Activity or revision code was touched.

#### What changed

- **Money — the opening balance has a day (D9).** `account` gains `opening_on` (`TEXT`, a real date or null). `account.add` takes `opening_on`; `account.set_opening` takes `opening_minor` and `opening_on`; a non-zero opening with no day is refused ("An opening balance needs the day it was true."), and so is a day that is not real. `centraid_apps_money::engine::balance_on` counts the posted lines **after** `opening_on` and on or before the asked day, so a statement imported from before the opening day does not count twice; an account with no day counts every line, as it did. `AccountRow.opening_on` is read, and the `opening_on` field is declared on the manifest's `account` kind and on the `add-account` and `set-opening-balance` inputs.
- **Money — a rule names a payee (D9).** `rule` gains `display_name` (null, or a non-blank name of at most 80 characters); `rule.add` and `rule.edit` take it (null clears it). `rule.apply` retitles a line the deciding rule names when the line's title is still the bank's words, or with `overwrite`; it reports `renamed`. A line `follow.statement` ADDS takes the name too (a new `named` hook on the follow engine's `SystemMap`, run once after an add and by no other system than `statement`), so a re-import never undoes a name the member chose later. The bank's words stay in `source.stated`, which the match reads and nothing here writes. The app's `rules::apply` returns the name, the import plan's rows carry it (`ImportRow.display_name`, the preview), and the rule editor gains a "Show as" row (`MoneyRuleEditor.rename_text`/`rename_label`, `MoneyRulesEvent.rename`, `MoneyRules.RuleLine.rename_to = 10`); the rule list says "shown as <name>". Field 8 of `RuleLine` and field 5 of `RuleOffer` stay reserved with the old name.
- **Photos — Duplicates retired (D5).** The `photos.duplicates` app query (91), the `photos.duplicates` and `photos.duplicate_review` screens (arms 806, 807 of `ScreenEvent`, `ViewState` and `Route`), `PhotosCollectionCard.Kind.KIND_DUPLICATES` (4) and the overview's `duplicate_clusters` (10) are removed, their numbers and names `reserved`. `crates/apps/photos/src/duplicates.rs`, `crates/media/src/duplicates.rs`, `crates/screens/src/photos/{duplicates,duplicate_review}.rs`, the Compose and SwiftUI views, the home's Duplicates door, 22 strings, the query-plan ledger row for the phash walk and the docs that described them go. `phash` stays an accepted input of `photo.add` and a derivative the vault keeps, with no reader (a finding below).
- **Photos — the library's facts ride with the photograph (D5, M20).** `RollAsset` carries `width`, `height`, `duration_s` and an optional `latitude`/`longitude` pair (fields 8–12). `add_request` writes them as the `upload` action's `width`, `height`, `duration_s`, `lat`, `lon` only when present (zero is unknown, never a size; one half of a pair is no location); an edit's render carries its own pixel box and inherits its place from the original it names. Android reads `WIDTH`, `HEIGHT`, `duration` from `MediaStore` and the EXIF coordinates (the original, with `ACCESS_MEDIA_LOCATION`, as the roll already asks); iOS reads `pixelWidth`, `pixelHeight`, `duration` and `location` from the `PHAsset`.
- **Locker — secure notes import as notes (D2c).** The CSV reader (`apps/locker/src/transfer.rs`) takes a LastPass row whose address is `http://sn` (case-insensitive) and a Bitwarden row whose `type` is `note`, `securenote` or `secure note` as a `note` item: the body is its `content` (the core seals it with the other secrets, `crates/core/src/locker/transfer.rs` unchanged), the title is the row's name, and the marker address, `username`, `password` and plain `notes` are not carried. Every other row stays a login. R-1146-6-0 holds: search and the assistant's reach are untouched.
- **People — relationships on both sheets (D8).** The person sheet reads the `related` edges that start at the person and those that end at them (`PeopleSheet.relations = 10`, `PeopleRelation`), live relatives only. The edge's label names what its target is to its source, so Ada's sheet says Beth is her "Mum" and Beth's says "Beth is their Mum" on Ada's row. `PeoplePersonData.relations_head`/`relations` (22, 23) draw a read-only "Related" section, only when there are some.
- **People — a trashed touch stops counting (M21).** `touch_stubs` keeps only activities whose entity is live, so the log, last contacted, the cadence's due figure and the dashboard's rails ignore a touch in the trash, and a restored one counts again.
- **People — the birthday reminder can be turned off.** `person.birthday_reminder` (`INTEGER NOT NULL DEFAULT 1`), the command `person.set_birthday_reminder` (`id`, `on`; refused for a person with no birthday), and the action `set-birthday-reminder`. The birthday date row reads `reminder_on` from the column, so the roster's reminders, the dashboard's Upcoming and the sheet respect it, and the sheet's bell now toggles a birthday (`toggleable: true`).

#### Rulings

- **R-1146-6-1** — _Finding:_ #1135 dropped the opening balance's day, so every imported line counted and an opening balance entered after the first statement double counted. _Choice:_ `account.opening_on`, optional, required with a non-zero opening; the balance counts lines strictly after it; no day counts every line; the cash-flow and spending folds measure lines, not balances, and are unchanged. _Why:_ D9; the pre-#1135 rule, restored as it was.
- **R-1146-6-2** — _Finding:_ a rule can only file a line; the payee stays the bank's words. _Choice:_ a nullable `rule.display_name` column (not a key of the pattern JSON, which says what MATCHES); category stays required; the last matching rule that has a name wins, as for the category; `rule.apply` renames only a bank-titled line unless `overwrite`; an added statement line takes the name once. _Why:_ D9, and "never the bank's original words": the title is the member's name, `source.stated` is the bank's. A rename-only rule (no category) was not asked for and would make the category optional everywhere it is read.
- **R-1146-6-3** — _Finding:_ Duplicates was ruled out of v0. _Choice:_ the whole path goes, wire numbers reserved; `centraid_media::duplicates` goes with its only reader; the `phash` module and the `phash` input/derivative stay (no reader — see findings outside the wave); the shared fixtures' `near_duplicate_families` stay (they shape year-3 volumes that other receipts state). The query-plan ledger lost its row (`pages.allowed` 10 to 9, down only). _Why:_ D5; the owner's call on the phash derivative and the fixture volumes is not mine to widen.
- **R-1146-6-4** — _Finding:_ the camera roll left `photo.width`, `height`, `duration_s` and `place` empty (M20). _Choice:_ the library's values ride in `RollAsset` and are written only when present; a pair or nothing for coordinates; an edit inherits its place; duration is a movie's. _Why:_ D5; `photo.add` already accepted all five, so the fix is in the walk and the shells, not the vault.
- **R-1146-6-5** — _Finding:_ every CSV row was a login and a note's body landed in plain `notes`. _Choice:_ the two dialects' markers (above); a secure note carries only `content`; the plan keys a note by type and title like any non-login. _Why:_ D2c.
- **R-1146-6-6** — _Finding:_ nothing on the person sheet read the `related` edges. _Choice:_ read both directions, each from its own side, live relatives only, read-only; the incoming wording is a sentence ("<person> is their <label>"), because the vault stores one label per edge and holds no inverse ("Mum" has no stored "child"). _Why:_ D8.
- **R-1146-6-7** — _Finding:_ a trashed activity still set last contacted (M21). _Choice:_ filter in the one read every figure shares (`touch_stubs`), not in each caller. _Why:_ one verdict on what is live.
- **R-1146-6-8** — _Finding:_ the birthday reminder was hard-wired on. _Choice:_ a per-person switch, not a global one, as a column of `person` with its own command in a new module (`commands/person_reminder.rs`), because the birthday is the person's column and has no event to carry `reminders`, and wave 2 owns `commands/person.rs`. _Why:_ a member wants the reminders of the people they choose; a global switch is the notification settings' job.

#### Red-first

Every test below was written first and run against the base behaviour. Where the test file could not compile on the base because the API it names did not exist, the red line is the compile error or a throwaway break of the fix, and it says so.

- `an_opening_balance_is_as_of_a_day_set_at_create_and_at_edit` (`crates/vault/tests/money_opening_rename.rs`): `account.add: Some(": Additional properties are not allowed ('opening_on' was unexpected)")`.
- `a_rule_renames_the_line_and_never_the_banks_words` and `a_line_imported_after_the_rule_takes_the_payee_and_a_reimport_keeps_a_later_name` (same file): `rule.add: Some(": Additional properties are not allowed ('display_name' was unexpected)")`.
- `a_balance_counts_the_lines_after_the_opening_day_and_no_line_twice` (`crates/apps/money/tests/vault.rs`) and `a_rule_that_names_a_payee_reads_back_and_applies_in_the_app_as_in_the_vault`, and `rules_set_the_category_on_the_plan_rows_...` (`import_corpus.rs`): these name `AccountRow.opening_on` and `Rule.display_name`, which did not exist (compile errors on the base); red by throwaway break is in the falsification section.
- `a_csv_secure_note_imports_as_a_note_with_its_body_sealed` (`crates/core/src/app_query/locker_tests.rs`): `assertion left == right failed: Safe code is a note / left: "login" / right: "note"`; and the pure fold, `a_secure_note_row_reads_as_a_note_whose_body_is_its_content` (`crates/apps/locker/src/transfer.rs`).
- `the_librarys_pixel_box_duration_and_location_ride_with_the_write_when_it_has_them`: `no entry found for key` (the write carried no `width`); `a_walked_photograph_lands_with_its_pixel_box_and_its_place` (`crates/screens/tests/imports_camera_roll.rs`): `left: (None, None) / right: (Some(4032), Some(3024))`.
- Duplicates retired: `it_declares_five_queries_and_twenty_one_actions` (`crates/apps/photos/src/manifest.rs`, with `duplicates` added to the retired list) fails against the base `manifest.json` (six queries); `the_sweep_asks_every_query_the_wire_has` in `crates/core/tests/query_plans.rs` moved from 60 to 59; the ledger refused its own stale row ("the ledger allows what no longer plans badly; remove it (and lower its count): page `photos.duplicates.phashes`") until it was removed.
- `a_trashed_touch_stops_counting_toward_last_touch_the_log_and_the_dashboard` (`crates/apps/people/tests/touches_relations_birthday.rs`): the file does not compile on the base (`RelationDirection`), so the red is the fix's filter disabled: `the trashed touch no longer sets the last touch / left: Some("2026-01-04T00:00:00.000Z") / right: Some("2026-01-01T00:00:00.000Z")`. The relationship and birthday tests in the same file are red on the base as unresolved imports and an unknown command (`person.set_birthday_reminder`); the screens' `a_relationship_is_on_both_sheets_each_read_from_its_own_side` and `a_birthday_reminder_is_turned_off_from_the_sheet_and_the_date_stays` (`crates/screens/tests/people_person.rs`) ride the same fixes.

#### Falsification of the two riskiest claims

1. _"A rule renames only what is still the bank's words, so a member's own name survives `rule.apply`."_ The guard `(overwrite || title == words)` in `rule.rs` was replaced by `(overwrite || true)`. `a_rule_renames_the_line_and_never_the_banks_words` failed: `only the line the bank named / left: Number(2) / right: 1`. Reverted.
2. _"A line on or before the opening day is not counted twice."_ The `opening_on` filter in `engine::balance_on` was replaced by `true`. `a_balance_counts_the_lines_after_the_opening_day_and_no_line_twice` failed: `left: 99750 / right: 104750`. Reverted.

The trashed-touch filter was falsified the same way (above).

#### Verification

- `cargo test --workspace` inside `cargo xtask gate --profile pr` — **ok** (708 s), after the last commit: every crate this wave touched (`centraid-vault`, `-apps-money`, `-apps-people`, `-apps-photos`, `-apps-locker`, `-apps-kit`, `-screens`, `-core`, `-media`, `-nativetools`, `-assist`, `-api-proto`) and `centraid-core` run green in it. Crate-scoped runs while iterating: `cargo test -p centraid-vault --test money_opening_rename` (3), `-p centraid-apps-money` (every binary green), `-p centraid-apps-people` (24 lib + 3 new), `-p centraid-core --lib a_csv_secure_note`, `-p centraid-screens --test imports_camera_roll` (33), `--test people_person`, `-p centraid-core --test query_plans` (2).
- Regenerated by their own commands and equal to a fresh render (`git diff --exit-code contracts/schema` clean; `git status` clean after): `contracts/schema/vault-ddl.sql` (`export-ladder-ddl`), `contracts/schema/vault-commands.txt` (`export-commands`), the published ontology page (`export-ontology-page`), `crates/screens/src/catalog.rs` (`cargo xtask screens-catalog`) and `contracts/assist/export` (`nativetools export`).
- `cargo xtask gate --profile pr` — **PASS**: fmt, clippy `-D warnings`, test, restore-drill, rules (15 applied), doc-links, ledgers, lockfile, call-budget, advisory and the release build. **SKIP, not pass:** `buf` (so the proto lint and the COMPATIBILITY PROMISE of `centraid.core.v1` were NOT checked — this wave removes fields and messages, all `reserved` by hand; CI runs it), `deny`, `ci-policy` (actionlint), `secrets` (gitleaks) and `osv`.
- `cargo xtask gate --profile mobile-jvm` — **PASS** on the twelfth run. The eleven before it stopped at Gradle resolving its locked dependencies (`Received status code 429 from server: Too Many Requests` from Maven Central, and the "Did not resolve ... part of the dependency lock state" that follows it), each getting further as the cache filled; none reached a Kotlin file of this wave's.
- The container's quota filled once mid-gate (test executables, 9 GB); they were deleted and rebuilt. Not a code failure.

#### Not done, and why

- **Native views are not compiled here** (no Android SDK, no Xcode). Kotlin/Swift edits: see the owner hand-offs.
- **Adding a relationship from the sheet.** D8 asked to show them; `add-relationship` stays the action it was (reachable from chat).
- **The `phash` plumbing** (`media::phash`, the `phash` input on `photo.add`, the derivative variant, the kit fixtures' fingerprints) has no reader now; removing it touches the vault's derivative contract and volume ledgers other receipts state, so it is left for the owner (below).
- **The model-facing export** changed (`contracts/assist/export/*`: the `account` and `rule` fields and the new `set-birthday-reminder` row); whether to refreeze the on-device model's training data is the owner's.

#### Findings outside this wave

- `phash` has no reader: `centraid_media::phash`, `photo.add`'s `phash`/`thumbhash` input, the `phash` derivative variant and `centraid_apps_kit::fixtures` (`near_duplicate_families`, `photo_fingerprints`, `Year3PhotosCounts.phashes`) only feed what was retired. Per "a citation is not a justification", an owner question: remove them (recommended), or keep the hash for a future similarity feature.
- `docs/decisions.md` R-1135-5-15 (`photos.duplicates` clusters with `centraid_media::duplicates`) and R-1135-5-12 (Photos declares `library`, `search` and `duplicates`) are superseded by R-1146-6-3; the close pass should mark them.
- The `Kind.DUPLICATES` home tile iconography key `dupe` remains in the design catalogs (`mobile/*/Design/Catalog.*`); it is a design-table entry, not wave 6's.

#### Files

Changed:

- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `SECURITY.md`
- `contracts/assist/export/metadata.json`
- `contracts/migrations/001_baseline.sql`
- `contracts/schema/vault-ddl.sql`
- `crates/api-proto/proto/centraid/core/v1/action.proto`
- `crates/api-proto/proto/centraid/core/v1/app_query.proto`
- `crates/api-proto/proto/centraid/core/v1/docs.proto`
- `crates/api-proto/proto/centraid/core/v1/docs_screens.proto`
- `crates/api-proto/proto/centraid/core/v1/notes.proto`
- `crates/api-proto/proto/centraid/core/v1/phone.proto`
- `crates/api-proto/proto/centraid/core/v1/vault.proto`
- `crates/api-proto/tests/roundtrip.rs`
- `crates/apps/docs/README.md`
- `crates/apps/docs/manifest.json`
- `crates/apps/docs/src/lib.rs`
- `crates/apps/docs/src/manifest.rs`
- `crates/apps/docs/src/queries.rs`
- `crates/apps/docs/tests/phone.rs`
- `crates/apps/docs/tests/reads.rs`
- `crates/apps/notes/README.md`
- `crates/apps/notes/src/editor.rs`
- `crates/apps/notes/src/lib.rs`
- `crates/apps/notes/src/queries.rs`
- `crates/assist/src/native/act.rs`
- `crates/assist/src/native/door.rs`
- `crates/assist/src/native/member.rs`
- `crates/assist/src/native/world.rs`
- `crates/centraid/src/bin/seed-demo-vault.rs`
- `crates/core-ffi/CONTRACT.md`
- `crates/core-ffi/tests/contract.rs`
- `crates/core/src/act.rs`
- `crates/core/src/act/inverse.rs`
- `crates/core/src/api.rs`
- `crates/core/src/app_query.rs`
- `crates/core/src/app_query/docs.rs`
- `crates/core/src/app_query/docs_tests.rs`
- `crates/core/src/app_query/notes.rs`
- `crates/core/src/assist/door.rs`
- `crates/core/src/example.rs`
- `crates/core/src/load.rs`
- `crates/core/src/phone/pair.rs`
- `crates/core/tests/action_plane.rs`
- `crates/core/tests/assist_channel.rs`
- `crates/core/tests/assist_door.rs`
- `crates/core/tests/query_plans.rs`
- `crates/core/tests/replay.rs`
- `crates/nativetools/src/vaultio.rs`
- `crates/nativetools/tests/common/mod.rs`
- `crates/nativetools/tests/park.rs`
- `crates/nativetools/tests/park_confirm.rs`
- `crates/nativetools/tests/verb_coverage.rs`
- `crates/screens/src/catalog.rs`
- `crates/screens/src/docs/document.rs`
- `crates/screens/src/docs/fold.rs`
- `crates/screens/src/docs/mod.rs`
- `crates/screens/src/kit/act.rs`
- `crates/screens/src/strings/docs.rs`
- `crates/screens/tests/docs_document.rs`
- `crates/vault/README.md`
- `crates/vault/src/access.rs`
- `crates/vault/src/backup/drill.rs`
- `crates/vault/src/backup/restore.rs`
- `crates/vault/src/backup/snapshot.rs`
- `crates/vault/src/commands/blob.rs`
- `crates/vault/src/commands/entity.rs`
- `crates/vault/src/commands/locker.rs`
- `crates/vault/src/commands/mod.rs`
- `crates/vault/src/commands/thread.rs`
- `crates/vault/src/custody/README.md`
- `crates/vault/src/error.rs`
- `crates/vault/src/file.rs`
- `crates/vault/src/lib.rs`
- `crates/vault/src/log/guard.rs`
- `crates/vault/src/migrations.rs`
- `crates/vault/src/ontology_doc.rs`
- `crates/vault/src/plans.rs`
- `crates/vault/src/testdoor.rs`
- `crates/vault/tests/backup_snapshot.rs`
- `crates/vault/tests/change_census.rs`
- `crates/vault/tests/chat.rs`
- `crates/vault/tests/commands.rs`
- `crates/vault/tests/commitments.rs`
- `crates/vault/tests/ladder_ddl.rs`
- `crates/vault/tests/locker_commands.rs`
- `crates/vault/tests/locker_plaintext_gate.rs`
- `crates/vault/tests/money_health.rs`
- `crates/vault/tests/notes.rs`
- `crates/vault/tests/restore_drill.rs`
- `crates/vault/tests/shared_verbs.rs`
- `docs/decisions.md`
- `docs/glossary.md`
- `docs/protocol.md`
- `docs/vault-ontology.md`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/docs/DocsScreens.kt`
- `mobile/core/src/jvmTest/kotlin/dev/centraid/core/DocsQueryRoundTripSpec.kt`
- `mobile/core/src/jvmTest/kotlin/dev/centraid/core/NotesQueryRoundTripSpec.kt`
- `mobile/iosApp/Sources/Docs/DocsDocumentView.swift`
- `scripts/docs-site/src/content/ontology-body.html`
- `receipts/issue-1146-rebuild-gaps.md`

Deleted:

- `crates/vault/src/journal.rs`

Added:

- `crates/vault/src/action_key.rs`
- `crates/vault/src/commands/sealed.rs`
- `crates/vault/src/format.rs`
- `crates/vault/tests/action_keys.rs`
- `crates/vault/tests/format_identity.rs`
- `crates/vault/tests/revision_kept.rs`

### Wave 2 — Phone follow

One follow engine (`crates/vault/src/commands/follow.rs`) now carries the guards the rebuild left to screens or to nobody: the owner is never a phone's record, a read that lost most of an origin's rows is doubted for every system alike, a returned record restores the row its absence trashed, a second phone re-finds a first phone's tombstones and a gone tombstone is forgotten, a followed file claims its bytes in `follow.files`, a series that moves re-keys or drops the days it would strand, a statement is an account's (one origin per account, no phone named, never stopped, the bank's words kept), and `person.merge` sweeps every foreign key into an entity, carries the phone link and is confirmed.

#### Rulings

- **R-1146-2-0 (root).** The owner check is one function, `entity::is_self`; match, link, trash and absence all ask it.
- **R-1146-2-1.** The vanish guard lives in `settle_absent`: a complete read that no longer holds at least 5 of an origin's followed live rows (same phone, inside the read's window) and more than half of them trashes and forgets nothing and reports `doubted: n`. Applies to `Gone::Trash` systems (contacts, calendar, files). _Why:_ one mechanism, not a copy per screen; the files screen's copy is deleted. The member is **not asked** (R-1127-9 keeps Keep as the default and there is no ask surface); the count is in the answer.
- **R-1146-2-2.** `source.gone_at` (schema column) records the trash a follower made; only a row whose `deleted_at = gone_at` and which the member has not edited is restored on the record's return. _Why:_ a member's trash must stand, and nothing else tells the two apart.
- **R-1146-2-3.** A second phone's record is matched to another phone's *tombstone* by the same match key (stated words), never revived; tombstones of the same phone are not matched (a genuinely new contact with a purged one's name is added). A tombstone absent from a complete read is deleted, unless the read is doubted.
- **R-1146-2-4.** Overrides of a moved series are re-keyed to the single day the series has on the same date, else dropped (`event::rekey_stranded`, run from the follower's `settle`).
- **R-1146-2-5.** Statement origin: found by `(system, fills)`; `origin_one_statement_per_account` unique index; CHECKs forbid `device_id` on statement origins and sources; `follow.stop` refuses statements; fixed fields keep their first stated value in `source.stated`.
- **R-1146-2-6.** `follow.files` records carry `size`; the command claims the blob (`blob::stage`) and refuses "say how large" when the bytes are neither held nor sized. The shell action `claim-bytes` is deleted (its subject is gone).
- **R-1146-2-7.** `person.merge` is `Risk::Medium` + `confirm`, like a purge; the reference sweep covers every FK whose target is `person` or `entity` and whose target column is `id`, except `edge` (rewritten) and kind rows' own `id` link.

#### Red-first (all on the wave-1 base, in `crates/vault/tests/follow_gaps.rs`)

| Finding | Test | Red line seen |
| --- | --- | --- |
| H2 owner matched | `a_contact_named_like_the_owner_is_added_beside_the_owner_never_matched_to_it` | `left: (Some(1), Some(0)) right: (Some(0), Some(1))` |
| H2 owner trashed | `a_source_the_owner_somehow_holds_is_forgotten_and_the_owner_is_not_trashed` | `the owner went to the trash: {... "trashed":1}` |
| H3/M9 one guard | `a_read_that_lost_most_of_what_the_vault_follows_trashes_nothing_for_every_system` | `contacts: {... "trashed":5} left: (Some(5), None) right: (Some(0), Some(5))` |
| restore on return | `a_record_that_returns_restores_the_row_its_absence_trashed_and_adds_nothing` | `Ann is still in the trash` |
| second phone, tombstones | `another_phone_re_finds_a_purged_row_s_tombstone_and_never_revives_it` | `Ada was added again: {"added":1,...} left: 1 right: 0` |
| forget tombstone | `a_tombstone_whose_record_is_gone_from_a_complete_read_is_forgotten` | `the tombstone table only grows left: 1 right: 0` |
| merge confirm | `a_merge_is_confirmed_like_every_destructive_command` | `person.merge purges a person and is not confirmed` |
| merge phone link | `a_merge_carries_the_phone_link_to_the_survivor` | `the phone still follows the survivor left: 0 right: 1` |
| merge FK sweep | `a_merge_re_points_every_foreign_key_into_an_entity_not_a_hand_list` | (person-only filter restored as a throwaway) `the attachment names the survivor, not nothing left: None` |
| claim in command | `a_followed_file_claims_its_bytes_in_the_command_that_names_them` | `follow.files: FOREIGN KEY constraint failed` |
| M15 re-key | `a_series_that_moves_in_the_day_takes_its_overrides_with_it` | `left: [("2026-03-09T09:00:00", 1)] right: [("2026-03-09T10:00:00", 1)]` |
| M15 drop | `a_series_that_no_longer_lands_on_an_override_s_day_drops_it` | `a day nothing will read is not kept left: [("2026-03-09T09:00:00", 1)] right: []` |
| M16 origin per account | `an_account_has_one_statement_origin_whatever_ref_an_import_names` | `left: 2 right: 1` |
| M16 no device / no stop | `a_statement_line_names_no_device_and_a_statement_is_never_stopped` | `a statement is not a phone store left: 1 right: 0` |
| bank's words | `the_banks_words_stay_in_the_statement_whatever_the_line_is_called_now` | `left: "Amazon Marketplace" right: "AMZN MKTP US*2K4"` |

#### Falsification of the two riskiest claims

- *Only the follower's own trash is undone.* Throwaway: made the restore branch unconditional. `a_record_that_returns…` failed at `assert!(w.trashed(&ben))` (the member's trash was undone). Reverted.
- *The owner is nobody's record.* Throwaway: removed the owner skip in `match_existing`. The owner test failed with `follow.contacts: a source never names the vault's owner` (the `link` backstop caught it). Reverted.

#### Exit list

- Red-first tests: failing on the base, passing now (15 in `follow_gaps`).
- `cargo test -p centraid-vault`, `-p centraid-screens`, `-p centraid-core`, the four app crates: green.
- `contracts/schema/vault-ddl.sql`, `SCHEMA_DIGEST`, ontology page, screens catalog regenerated. `vault-commands.txt` unchanged (no command added or removed).
- `cargo xtask gate --profile pr`: first run FAILED in `test` on `centraid-apps-health manifest::every_action_is_a_vault_command_with_its_schema` (four app manifests copy `follow.*`'s schema; fixed by adding `size`); the rerun's result is in the final message. Skips: buf, cargo-deny, actionlint, gitleaks, osv-scanner (not installed).
- `mobile-jvm`: not run; no `mobile/` file or proto changed.

#### Files

Changed: `contracts/migrations/001_baseline.sql`, `contracts/schema/vault-ddl.sql`, `crates/vault/src/commands/{entity,event,follow,person}.rs`, `crates/vault/src/format.rs`, `docs/vault-ontology.md`, `scripts/docs-site/src/content/ontology-body.html`, `crates/screens/src/imports/{files,mod}.rs`, `crates/screens/src/catalog.rs`, `crates/core/src/shell.rs`, `crates/core/src/shell/manifest.json`, `crates/apps/{agenda,health,money,people}/manifest.json`, `receipts/issue-1146-rebuild-gaps.md`. Added: `crates/vault/tests/follow_gaps.rs`.

Owner hand-offs: none (no native file changed).

Not done: a member-facing "ask" for a doubted read (no surface; R-1127-9). Outside the wave: the `format-check` pre-commit hook exits 2 when the only staged oxfmt-owned file is an ignored generated one (`ontology-body.html`).

#### Changelog line

A phone that loses most of a calendar, address book or folder at once no longer clears it from the vault, a contact that comes back is restored, and merging two people keeps everything that pointed at either.

#### Decision rows

| **R-1146-2-1** | One vanish guard in the follow engine for every system: a complete read that loses at least five followed rows and more than half of them trashes nothing and reports `doubted`; the member is not asked. _Why:_ one mechanism, not a copy per screen. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-2-2** | The follower remembers the trash it made (`source.gone_at`); the record's return restores an untouched row, and a member's trash stands. _Why:_ the two trashes are otherwise indistinguishable. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-2-5** | A statement is an account's: one origin per account, no `device_id`, never stopped, and `source.stated` keeps the bank's first words. _Why:_ it is not a phone store. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-2-7** | `person.merge` is confirmed like a purge and re-points every foreign key into an entity derived from the file. _Why:_ it ends a person and a hand list drifts. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
### Wave 3 — Trash and bytes

Decision T and findings M8, M10, M11, M14.

#### What changed

- **T.** `entity.restore` no longer refuses a row past `purge_at`. `Vault::empty_overdue_trash` (`crates/vault/src/tidy.rs`) runs `entity.empty_trash {due_only, limit}` in bounded batches and does nothing (one indexed read) when nothing is overdue; `Core::open` starts it on a thread of its own. `entity.empty_trash` takes an optional `limit` and answers `more`, and skips a row a purge would refuse (a calendar with events) instead of failing the command.
- **`origin.fills`.** A purge ends the follow of any origin that fills the purged entity, for every kind. `PURGE_RULES` (`entity.rs`) names a rule for all 19 `NO ACTION` pointers into an entity or a kind's table; `commitments.rs` derives the same set from `PRAGMA foreign_key_list` and requires equality.
- **Section move.** `container.move` of a section sets `project_id` of every task in it (trashed ones too).
- **`released`.** `derivative.write`, `derivative.drop`, `thread.clear` and `blob.collect` collect and answer `released`; `thread.save_turn` answered a count, so its thumbnail files were never deleted, and now answers the hashes. A replayed answer deletes no file.
- **File sweep.** `Vault::sweep_unclaimed_files(before, limit)` deletes store files with no `blob` row older than the core's launch; `ByteStore` refreshes an old file's time when the same bytes are staged again. The core starts it once, when the first store is attached.
- **Backup.** `backup::files::content_files` omits a blob only lapsed entities rent (`RENTERS`, held to the schema by a commitment test); a derivative follows its original.

#### Rulings

- **R-1146-3-1** (M8, `origin.fills`): a purge forgets the origin's sources and retires the origin, as `follow.stop` does, for every kind. _Why:_ the rows stay the member's own; detaching `fills` would leave a statement or calendar origin with no target.
- **R-1146-3-2** (T): Restore stays offered and accepted for a lapsed row; the docs screens say "emptied when Centraid next opens". _Why:_ the pass, not the date, is what ends restorability.
- **R-1146-3-3** (M11): `derivative.write` collects every unreferenced blob, as purge does. _Why:_ one collector, one meaning of `released`; a row that is claimed and not yet named exists only through `blob.stage`.
- **R-1146-3-4** (M10): the sweep spares by file time, not by name: a file written since launch is a staging's. _Why:_ the core cannot see between the stage door's `end` and the naming command.
- **R-1146-3-5** (M14): a lapsed renter is judged by `purge_at <= now`, a blob nothing rents yet is listed.

#### Red-first

| Finding | Test | Red line on the wave-1 base (stub API where needed) |
| --- | --- | --- |
| T | `an_overdue_row_is_restorable_until_the_pass_runs_and_gone_after_it` | `entity.restore: “Old lease” has been in the trash past its grace window and can no longer be restored` |
| T | `the_launch_pass_is_bounded_and_says_when_more_is_overdue` | `left: (0, false) right: (2, true)` |
| origin.fills | `purging_a_calendar_or_a_folder_an_origin_fills_clears_the_origin` | `entity.purge: FOREIGN KEY constraint failed` (re-seen under falsification) |
| purge rules | `every_pointer_into_an_entity_that_deletes_nothing_has_a_purge_rule` | no `PURGE_RULES` before the fix (compile failure) |
| section move | `moving_a_section_to_another_project_takes_its_tasks_with_it` | `t1 follows its section` (task still in the old project) |
| released | `derivative_drop_and_write_release_the_bytes_they_stop_naming`, `thread_clear_...`, `blob_collect_...` | `` `released` is a list of hashes, not null `` |
| released | `a_regenerated_turn_releases_the_thumbnail_it_replaced_as_hashes` | `` `released` is a list of hashes, not 1 `` |
| sweep | `a_file_with_no_row_is_swept_and_a_file_with_one_is_not`, `the_file_sweep_looks_at_a_bounded_batch_and_resumes` | `left: [] right: ["e30bbe3c…"]`; `left: 0 right: 2` |
| sweep | `staging_the_same_bytes_again_refreshes_the_files_time` (blobs) | `the time moved up to now` |
| backup | `the_backup_lists_no_blob_only_a_lapsed_entity_names` | `past its purge date` |
| core | `the_launch_pass_purges_what_is_overdue_...`, `open_starts_the_pass_without_a_request`, `the_launch_sweep_takes_stray_files_...` | written with the implementation; falsified below |

#### Falsification

- Listing lapsed blobs switched off: `the_backup_lists_no_blob_only_a_lapsed_entity_names` fails (`past its purge date`). Reverted.
- Origin forgetting limited to accounts again: `purging_a_calendar_or_a_folder_...` fails (`FOREIGN KEY constraint failed`). Reverted.

#### Verification

- Inherited failure: none seen. One policy gate failed on my first sweep (`query_plans`: a full read of `blob`); fixed in code (one primary-key lookup per old file), ledger untouched, `query_plans` now passes.
- Existing tests changed because their subject is decided: the restore-past-window refusals in `docs_photos.rs`, `locker_commands.rs`, `docs_tests.rs`, `park.rs`; `blob.collect` answers `released` (was `collected`); the backup unit test uses a future `purge_at` for "still held".
- The assistant's tests that asserted the vault's "past the restore window" decline had that decline as their whole subject, which decision T deletes. In `crates/nativetools/tests`: `a_restore_past_the_window_ends_in_a_decline_for_every_kind` became `a_restore_past_the_window_still_restores_every_kind`; `a_restore_that_lands_in_part_stays_an_error_with_its_diff`, `a_decline_is_not_paged_by_more_and_does_not_repeat` and `a_restore_of_rows_that_are_all_past_the_window_is_still_the_decline` were deleted; `issue_11_...`, `a_restore_over_several_rows_...`, `the_flags_still_switch_the_block_off` and `a_write_on_a_trashed_row_...` now assert the restore. The error family `act.restore_name_it_is_in_the` has a `why_none`, and `contracts/assist/export/errors.json` was regenerated.
- Outside the wave: `crates/assist/src/native/act.rs` still carries the code path that words a vault refusal as "past the vault's restore window"; nothing reaches it now.
- Gate results: see the final message.

#### Not done, and why

- A race remains between a purge's file removal and a stage door re-staging identical bytes before a command names them (pre-existing).
- Photos' countdown strings (wave 6's files) still read `purge_in_days`; only Docs was edited.

#### Files

Changed: `crates/blobs/src/store.rs`, `crates/core/src/app_query/docs_tests.rs`, `crates/core/src/handle.rs`, `crates/core-ffi/CONTRACT.md`, `crates/api-proto/proto/centraid/core/v1/docs.proto`, `crates/api-proto/proto/centraid/core/v1/docs_screens.proto`, `crates/assist/src/native/park.rs`, `crates/screens/src/docs/fold.rs`, `crates/screens/src/strings/docs.rs`, `crates/vault/src/backup/files.rs`, `crates/vault/src/commands/{blob,container,entity,mod,thread}.rs`, `crates/vault/src/lib.rs`, `crates/vault/tests/{commitments,docs_photos,locker_commands,shared_verbs}.rs`, `docs/vault-ontology.md`.
Added: `crates/vault/src/tidy.rs`, `crates/vault/tests/trash_and_bytes.rs`.
Deleted: none. Native files: none (the proto change is comments and a string the screens render).

#### Changelog line

A trashed item stays restorable until Centraid next opens; then items past their 30 days are emptied in the background, and the files of anything deleted are always freed, including leftovers from interrupted saves.

#### Decision rows

| **R-1146-3-1** | A purge ends the follow of any origin that fills the purged entity, for every kind, as `follow.stop` does. _Why:_ the rows stay the member's; `origin.fills` has no delete action. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-3-2** | `purge_at` says when the launch pass may empty a row, not when it stops being restorable. _Why:_ nothing swept the phone, and a refused restore of a row still present lost data for no reason. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-3-3** | Every command that can drop the last reference to a blob collects and answers `released`; the gate deletes those files after the commit, never for a replayed answer. _Why:_ `thread.save_turn` answered a count and leaked files. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-3-4** | The launch sweep deletes only store files with no row and older than the core's launch. _Why:_ the stage door stores bytes before any command names them. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-3-5** | The backup lists no blob that only entities past `purge_at` rent. _Why:_ the next launch deletes them. [#1146](https://github.com/srikanth235/centraid/issues/1146) |

### Integration — waves 6, 2 and 3

Three finished wave branches merged into the umbrella, each as its own `--no-ff` commit, in order.

| Merge | Commit | Conflicts |
|---|---|---|
| Wave 6 (apps; base `aa1c47d9`, before lane 1B) | `139a14b0` | `ontology-body.html` (inside the generated schema section), then the semantic fallout below |
| Wave 2 (phone follow) | `2072acb0` | `crates/vault/src/format.rs` (`SCHEMA_DIGEST`: both sides changed the baseline), `ontology-body.html` (generated) |
| Wave 3 (trash and bytes) | `430fb5c5` | `docs/vault-ontology.md` (Trash, Garbage collection and Follow bullets) |
| Wave 3, two later commits (bounded launch sweep, idle-gated tidy) | `48caef67` | none |

#### Resolutions

- **Generated files are never hand-merged.** The conflicts in `ontology-body.html` and `SCHEMA_DIGEST` were resolved by taking the umbrella's side and regenerating: `contracts/schema/vault-ddl.sql` (`export-ladder-ddl`), `contracts/schema/vault-commands.txt` (`export-commands`), the ontology page (`export-ontology-page`), `crates/screens/src/catalog.rs` (`cargo xtask screens-catalog`) and `contracts/assist/export` (`nativetools export`). `SCHEMA_DIGEST` took the value its own test printed after each merge (`c99d0f4e…` after wave 6, `bd78a0aa…` after wave 2; wave 3 left it). `git diff --exit-code contracts/schema` is clean after each regeneration.
- **Wave 6 onto the 1B model.** No wave 6 code used the journal, `journal_seq`, `invocation_id`, `entity.version`, a note's `row_version`, Docs Activity or `thread.rename`; the merge compiled and its tests passed without porting. The one semantic fallout was `crates/core/tests/query_plans.rs`: the wire now has 58 queries (wave 6 removed the photos duplicates query, 1B removed Docs activity), so the count and its comment went from 59 to 58 (R-1146-I-1).
- **`docs/vault-ontology.md`.** Wave 3's Trash and Garbage collection text stands (a trashed row stays restorable until the pass empties it, R-1146-3-2); wave 2's Follow text stands (`gone_at`, tombstones, the four guards, the statement origin). The Trash bullet therefore no longer cites R-1135-5-7, which wave 3 supersedes; `docs/decisions.md` still lists R-1135-5-7 without a supersession marker (R-1146-I-2).
- **Receipt order:** lanes, owner rulings, then waves 5, 6, 2, 3.

#### Rulings

- **R-1146-I-1.** The wire-query count in `query_plans.rs` is 58. _Why:_ it is the number of `oneof query` fields in `app_query.proto`; the test exists to keep the two equal.
- **R-1146-I-2.** The Trash bullet follows wave 3 (R-1146-3-2). `docs/decisions.md` row R-1135-5-7 needs a "superseded by R-1146-3-2" marker; wave 3's doc pass owns it, and it was not added here.
- **R-1146-I-3.** Wave 3's two later commits are merged as they stand. Their `search-budget` result is green (notes 2 letters p95 22.3 ms against the 80 ms ceiling; before the fix it was 254.6 ms on this tree). They also turn one test red; see Open.

#### Exit list

1. `cargo test --workspace`: green at `2072acb0` and at `430fb5c5` (two failures fixed on the way: the `query_plans` count above, and a stale `libcentraid_core_ffi.so` that `cargo build -p centraid-core-ffi` refreshed). **Red at `48caef67`**, see Open.
2. `git diff --exit-code contracts/schema` after regenerating: clean.
3. `cargo xtask gate --profile pr`. At `430fb5c5`: every step ok except `search-budget` (notes 2 letters `ch` p95 254.57 ms against 80 ms), wall 1506 s on a cold tree. At `48caef67` (after wave 3's fix): `search-budget` ok (190.6 s), `test` FAIL, every other step ok or SKIP (buf, deny, ci-policy, secrets, osv: tools missing), wall 696 s.
4. `cargo xtask gate --profile mobile-jvm`: **not run to a result.** Maven Central answered HTTP 429 on every attempt (nine attempts, 9 Too Many Requests, spaced 1 to 4 minutes); no failure of any other kind.
5. Pushed after each merge; the pre-push hook passed.

#### Open

- **`a_phone_killed_mid_stage_leaves_nothing_and_stages_again`** (`crates/core/tests/backup_edges.rs:1211`) fails deterministically at `48caef67`: `(content_confirmed, content_total)` is `(0, 1)`, expected `(1, 1)`. It passed at `430fb5c5`. Setting `TIDY_IDLE` in `crates/core/src/handle.rs` to 300 s makes it pass, so wave 3's idle-gated launch tidy (`bbd0d6ff`/`38541879`) is the cause. Staging goes through the spool, not the vault, so the tidy sees the vault idle while a library item is mid-stage. Wave 3 owns the fix.
- **mobile-jvm** needs a rerun when Maven Central stops rate-limiting.

### Wave 4 — Agenda

Finding H5 and decisions D6 and D7 of #1146. A moved day of a repeating event now reads under its own timing and may carry its own link and place; a followed phone calendar is a calendar of the vault, with the phone's colour.

#### What changed

- **H5.** `occurrence` gains `timing` (`zoned`/`floating`/`all-day`; NULL is the series') and `zone` (only a zoned day names one, and only when it is zoned unlike its series). `event.edit_occurrence` resolves a day's times over its series (`day_times`): a day that states another timing is stored under it, a day that states its series' own stores NULL, and the series' length is never carried over a day's own start or into another timing (it used to be refused as "must end after it starts"). Agenda's expansion (`occurrence_row`) sets the row's semantics and zone from the day, so `local::place` and `still_running_at` place it by its own timing and a day of another kind borrows no length.
- **D6.** `occurrence` gains `url` and `place_id REFERENCES place(id)` (NULL is the series'), indexed by the partial `occurrence_by_place`; `event.edit_occurrence` accepts `url` and `place_id` (the place must be a live place); `PURGE_RULES` and `DETACH` name `occurrence.place_id` as `Detach` (the day stays and reads the series' place again; the series is the entity touched). Reads: the row's `conferencing_uri`, `location_place_id` and `location_name` are the day's (`name_places` names a place the days brought). Guests and reminders stay the series'.
- **The follower (H5 + D6).** A phone's `moved` entry states `timing`, `zone`, `url` and `location`; `derive` reads it under the day's own timing, the day's place is held as its NAME (a phone states words; `place::find_or_found_named` finds the live place of that title without regard to case or founds one when the day is written, so a pass that says the same words changes nothing). The series' `url` is a followed field now.
- **D7.** `follow.calendar` founds a `calendar` container per phone calendar the first time it is read (`container::follow_calendar`, through the system map's new `founds`), titled as the phone calls it, painted with the colour the origin states (`origin.color`, new), and files the origin's events there instead of `calendar:default`. Each later pass keeps it: the colour follows the phone; the title follows the phone only while it is still what the phone last called it (a name the member gave stands); a calendar the member trashed is left in the trash; an origin that pre-dates the change moves its events still filed under `calendar:default`. The screens send the design wheel's hue nearest the phone's colour (`centraid_design::hue_key_of_hex`, by OKLCH hue angle; a grey sends none) as `var(--c-<hue>)`, which is what Agenda's `party_hue_key` already reads, so the colour follows the theme. `PhoneCalendar.color`, `PhoneCalendarEvent.url` and `.location` are new on the wire (additive; no field was removed).
- **The shells.** iOS reads `cgColor`, `url` and `location`; Android reads `CALENDAR_COLOR` and `EVENT_LOCATION` (Android has no event URL).

#### Rulings

- **R-1146-4-1** (H5, scope). A change of timing is for one day: `scope: future` with another timing is refused ("A change of timing is for one day, not for every day after"). _Why:_ a `future` override moves later days by the wall-clock delta between the day and where it moved; across timings there is no such delta.
- **R-1146-4-2** (H5, schema). The day also gets `zone`, which the brief did not name. _Why:_ a zoned day of an unzoned series (or of another zone) must say its zone, and the `event` row's own CHECK ties `zoned` to a zone; `CHECK (zone IS NULL OR timing IS 'zoned')` keeps the pair honest.
- **R-1146-4-3** (H5, storage). A day that states its series' own timing (and zone) stores NULL, never a copy. _Why:_ one canonical form, so the follower's three-way comparison between what the phone implies and what the vault holds does not see a difference where there is none.
- **R-1146-4-4** (D6, the place). A phone's location is a place found by title (case-insensitive) or founded, never an address guess; the series' own location is not followed (the screens send a day's `location` only when it differs from its series' on the phone). _Why:_ the series carries no `location` field today (only `place_id`, a member's choice); following it is a separate decision, listed below.
- **R-1146-4-5** (D7, colour). The vault stores `var(--c-<hue>)`, the wheel's key, not the phone's hex. _Why:_ `party_hue_key` returns none for a stored literal, so a hex would paint with the id's own hue and the phone's colour would be lost silently; the wheel's hue keeps the colour on the theme. The mapping is the nearest of the eight `APP_HUES` by OKLCH angle, and a grey has none.
- **R-1146-4-6** (D7, a calendar that leaves the phone). The screens send nothing for a calendar the phone no longer lists; its container and events are kept as they are and no guard is exercised for it. A calendar the phone still lists but that lost most of its events goes through wave 2's guard, per calendar now (test below). _Why:_ the shell's read has no way to say "this calendar left"; judging absence is the origin's complete read.
- **R-1146-4-7** (D7, rename). A calendar's title follows the phone only while it is what the phone last called it. _Why:_ `entity.retitle` is the member's, and a followed name must not undo it; the same three-way rule every followed field has.

#### Red-first

Written before the fix, on base `191f0e4e` (`crates/vault/tests/agenda_days.rs`, `crates/apps/agenda/tests/day_overrides.rs`); lines seen:

| Finding | Test | Red line on the base |
| --- | --- | --- |
| H5 timing stored | `an_all_day_series_day_moved_to_a_time_keeps_the_timing_it_was_moved_under` | `no such column: timing` |
| H5 zoned day made all-day | `a_zoned_series_day_made_all_day_is_a_date_and_is_not_refused` | ``event.edit_occurrence: `ends` is 2026-03-02T08:30:00.000Z; with this timing it is a date, YYYY-MM-DD.`` |
| H5 canonical NULL | `a_day_that_states_its_series_own_timing_stores_none` | `no such column: timing` |
| H5 future scope | `a_change_of_timing_is_for_one_day_not_for_every_day_after` | `event.edit_occurrence was not refused left: Executed right: Failed` |
| H5 placed wrong (read) | `an_all_day_series_day_moved_to_a_time_is_a_timed_row_at_that_time` | `the day reads as a clock left: AllDay right: Floating` |
| H5 read (zoned→all-day) | `a_zoned_series_day_made_all_day_is_a_date_with_no_borrowed_length` | ``event.edit_occurrence: `ends` is 2099-06-01T07:30:00.000Z; with this timing it is a date`` |
| D6 command | `one_day_of_a_series_carries_its_own_link_and_place_and_the_rest_stay_the_series` | `Additional properties are not allowed ('place_id', 'url' were unexpected)` |
| D6 purge | `purging_a_place_a_day_names_leaves_the_day_with_the_series_place` | `Additional properties are not allowed ('place_id' was unexpected)` |
| D6 read | `one_day_shows_its_own_link_and_place_and_its_neighbours_the_series` | `Additional properties are not allowed ('place_id', 'url' were unexpected)` |
| D6 follower | `a_phone_s_moved_day_keeps_its_timing_link_and_place_through_the_follower` | `no such column: timing` |
| D7 | `each_phone_calendar_is_a_calendar_of_the_vault_with_the_phone_s_colour`, `a_followed_phone_calendar_is_listed_by_name_with_the_phone_s_colour` | `follow.calendar: /origin: Additional properties are not allowed ('color' was unexpected)` |
| D7 rename | `a_calendar_the_member_renamed_keeps_their_name_and_one_they_did_not_follows_the_phone` | no calendar was founded (`fills` is NULL) |
| D7 purge | `a_purged_phone_calendar_ends_its_follow_and_the_next_pass_makes_it_again` | `'color' was unexpected` |

Passing on the base too, kept as guards: `a_change_of_timing_needs_the_time_it_is_under` (the existing refusal already names `starts`) and `a_calendar_that_lost_most_of_its_events_trashes_none_of_them` (the wave 2 guard, now holding per calendar). The screens tests (`a_moved_day_states_its_own_timing_link_and_place_and_a_series_states_its_link`, `a_calendar_is_painted_with_the_wheel_hue_nearest_its_phone_colour_and_a_grey_has_none`, and `centraid_design`'s `a_phone_colour_is_the_wheel_hue_nearest_its_own_and_a_grey_has_none`) were written with the code; their subject did not exist on the base.

#### Falsification of the two riskiest claims

1. _"A pass that says the same words changes nothing."_ Throwaway: the day's place compared exactly instead of without regard to case. `a_phone_s_moved_day_keeps_its_timing_link_and_place_through_the_follower` failed: `the same word is no change: {…"updated":1}`. Reverted.
2. _"A name the member gave a followed calendar stands."_ Throwaway: the rename ignored what the phone last called it. `a_calendar_the_member_renamed_keeps_their_name_and_one_they_did_not_follows_the_phone` failed at `the member's name stands left: "iCloud: Home"`. Reverted.

#### Exit list

1. Red-first tests: the lines above, on `191f0e4e` (src, schema and agenda paths checked out from the base with the new test files kept); all green on the branch (`agenda_days` 12, `day_overrides` 4).
2. `cargo test -p centraid-vault` (every binary green after the digest, census and generated page were updated), and `-p centraid-core -p centraid-screens -p centraid-apps-agenda -p centraid-apps-health -p centraid-apps-money -p centraid-apps-people -p centraid-apps-kit -p centraid-design -p centraid-api-proto -p centraid-nativetools -p centraid-assist`: green. The three manifest copies of `follow.*`'s schema (`health`, `money`, `people`, plus `agenda`) were updated for `origin.color`.
3. Regenerated `contracts/schema/vault-ddl.sql` (`export-ladder-ddl`), the published ontology page (`export-ontology-page`) and `SCHEMA_DIGEST` (`b585334211ed…`); `vault-commands.txt` is unchanged (`export-commands` equals it). `git diff --exit-code contracts/schema` is clean after regeneration.
4. `cargo xtask gate --profile pr`: every step **ok** (fmt, clippy, test 988.6 s, restore-drill, rules, doc-links, ledgers, release-build 502.7 s, ts-static, emitters, advisory, lockfile, call-budget, search-budget 275.2 s, fault-door); **SKIP** `buf`, `deny`, `ci-policy` (actionlint), `secrets` (gitleaks), `osv` (not installed). The verdict line reads FAIL on time alone: 1891.5 s against the 1500 s cold budget, on a cold tree (the container's disk had to be cleared of old test binaries once, which forced a rebuild). The budget was not touched. An earlier run of the same gate stopped at `clippy` on this wave's own code (`obfuscated_if_else` in the screens), fixed in `5addb1ac`, and at `fmt` on an unformatted test line; the run above is on that fix.
5. `cargo xtask gate --profile mobile-jvm`: **not run to a result.** Maven Central answered HTTP 429 on all five attempts (spaced 4 to 6 minutes; the plugin `com.squareup.wire:7.0.1` could not be resolved); no Kotlin or Swift of this wave is compiled by `:core:jvmTest` in any case. The proto change is additive (three new fields), and the Rust side compiles and tests against it.
6. Pushed after each seam; the pre-push hook passed.

#### Not done, and why

- **The series' own location is not followed** (R-1146-4-4): `event.place_id` is a member's choice and the follower's `fields` are columns; a phone event's location never reached Agenda before this wave and still does not, except as a moved day's. Following it needs a `Child` like `points` (a place found by words, three-way merged) — a separate decision for the owner.
- **No screen edits a day's link or place** and the assistant's `reschedule` action (`crates/apps/agenda/manifest.json`) was not widened to `url`/`place_id`: the command accepts them, nothing in the product offers them yet.
- **A phone calendar that leaves the phone** (R-1146-4-6): nothing is sent for it, so its container and events stay; there is no "left the phone" signal to judge.
- **The native views are not compiled here** (no Android SDK, no Xcode): `mobile/androidApp/.../CalendarImporter.kt` and `mobile/iosApp/Sources/PhoneCalendar.swift` gained the reads of the new fields. Owner hand-off: build both apps, import a calendar that has a colour, a location and (iOS) a link, and look at Agenda's calendar dots and a moved occurrence's place.

#### Files

Changed: `contracts/migrations/001_baseline.sql`, `contracts/schema/vault-ddl.sql`, `crates/api-proto/proto/centraid/core/v1/screens.proto`, `crates/apps/agenda/{README.md,manifest.json}`, `crates/apps/agenda/src/{detail,expansion,queries}.rs`, `crates/apps/{health,money,people}/manifest.json`, `crates/design/src/lib.rs`, `crates/screens/src/agenda/calendar.rs`, `crates/screens/tests/{agenda_calendar,imports_made}.rs`, `crates/vault/src/commands/{container,entity,event,follow,place}.rs`, `crates/vault/src/format.rs` (`SCHEMA_DIGEST`), `crates/vault/tests/commitments.rs` (census rows for `occurrence.zone` and `.url`), `docs/glossary.md`, `docs/vault-ontology.md`, `scripts/docs-site/src/content/ontology-body.html` (generated), `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/agenda/CalendarImporter.kt`, `mobile/iosApp/Sources/PhoneCalendar.swift`, `receipts/issue-1146-rebuild-gaps.md`. Added: `crates/vault/tests/agenda_days.rs`, `crates/apps/agenda/tests/day_overrides.rs`. Deleted: none. `contracts/schema/vault-commands.txt` is unchanged (no command added or removed).

#### Changelog line

A moved day of a repeating event can be a different kind of day from its series (a timed meeting on an all-day day, or the reverse) and can carry its own link and place, and each calendar you follow from your phone is its own calendar in Agenda, in the phone's colour.

#### Decision rows

| **R-1146-4-1** | A change of timing is for one day: an override of the days after is refused when it changes the day's timing. _Why:_ a `future` override moves later days by a wall-clock delta that has no meaning across timings. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-4-3** | A day that states its series' own timing stores none (`occurrence.timing` NULL is the series'). _Why:_ one canonical form, so the follower's three-way comparison sees no difference where there is none. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-4-4** | A day's place is found by its words or founded; the series' own location is not followed. _Why:_ the series has no location field to follow into; a separate decision. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-4-5** | A followed calendar's colour is the design wheel's hue nearest the phone's, stored as `var(--c-<hue>)`. _Why:_ a stored hex reads as no colour to the party-hue rule and would paint the id's own hue. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
| **R-1146-4-6** | A calendar that leaves the phone is not judged; one that stays and loses most of its events goes through the follow engine's guard, per calendar. _Why:_ the shell's read has no "left" signal. [#1146](https://github.com/srikanth235/centraid/issues/1146) |
