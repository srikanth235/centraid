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
