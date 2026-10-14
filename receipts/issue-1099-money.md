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
