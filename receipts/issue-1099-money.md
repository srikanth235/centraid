# #1099 — Money

## What changed

## Verification

## Decisions

## Audit

## Lane V — vault

Rung 14 and the 20 `money.*` commands (wave 1 of [#1099](https://github.com/srikanth235/centraid/issues/1099)). Rulings are in [`docs/decisions.md#money-1099`](../docs/decisions.md#money-1099) (R-1099-1 to R-1099-32; this lane ruled R-1099-24 to R-1099-32), the schema doctrine is [`docs/decisions.md#ontology-v0-close-916`](../docs/decisions.md#ontology-v0-close-916), and the state is [`docs/vault-ontology.md`](../docs/vault-ontology.md) (ONT-40).

### What changed

- **Rung 14 schema.** Six `money_*` tables (five projections, one entity), the unique `core_transaction (account_id, external_id)` index, five currency and immutability triggers, the `money.rule` entity kind, the `transfer` relation and 23 category concepts. A vault holding duplicate `(account_id, external_id)` pairs keeps every row: the earliest keeps its id and later ones get `#dup-<txn_id>` (R-1099-25).
- **Seeds are one statement.** The categories scheme and (for a vault that already has the relations scheme) the `transfer` relation are inserted by the rung under fixed ids; `bootstrap.rs` seeds `transfer` under the same id for a new vault, so a vault founded at the head and one climbed from rung 13 hold identical rows (R-1099-28).
- **Twenty commands** in `crates/vault/src/commands/money.rs`: `add_account` (once), `edit_account`, `set_opening_balance`, `import_transactions`, `categorize`, `void_transaction`, `set_display_name`, `link_transfer`, `unlink_transfer`, `set_target`, `set_carry`, `add_rule` (once), `edit_rule`, `delete_rule`, `apply_rule_to_history`, `save_import_profile`, `record_checkpoint`, `add_category` (once), `merge_category`, `archive_category`. Every refusal is a precondition's sentence with a stable predicate; an import's per-line refusals are in its output.
- **Docs.** `docs/decisions.md` (new section `Money (#1099)`, the ONT-dormant narrowing, the R-1047-Q1 row's later ranges), `docs/vault-ontology.md` (the pack row, counts, four commitments, ONT-40), `docs/glossary.md` (Money, statement line), `contracts/README.md`, `crates/vault/README.md`, `CHANGELOG.md`.

Files changed or added (full paths):

- `contracts/migrations/014_money.sql` (new), `contracts/schema/vault-ddl.sql` (regenerated), `contracts/schema/v0-registries.json`, `contracts/README.md`
- `crates/vault/src/migrations.rs`, `crates/vault/src/bootstrap.rs`, `crates/vault/src/commands/mod.rs`, `crates/vault/src/commands/core.rs` (`find_or_create_scheme` is `pub(crate)`, nothing else), `crates/vault/src/commands/money.rs` (new), `crates/vault/README.md`
- `crates/vault/tests/baseline.rs`, `crates/vault/tests/commands.rs`, `crates/vault/tests/common/mod.rs`, `crates/vault/tests/money_schema.rs` (new), `crates/vault/tests/money_commands.rs` (new), `crates/ontology/tests/commitments.rs`
- `docs/decisions.md`, `docs/vault-ontology.md`, `docs/glossary.md`, `CHANGELOG.md`, `receipts/issue-1099-money.md`

Nothing was deleted.

### Verification

See the lane report; the table is filled from the runs below.

### Falsification

1. **A vault holding duplicate `external_id`s still climbs and loses nothing.** Throwaway check: deleted the rewriting `UPDATE` from `014_money.sql` and ran `money_schema.rs::a_vault_holding_duplicate_external_ids_climbs_and_loses_nothing`. Result: red (`UNIQUE constraint failed: core_transaction.account_id, core_transaction.external_id` when the file opened); green with the `UPDATE` restored.
2. **Importing the same file twice writes nothing.** Throwaway check: made the `already_in` lookup in `import_transactions` never match and ran `money_commands.rs::importing_twice_writes_nothing_and_an_overlap_writes_only_the_new_lines`. Result: red; green with the lookup restored.

## Lane P — the Money app crate: import parsers, plan pipeline, rules, adversarial corpus (wave 2)

Branch `money/p`. Doctrine: [docs/decisions.md#money-1099](../docs/decisions.md#money-1099); the schema half is [#ontology-v0-close-916](../docs/decisions.md#ontology-v0-close-916) and is lane V's.

**What this slice is.** `crates/apps/money` (package `centraid-apps-money`) with its import half: `import::{text, csv, ofx, amount, date, keys, plan}` and `rules`, plus the kit's shared CSV reader (`centraid_apps_kit::csv`, lifted out of Locker, which now calls it) and a deterministic year-3 generator. Nothing here touches a vault, a database or a clock: the plan is a function of parsed rows, the account's existing rows, the rules and `today`.

**Red first.** The implementation was written before the corpus files (this section does not pretend otherwise); the corpus was then run against a stub reader (`read_csv` and `read_ofx` returning a refusal at their first line) and recorded red, then the stub was removed:

- stubbed: `cargo test -p centraid-apps-money --test import_corpus` → `41 FAILED` of 41 (e.g. `chase_checking.csv: This does not look like a bank statement.`, `td_canada.csv: This does not look like a bank statement.`; even `a_file_that_is_not_ofx_is_refused` fails, `NotAStatement` where `UnreadableOfx` is pinned);
- real: `test result: ok. 41 passed` (and 19 unit tests).
- The plan and the rules have unit tests written with them; their corpus cases were red only through the stubbed readers.
- Two defects the corpus found in the first implementation and that are fixed with their cases kept: `ROW 0`/`ATM 100` parsed as an amount through a "currency code" prefix (a description column read as numeric; now only a symbol or an ISO code is a currency mark), and a quoted newline kept its `\r` (CRLF and LF exports of one statement hashed differently; now normalised before tokenising).

**Corpus cases (each pins the exact `(day, signed minor, description)` of every row and the line and reason of every rejected one):** Chase checking · Amex (positive charges flipped, `SignGuessed` declared, member override) · Capital One (debit/credit columns, posted date over transaction date) · Bank of America (preamble, header at record 6, the "Beginning balance" line is one rejected row at line 8) · Wells Fargo (no header, read by content) · TD Canada (no header, debit/credit/balance, modelled `MM/DD/YYYY` as TD prints it) · RBC (`CAD$`/`USD$`, `Description 1/2`, cheque number) · Tangerine · windows-1252 · UTF-8 BOM · CRLF + quoted newline + doubled quotes (and CRLF/LF hash alike) · parentheses, `$-`, `CR` · `;` with decimal commas and dotted dates · day-first with an ambiguous first row (decided by a `21/04` three rows down) · wholly ambiguous (the question, then both answers) · an answer cannot overrule a proven day · bad rows (lines 3, 4, 5 rejected, the blank line skipped, the file not blocked) · QFX 1.x SGML (zone suffixes ignored, `CHECKNUM`, `LEDGERBAL` not `AVAILBAL`, line numbers) · OFX 2.x XML with `&amp;` and `&#201;` · multi-account (bank, bank, card; matched by last four and by stored id; NoAccount; Ambiguous refused) · `CURDEF` mismatch · one bad `TRNAMT` (one rejected, two new) · no `FITID` (`ofx-nofitid:`, an identical pair stays two) · not OFX · same file twice (CSV and QFX: every row `AlreadyIn`) · overlap by a week (only the new rows `New`) · weekly same-amount charge (never proposed against last week, including the seven-day case) · identical same-day pair (two rows; one held, the other is new) · fuzzy proposal across a CSV-era copy, never across two different FITIDs · one-to-one claiming · in-file repeat collapse and the counts add up · future-dated flagged · rules applied on plan rows (raw description untouched) · profile re-applied on a matching fingerprint, re-detected with `ProfileChanged` on a changed one, JSON round trip · 20,000 rows read and 20,001 refused with the limit · 8 MiB + 1 byte refused by both readers · not a statement · year-3 (4 accounts, 18,000 rows read, planned, and re-planned to all `AlreadyIn`).

### Seam notes

- `ImportRow` is seam S1 field for field; `RowVerdict::Rejected` carries the reason and the 1-based line is on `PlanRow.line` (and `ParsedRow.line`). There is no "dropped by rule" verdict (R-1099-43); there is a fifth verdict `RepeatInFile`, so that the verdict counts add up to the file's data rows.
- The dedupe hash is **BLAKE3**, not SHA-256 (R-1099-40): the workspace manifest confines `sha2` to two other crates. The shape `csv:<64 hex>` is unchanged.
- Rules agree with the plan's seam S2 text verbatim; wave 3's test against the real vault is the proof.

### Every file this section touches

- `receipts/issue-1099-money.md`
- `CHANGELOG.md`
- `ARCHITECTURE.md`
- `docs/decisions.md`
- `Cargo.toml`
- `Cargo.lock`
- `crates/apps/kit/README.md`
- `crates/apps/kit/src/lib.rs`
- `crates/apps/kit/src/csv.rs`
- `crates/apps/locker/src/transfer.rs`
- `crates/apps/money/Cargo.toml`
- `crates/apps/money/README.md`
- `crates/apps/money/src/lib.rs`
- `crates/apps/money/src/civil.rs`
- `crates/apps/money/src/rules.rs`
- `crates/apps/money/src/year3.rs`
- `crates/apps/money/src/import/mod.rs`
- `crates/apps/money/src/import/amount.rs`
- `crates/apps/money/src/import/csv.rs`
- `crates/apps/money/src/import/date.rs`
- `crates/apps/money/src/import/keys.rs`
- `crates/apps/money/src/import/ofx.rs`
- `crates/apps/money/src/import/plan.rs`
- `crates/apps/money/src/import/text.rs`
- `crates/apps/money/tests/import_corpus.rs`
- `crates/apps/money/tests/corpus/amex.csv`
- `crates/apps/money/tests/corpus/bad_rows.csv`
- `crates/apps/money/tests/corpus/bank_of_america.csv`
- `crates/apps/money/tests/corpus/capital_one.csv`
- `crates/apps/money/tests/corpus/chase_checking.csv`
- `crates/apps/money/tests/corpus/crlf_quoted_newline.csv`
- `crates/apps/money/tests/corpus/curdef_mismatch.ofx`
- `crates/apps/money/tests/corpus/dmy_first_ambiguous.csv`
- `crates/apps/money/tests/corpus/dmy_wholly_ambiguous.csv`
- `crates/apps/money/tests/corpus/identical_pair.csv`
- `crates/apps/money/tests/corpus/multi_account.ofx`
- `crates/apps/money/tests/corpus/ofx2.ofx`
- `crates/apps/money/tests/corpus/ofx_bad_trnamt.ofx`
- `crates/apps/money/tests/corpus/ofx_no_fitid.ofx`
- `crates/apps/money/tests/corpus/overlap_a.csv`
- `crates/apps/money/tests/corpus/overlap_b.csv`
- `crates/apps/money/tests/corpus/parentheses.csv`
- `crates/apps/money/tests/corpus/qfx_sgml.qfx`
- `crates/apps/money/tests/corpus/rbc.csv`
- `crates/apps/money/tests/corpus/semicolon_decimal_comma.csv`
- `crates/apps/money/tests/corpus/tangerine.csv`
- `crates/apps/money/tests/corpus/td_canada.csv`
- `crates/apps/money/tests/corpus/utf8_bom.csv`
- `crates/apps/money/tests/corpus/weekly_charge.csv`
- `crates/apps/money/tests/corpus/wells_fargo.csv`
- `crates/apps/money/tests/corpus/windows1252.csv`

**Falsification.** (1) *The date order is decided over the whole column, not the first row.* Throwaway: `date::decide` mutated to read only the first cell. `a_day_first_file_whose_first_row_is_ambiguous_is_decided_by_the_whole_column` went red (`FAILED`); restored, green. (2) *A weekly same-amount charge is never proposed against last week's.* Throwaway: `FUZZY_DAYS` 3 → 7. The first version of the case stayed green (one-to-one claiming hid it: the Jan 1 row claimed the existing row first); I added the next-week-alone assertion, and with `FUZZY_DAYS = 7` the case went red; restored, green.

## Lane P, part 2 — Money's reads, folds, recurring charges, phone answers, manifest and door (waves 3 and 7)

Doctrine: [docs/decisions.md#money-1099](../docs/decisions.md#money-1099). Rulings R-1099-45..49 are recorded there; the schema half is [#ontology-v0-close-916](../docs/decisions.md#ontology-v0-close-916) and lane V's.

**What changed.** `queries.rs` (every read a `PageQuery` with a stated ceiling), `engine.rs` (spending, in/out/net, cash flow, balances, net worth, the target reducer with carry, transfer proposals moved from Tally), `recurring.rs` (detection, RRULE through the vault's one engine, statuses, forecast), `phone.rs` (the typed answers), `manifest.json` + `manifest.rs`, `commands.rs` (20 actions), `door.rs` (behind `vault-door`), `import::csv::SavedProfile`, and the hand-computed fixtures under `contracts/apps/money/`.

**Verification.** `cargo test -p centraid-apps-money --all-features`: 47 unit, 4 door, 14 folds, 41 corpus, 7 phone and the year-3 suite green; `cargo clippy -p centraid-apps-money --all-targets --all-features -- -D warnings` green; `cargo xtask rules` green. The year-3 suite imports 18,000 rows through the real `money.import_transactions`, re-imports one account (all `already_in`), reads six screens through the kit's `TestDoor` and through the vault's own `keyset_page` (equal answers), and reconciles the screens with arithmetic from the parsed rows.

**Findings.** (1) `Vault::keyset_page` probes `limit + 1` through `page_raw`, which clamps to 500 again: a page asked for at exactly 500 returns no `next`, so every 500-row walk stops silently (R-1099-48). `PAGE_ROWS = 499` is the crate's defence; the fix belongs in `crates/vault/src/page.rs`. (2) The paged door takes one table in `from`; no join. (3) `money.add_account` / `edit_account` cannot set `core_account.external_ref`, so an OFX statement can be matched to an account only by a value the member has no command to enter (`import::resolve_account` needs `external_ref` or a mask). (4) The vault's RRULE subset has no positional `BYDAY` (R-1099-47).

### Every file this section touches

- `receipts/issue-1099-money.md`, `CHANGELOG.md`, `docs/decisions.md`, `Cargo.lock`
- `crates/apps/money/Cargo.toml`, `crates/apps/money/README.md`, `crates/apps/money/manifest.json`
- `crates/apps/money/src/lib.rs`, `civil.rs`, `queries.rs`, `engine.rs`, `recurring.rs`, `phone.rs`, `manifest.rs`, `commands.rs`, `door.rs`, `import/mod.rs`, `import/csv.rs`, `import/plan.rs`
- `crates/apps/money/tests/common/mod.rs`, `door.rs`, `folds.rs`, `phone.rs`, `year3.rs`, `import_corpus.rs`
- `contracts/apps/money/rows.json`, `spending.json`, `cashflow.json`, `balances.json`, `targets.json`, `transfers.json`, `recurring.json`, `rules.json`

**Falsification.** (1) *Overspending never carries in Tracking mode.* Throwaway: the tracking branch changed to carry the unfloored leftover; `overspending_does_not_carry_in_tracking_and_does_in_the_dormant_envelope_branch` went red; restored, green. (2) *A walk over a month longer than 500 rows is whole through the vault's own assembler.* Throwaway: `PAGE_ROWS` set to 500; the year-3 suite went red at "cash flow month 2024-01" (the keyset door returned 500 of 512 rows); restored, green. That check is also what found finding (1).

## Lane T — Tally removed

Doctrine: [docs/decisions.md#money-1099](../docs/decisions.md#money-1099) (R-1099-19..23, 33..39 and this lane's R-1099-50..59), [#ontology-v0-close-916](../docs/decisions.md#ontology-v0-close-916) (ONT-dormant, narrowed), and [#typography-and-design-contracts](../docs/decisions.md#typography-and-design-contracts) for the catalogue and hue-table edits in `packages/design`.

**What changed.** The owner deleted Tally from v0. Rung 15 (`contracts/migrations/015_drop_tally.sql`) drops the twelve `tally_*` tables, the expense and circle indexes and the rows Tally wrote in the spine, and moves the chat's two app lists to `money` in one rebuild. The Tally crate, its vault commands, People's two debt commands, its core queries and proto, the assistant's Debt and Group kinds and settle verbs, both phones' Tally screens, its copy and fixtures are gone. 361 files added, changed or deleted (listed below).

**Climb evidence** (`crates/vault/tests/drop_tally.rs`). A rung-14 file holding every kind of row Tally wrote, climbed to 15, loses exactly: `core_entity` 17, `core_entity_kind` 8, and one row each of `core_link`, `core_attachment`, `knowledge_annotation`, `schedule_recurrence_exception`, `schedule_recurrence_exception_attendee`, `social_circle`, `social_circle_member`, `core_transaction`, `core_account`, `access_seed_row`, `chat_message_card`. Every other table's count, including the FTS and shadow tables, is equal before and after. A founded vault holds no Tally and the rung runs over its own result; the chat's guards and search triggers survive the rebuild under the rowids they had. Every `core_party` stays: a friend was a person first.

**Verification.**

- `cargo test --workspace --no-fail-fast` (under `flock /home/user/.heavy.lock`): pass, 2,959 tests, 0 failed (nine targets were rerun alone after a disk prune removed their binaries before they ran; all pass).
- `cargo xtask rules`: pass, every rule ok. `cargo test -p centraid-nativetools -p centraid-assist` with the regenerated `contracts/assist/export`: pass. `bun run check:push:static`: pass (4/4 gates).
- `cargo xtask measure --only incrementalCheckSeconds`: 2.1 s and 2.3 s on `crates/apps/money/src/lib.rs` (ceiling 10 s, unchanged; the ledger's headroom prose quotes both).
- `cargo xtask gate --profile mobile-jvm`: **could not run here** — exit 1 at Gradle configuration, `Plugin [id: 'com.squareup.wire', version: '7.0.1'] was not found` (the sandbox's proxy answers 303 for the Gradle plugin portal). No Kotlin compiled or ran, so the Kotlin and Swift edits are statically checked only (`rg` for every removed symbol). `cargo xtask gate --profile pr` was skipped by the owner's scope cut of 2026-10-14.
- `node .governance/law/run.mjs --brief-digest b4ce8d9df2f4`: the window door reports two receipt-per-issue findings on the umbrella receipt itself (its top-level `## Verification` and `## Audit` sections are the root's) and, before this section, the doctrine citation above.

**Iterations the owner should know about.** (1) Lowered once, each by the exact amount the removed code owned: the ontology's entity floor (50 -> 40), trash count (13 -> 10) and replicated-table count (109 -> 97); the nativetools error-example floor (125 -> 116). No ledger or budget was raised. (2) `experiments/toolchat/native` was not rewritten: its worlds hold debts and groups, so the `native-python` CI job is expected red until wave 8 regenerates them (R-1099-59). (3) The Swift files could not be compiled; see the iOS hand-off list in `HANDOFF-t.md`.

**Falsification.** (1) *The pool sweep deletes only the settlement account's mirror rows.* Throwaway: the rung's `DELETE FROM core_transaction` lost its `AND account_id IN (SELECT ... 'Tally settlements')` guard. `a_rung_fourteen_vault_climbs_losing_exactly_the_tally_rows` failed: `core_entity: 57 before, 39 after` against 40 expected (a bank-account row whose `external_id` begins `tally:settlement:` was swept, with its entity). Restored; the file is unchanged. (2) *A rebuilt chat thread keeps its rowid, so a search answers the right thread.* Throwaway: the thread re-insert dropped `rowid` and read the carry in reverse. The same test failed at its search assertion: `[(1, "th-aaa"), (2, "th-bbb"), (3, "th-ccc")]` against `[(1, "th-ccc"), (2, "th-bbb"), (3, "th-aaa")]`. Restored.

### Every file this section touches

- `receipts/issue-1099-money.md`, `HANDOFF-t.md` (scratchpad, not in the tree)
**Added** (2):
- `contracts/migrations/015_drop_tally.sql`
- `crates/vault/tests/drop_tally.rs`

**Deleted** (68):
- `contracts/apps/tally/balances.json`
- `contracts/apps/tally/commands.json`
- `contracts/apps/tally/queries.json`
- `contracts/apps/tally/rows.json`
- `contracts/apps/tally/scenarios.json`
- `contracts/apps/tally/year3-ceiling.md`
- `contracts/screens/tally/data-page.bin`
- `contracts/screens/tally/data-page.textproto`
- `contracts/screens/tally/empty-ledger.bin`
- `contracts/screens/tally/empty-ledger.textproto`
- `contracts/screens/tally/loading-first.bin`
- `contracts/screens/tally/loading-first.textproto`
- `contracts/screens/tally/low-disk-parked.bin`
- `contracts/screens/tally/low-disk-parked.textproto`
- `contracts/screens/tally/offline-withheld.bin`
- `contracts/screens/tally/offline-withheld.textproto`
- `contracts/screens/tally/refused-denied.bin`
- `contracts/screens/tally/refused-denied.textproto`
- `contracts/tools/tally-parity-ledger.ts`
- `copy/tally.json`
- `crates/api-proto/proto/centraid/core/v1/tally.proto`
- `crates/apps/tally/Cargo.toml`
- `crates/apps/tally/README.md`
- `crates/apps/tally/manifest.json`
- `crates/apps/tally/src/balance.rs`
- `crates/apps/tally/src/commands.rs`
- `crates/apps/tally/src/door.rs`
- `crates/apps/tally/src/export_file.rs`
- `crates/apps/tally/src/lib.rs`
- `crates/apps/tally/src/manifest.rs`
- `crates/apps/tally/src/phone.rs`
- `crates/apps/tally/src/queries.rs`
- `crates/apps/tally/src/views.rs`
- `crates/apps/tally/tests/door.rs`
- `crates/apps/tally/tests/parity.rs`
- `crates/apps/tally/tests/queries_parity.rs`
- `crates/apps/tally/tests/year3.rs`
- `crates/core/src/app_query/tally.rs`
- `crates/core/src/app_query/tally_tests.rs`
- `crates/nativetools/tests/phase9_nt14.rs`
- `crates/vault/src/commands/tally.rs`
- `crates/vault/tests/tally_commands.rs`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tally/TallyParts.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tally/TallyRoutes.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tally/TallyScreens.kt`
- `mobile/core/src/jvmTest/kotlin/dev/centraid/core/TallyQueryRoundTripSpec.kt`
- `mobile/iosApp/Sources/Tally/TallyDetailViews.swift`
- `mobile/iosApp/Sources/Tally/TallyEditorView.swift`
- `mobile/iosApp/Sources/Tally/TallyExportView.swift`
- `mobile/iosApp/Sources/Tally/TallyHomeView.swift`
- `mobile/iosApp/Sources/Tally/TallyLensViews.swift`
- `mobile/iosApp/Sources/Tally/TallyParts.swift`
- `mobile/iosApp/Sources/Tally/TallyScreens.swift`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/TallyCopy.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyBridges.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyEditorMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyExpenseMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyExport.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyFold.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyFriendMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyGroupMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyHomeMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyLenses.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyQuery.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallySettleUpMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallySplit.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/TallyExportSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/TallyScreensSpec.kt`

**Modified** (291):
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `Cargo.lock`
- `Cargo.toml`
- `DESIGN.md`
- `README.md`
- `contracts/README.md`
- `contracts/apps/people/README.md`
- `contracts/assist/export/errors.json`
- `contracts/assist/export/kind_card.txt`
- `contracts/assist/export/metadata.json`
- `contracts/assist/export/prompt.compact.txt`
- `contracts/assist/export/prompt.full.txt`
- `contracts/assist/export/prompt.sig.txt`
- `contracts/assist/export/tools.full.json`
- `contracts/assist/export/tools.json`
- `contracts/ledgers/compile-time.json`
- `contracts/schema/v0-registries.json`
- `contracts/schema/vault-ddl.sql`
- `contracts/screens/home/content.bin`
- `contracts/screens/home/content.textproto`
- `contracts/screens/home/every-tile-unreadable.bin`
- `contracts/screens/home/every-tile-unreadable.textproto`
- `contracts/screens/home/first-run.bin`
- `contracts/screens/home/first-run.textproto`
- `contracts/screens/home/loading-first.bin`
- `contracts/screens/home/loading-first.textproto`
- `contracts/screens/home/status-urgent.bin`
- `contracts/screens/home/status-urgent.textproto`
- `contracts/screens/manifest.json`
- `contracts/screens/photos-shelf/album-selecting.textproto`
- `contracts/time/occurrence-cases.json`
- `contracts/tools/build-screen-fixtures.ts`
- `contracts/tools/export-design-corpus.ts`
- `contracts/tools/export-native-catalog.ts`
- `contracts/tools/time-corpus-cases.ts`
- `copy/chat.json`
- `copy/notes.json`
- `copy/shared.json`
- `crates/api-proto/build.rs`
- `crates/api-proto/proto/centraid/core/v1/app_query.proto`
- `crates/api-proto/proto/centraid/core/v1/assist.proto`
- `crates/api-proto/proto/centraid/core/v1/container.proto`
- `crates/api-proto/proto/centraid/core/v1/query.proto`
- `crates/api-proto/proto/centraid/core/v1/vault_search.proto`
- `crates/api-proto/proto/centraid/screen/v1/screen.proto`
- `crates/api-proto/tests/roundtrip.rs`
- `crates/apps/kit/README.md`
- `crates/apps/kit/src/changes.rs`
- `crates/apps/kit/src/fixtures.rs`
- `crates/apps/kit/src/grammar.rs`
- `crates/apps/kit/src/manifest.rs`
- `crates/apps/kit/src/money.rs`
- `crates/apps/kit/src/reads.rs`
- `crates/apps/kit/src/spelling.rs`
- `crates/apps/kit/src/statement.rs`
- `crates/apps/kit/src/testdoor.rs`
- `crates/apps/kit/tests/keyset_properties.rs`
- `crates/apps/notes/manifest.json`
- `crates/apps/notes/src/cards.rs`
- `crates/apps/notes/src/lib.rs`
- `crates/apps/notes/src/manifest.rs`
- `crates/apps/notes/src/queries.rs`
- `crates/apps/notes/tests/library.rs`
- `crates/apps/notes/tests/parity.rs`
- `crates/apps/people/README.md`
- `crates/apps/people/manifest.json`
- `crates/apps/people/src/commands.rs`
- `crates/apps/people/src/lib.rs`
- `crates/apps/people/src/manifest.rs`
- `crates/apps/people/src/person.rs`
- `crates/apps/people/src/queries.rs`
- `crates/apps/people/tests/copy.rs`
- `crates/apps/people/tests/parity.rs`
- `crates/apps/people/tests/three_state.rs`
- `crates/apps/people/tests/year3.rs`
- `crates/assist/Cargo.toml`
- `crates/assist/src/app.rs`
- `crates/assist/src/native/act.rs`
- `crates/assist/src/native/block.rs`
- `crates/assist/src/native/compile.rs`
- `crates/assist/src/native/compose.rs`
- `crates/assist/src/native/door.rs`
- `crates/assist/src/native/failsoft.rs`
- `crates/assist/src/native/ground.rs`
- `crates/assist/src/native/meta.rs`
- `crates/assist/src/native/park.rs`
- `crates/assist/src/native/prompt.rs`
- `crates/assist/src/native/recover.rs`
- `crates/assist/src/native/render.rs`
- `crates/assist/src/native/search.rs`
- `crates/assist/src/native/session.rs`
- `crates/assist/src/native/think.rs`
- `crates/assist/src/native/values.rs`
- `crates/assist/src/native/whr.rs`
- `crates/assist/src/native/world.rs`
- `crates/assist/src/native_turn/cards.rs`
- `crates/assist/src/native_turn/mod.rs`
- `crates/assist/src/native_turn/pending.rs`
- `crates/assist/src/native_turn/words.rs`
- `crates/assist/src/suggest.rs`
- `crates/assist/src/turn.rs`
- `crates/centraid/src/bin/seed-demo-vault.rs`
- `crates/core-ffi/CONTRACT.md`
- `crates/core-ffi/tests/assist.rs`
- `crates/core/Cargo.toml`
- `crates/core/README.md`
- `crates/core/src/api.rs`
- `crates/core/src/app_query.rs`
- `crates/core/src/app_query/docs.rs`
- `crates/core/src/app_query/docs_tests.rs`
- `crates/core/src/app_query/locker.rs`
- `crates/core/src/app_query/named.rs`
- `crates/core/src/app_query/notes.rs`
- `crates/core/src/app_query/people.rs`
- `crates/core/src/app_query/photos.rs`
- `crates/core/src/app_query/tasks.rs`
- `crates/core/src/app_query/tasks_tests.rs`
- `crates/core/src/app_query/vault.rs`
- `crates/core/src/assist/door.rs`
- `crates/core/src/example.rs`
- `crates/core/src/starters.rs`
- `crates/core/tests/assist_door.rs`
- `crates/core/tests/assist_native.rs`
- `crates/core/tests/assist_plane.rs`
- `crates/core/tests/common/chat.rs`
- `crates/core/tests/records_backup.rs`
- `crates/design/README.md`
- `crates/design/src/copy.rs`
- `crates/design/src/lib.rs`
- `crates/design/tests/copy_routes.rs`
- `crates/design/tests/corpus.rs`
- `crates/nativetools/Cargo.toml`
- `crates/nativetools/src/error_examples.json`
- `crates/nativetools/src/seed.rs`
- `crates/nativetools/src/vaultio.rs`
- `crates/nativetools/tests/cli.rs`
- `crates/nativetools/tests/common/drive.rs`
- `crates/nativetools/tests/fixes.rs`
- `crates/nativetools/tests/fixtures/world.json`
- `crates/nativetools/tests/locker_off.rs`
- `crates/nativetools/tests/meta.rs`
- `crates/nativetools/tests/observations.rs`
- `crates/nativetools/tests/park_card.rs`
- `crates/nativetools/tests/park_confirm.rs`
- `crates/nativetools/tests/phase2_grounding.rs`
- `crates/nativetools/tests/phase2_session.rs`
- `crates/nativetools/tests/phase2_status.rs`
- `crates/nativetools/tests/phase2_writes.rs`
- `crates/nativetools/tests/phase5_runtime.rs`
- `crates/nativetools/tests/phase6_block.rs`
- `crates/nativetools/tests/phase6_failsoft.rs`
- `crates/nativetools/tests/phase7_compose.rs`
- `crates/nativetools/tests/phase7_v4.rs`
- `crates/nativetools/tests/phase9_nt10.rs`
- `crates/nativetools/tests/phase9_nt12.rs`
- `crates/nativetools/tests/phase9_nt13.rs`
- `crates/nativetools/tests/phase9_nt15.rs`
- `crates/nativetools/tests/phase9_nt9b.rs`
- `crates/nativetools/tests/reanchor.rs`
- `crates/nativetools/tests/rulings.rs`
- `crates/nativetools/tests/seed.rs`
- `crates/nativetools/tests/tools.rs`
- `crates/nativetools/tests/verbs.rs`
- `crates/nativetools/tests/where_lang.rs`
- `crates/ontology/src/registries.rs`
- `crates/ontology/tests/commitments.rs`
- `crates/search/README.md`
- `crates/search/src/domains.rs`
- `crates/search/src/lib.rs`
- `crates/search/src/named.rs`
- `crates/search/src/sqlite.rs`
- `crates/search/tests/door.rs`
- `crates/vault/src/access.rs`
- `crates/vault/src/chat.rs`
- `crates/vault/src/commands/chat.rs`
- `crates/vault/src/commands/core.rs`
- `crates/vault/src/commands/core_links.rs`
- `crates/vault/src/commands/locker.rs`
- `crates/vault/src/commands/mod.rs`
- `crates/vault/src/commands/people.rs`
- `crates/vault/src/commands/schedule.rs`
- `crates/vault/src/custody/locker_key.rs`
- `crates/vault/src/lib.rs`
- `crates/vault/src/migrations.rs`
- `crates/vault/src/time/occurrence.rs`
- `crates/vault/src/time/recurrence.rs`
- `crates/vault/tests/backup_v2_rung.rs`
- `crates/vault/tests/baseline.rs`
- `crates/vault/tests/chat_proposals.rs`
- `crates/vault/tests/chat_schema.rs`
- `crates/vault/tests/collection_kind.rs`
- `crates/vault/tests/commands.rs`
- `crates/vault/tests/common/mod.rs`
- `crates/vault/tests/docs_commands.rs`
- `crates/vault/tests/money_schema.rs`
- `crates/vault/tests/one_hash.rs`
- `crates/vault/tests/people_commands.rs`
- `crates/vault/tests/search_coverage.rs`
- `crates/xtask/src/gate.rs`
- `crates/xtask/src/measure.rs`
- `crates/xtask/src/rules.rs`
- `design/identity-corpus.json`
- `design/native-catalog.json`
- `docs/decisions.md`
- `docs/glossary.md`
- `docs/vault-ontology.md`
- `mobile/README.md`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/MainActivity.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/Rooms.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/Rows.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/SearchField.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/HomeScreen.kt`
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/theme/Theme.kt`
- `mobile/core/src/jvmTest/kotlin/dev/centraid/core/AbiRoundTripSpec.kt`
- `mobile/iosApp/Design/Catalog.swift`
- `mobile/iosApp/Sources/CentraidApp.swift`
- `mobile/iosApp/Sources/Chat/ChatPreview.swift`
- `mobile/iosApp/Sources/Chat/ChatRouting.swift`
- `mobile/iosApp/Sources/Chat/ChatView.swift`
- `mobile/iosApp/Sources/FirstLaunchView.swift`
- `mobile/iosApp/Sources/HomeView.swift`
- `mobile/iosApp/Sources/Icon.swift`
- `mobile/iosApp/Sources/Kit/CentraidSearchField.swift`
- `mobile/iosApp/Sources/Kit/Money.swift`
- `mobile/iosApp/Sources/Kit/Rooms.swift`
- `mobile/iosApp/Sources/Kit/ScreenRegistry.swift`
- `mobile/iosApp/Sources/ShellModel.swift`
- `mobile/iosApp/Sources/VaultHeader.swift`
- `mobile/iosApp/Tests/ScreenFixtureTests.swift`
- `mobile/maestro/flows/home.yaml`
- `mobile/maestro/flows/selectors.md`
- `mobile/scripts/demo-vault.sh`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/design/Catalog.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/ChatCopy.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/NotesCopy.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/SharedCopy.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaBridge.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/locker/LockerQuery.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesLinkPicker.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotoShelfMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotosMemoriesMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotosPeopleReads.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotosReads.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PlacesMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/chat/ChatMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/ScreenBridge.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/SearchContainers.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/Navigation.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/RowRoutes.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/screen/ScreenHost.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/screen/ScreenMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeMachine.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeReads.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeSearch.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeSession.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/SpringboardPolicy.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/ChangeStream.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/ScreenQueries.kt`
- `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/ScreenRuntime.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaHomeSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AppReadsSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/CatalogSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ChatMachineSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeMachineSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeNoVaultSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeReadsSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeSearchSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/KitLawsSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/KitTimeMoneyCopySpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/NativeThemeSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/NavigationAndMountSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/NotesAppSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/PeopleSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/PerAppLayoutSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/PhotoShelfSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ScreenFixtureSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ScreenQueryRuntimeSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/SearchContainersSpec.kt`
- `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ShellCommandsExistSpec.kt`
- `packages/design/src/apps.ts`
- `packages/design/src/format.ts`
- `scripts/docs-site/src/content/apps.html`
- `scripts/docs-site/src/content/data.html`
- `scripts/docs-site/src/content/ontology-body.html`
- `scripts/docs-site/src/content/start.html`
- `scripts/docs-site/src/content/understand.html`
- `scripts/docs-site/src/pages/apps.astro`
- `scripts/home-site/public/index.html`
- `scripts/lint-copy.mjs`
- `scripts/security/rust-unsafe-ledger.json`
