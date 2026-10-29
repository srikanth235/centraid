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
