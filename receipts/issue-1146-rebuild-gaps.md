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
