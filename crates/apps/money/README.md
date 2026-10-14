# `crates/apps/money` — accounts and transactions the member imports

Money is a personal-finance app: accounts, transactions that enter by **importing a bank statement**, categories by rule, spending by month ([#1099](https://github.com/srikanth235/centraid/issues/1099), [decisions](../../../docs/decisions.md#money-1099)). Its doctrine:

- one account is one currency; nothing sums across currencies;
- an imported transaction is never edited (a category and a void are the member's decisions);
- re-importing the same file writes nothing;
- the fuzzy duplicate pass only **proposes**;
- the statement's bytes are read once and never stored;
- every figure is derived at read time: **no stored balance or rollup**.

This README describes the import half (wave 2): `import` and `rules`. The queries, the action table and the manifest are wave 3.

## Modules

| Module | What it owns |
| --- | --- |
| `import::text` | Bytes to text: UTF-8 with a byte-order mark dropped, else windows-1252 (hand-written table; no encoding crate) |
| `import::csv` | `read_csv`: delimiter, header row (past a preamble, or none), column roles by header synonym **and** by content, the date order over the whole column, four sign modes, the header fingerprint and the saved `CsvProfile`. The tokeniser is the kit's (`centraid_apps_kit::csv`), shared with Locker |
| `import::ofx` | `read_ofx`: one tolerant scanner for OFX 1.x SGML, 2.x XML and Intuit QFX; one `OfxStatement` per `STMTRS`/`CCSTMTRS`; `resolve_account` matches a statement to an account by the last digits or the stored full id and refuses none or two |
| `import::amount`, `import::date` | Printed amounts (thousands marks, parentheses, `CR`/`DR`, currency marks) and printed dates; a cell is read to a value or refused, never guessed |
| `import::keys` | The dedupe key (R-1099-3): `ofx:<FITID>`, `ofx-nofitid:<hash>`, `csv:<64 hex>` over day, signed amount, raw description and ordinal within that triple |
| `import::plan` | `plan`: rules, then exact de-duplication (one-to-one), in-file repeats, then the fuzzy **proposal**; a verdict per row and the file's totals |
| `rules` | The rule semantics the vault's `apply_rule_to_history` agrees with (seam S2), the merchant key and the counting learner |
| `year3` | A deterministic generator: 4 accounts, 18,000 rows, as Chase-shaped CSV text |

## What this crate may not contain, and what stops it

| Not allowed | What stops it |
| --- | --- |
| **SQL, in any form** | `cargo xtask rules`' `sql-confinement` scans this crate. A write is a vault command; the plan returns values and writes nothing |
| **A provider SDK, an encoding, CSV, XML or hash crate beyond the workspace's** | the dependencies are the kit, `blake3`, `hex`, `serde`, `serde_json` and `thiserror` |
| **A guess at a date order** | `date::decide` counts the cells each order makes impossible over the whole column; a tie is `DateOrder::Ask` and the plan carries the question |
| **A blocked file for a bad row** | a bad row is a `ParsedRow` with `Err(RejectReason)` and its 1-based line |
| **A value in a log or a sentence** | `Refusal`, `RejectReason` and `StatementRefusal` sentences never quote the file |

## The numbers that are part of the contract

| Name | Value | What it bounds |
| --- | --- | --- |
| `IMPORT_ROWS` | 20,000 | data rows in one statement; more is a `Refusal::TooManyRows`, not a truncation (R-1099-7) |
| `IMPORT_BYTES` | 8 MiB | the file; more is a `Refusal::TooLarge` (R-1099-7) |
| `MAX_AMOUNT_MINOR` | 10^13 | one amount, so a file's sum stays inside `i64` |
| `FUZZY_DAYS` | 3 | the gap between a row and the existing row it may be proposed a duplicate of |
| `SIMILARITY_THRESHOLD` | 0.5 | bigram Dice of the two descriptions; see the constant's comment |
| `RULES` | 500 | rules a vault holds |
| `LEARNER_WINDOW` / `LEARNER_SUPPORT` | 5 / 3 | the counting learner proposes after 3 of a merchant's last 5 categorised rows agree |

## Dedupe and the fuzzy pass

The key is `external_id`, compared for equality only. A CSV row has none from the bank, so it is `csv:` and a BLAKE3 hash (the repo's one hash; `sha2` is confined to two other crates by the workspace manifest) of the printed day, the signed minor amount, the raw description and the **ordinal within that triple in the file**: the same weekly $9.99 on different days is distinct, and an identical pair on one day stays two rows. CRLF and LF exports of one statement hash alike.

The fuzzy pass is a proposal, never a write, and it is narrow on purpose: same direction and amount (exact), within three days, a description at least `SIMILARITY_THRESHOLD` alike, against an existing row nothing else has claimed, and never between two rows that both carry a bank's own, different `FITID`. There is no "dropped by a rule" verdict: rules set a category and a display name and nothing else.

## Date order

A column of slash dates that never has a day over 12 in either slot cannot be read: the statement carries a `DateOrderQuestion` (a few sample cells and the two orders) and **no rows**; the caller reads the file again with `CsvOptions::date_order` set to the member's answer. An answer cannot overrule a day the file proves. TD Canada's export is modelled as `MM/DD/YYYY`, as TD prints it.

## Tests

`tests/import_corpus.rs` reads the files under `tests/corpus/`: Chase, Amex, Capital One, Bank of America, Wells Fargo, TD, RBC and Tangerine layouts; QFX 1.x and OFX 2.x; windows-1252, a byte-order mark, CRLF and a quoted newline, parenthesised negatives, a `;` file with decimal commas; day-first files whose first row is ambiguous and that are wholly ambiguous; a weekly charge; the same file twice; two files overlapping by a week; a multi-account OFX; a currency mismatch; a bad `TRNAMT`; and the 20,001-row and 8 MiB + 1 refusals. Each case pins the exact `(day, signed amount, description)` of every row.
