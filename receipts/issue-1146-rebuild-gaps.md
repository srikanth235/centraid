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
- **R-1146-1B-11** (receipt only) — _Finding:_ `entity.retitle` refuses a chat with "a chat is renamed with `thread.rename`", and its comment gave the journal as the reason (a title is the first thing the member said). With no journal the reason is gone. _Choice:_ behaviour kept, the words that named the journal removed. _Why:_ not mine to change; recorded in the report for the owner.

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
