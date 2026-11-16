# Read work baseline (F1)

Revision at implementation: `3700e43ae` (`codex/1200-v0-refinement`). Counts below were measured on this local working revision, including the assigned instrumentation and tests.

## Reproduction

Use one Cargo lease and the task-specific target directory:

```sh
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo clippy -p centraid-screens --test read_work -- -D warnings
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo test -p centraid-screens --test read_work -- --nocapture
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo test -p centraid-apps-money --test year3 -- --nocapture
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo test -p centraid-screens --test read_work home_tile_reads_on_the_full_shared_year3_corpus -- --ignored --nocapture
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo test -p centraid-apps-money --test year3 eighteen_thousand_rows_follow_read_and_reconcile -- --ignored --nocapture
```

The screen test calls all nine production Home tile readers against a newly founded, empty vault and a representative shared year-three corpus. It prints each app/query request and a named collection-unit count in the typed response. The normal Home corpus has 600 notes, 250 documents, 1,200 photos, 120 people, 300 events, 600 tasks, 1,200 transactions, 50 Locker items, 250 workout activities, 365 health measurement days, 15 chat threads with 10 messages each, plus 300 revisions and the associated folders, notebooks, projects, albums, places, categories and tags. The ignored full shared profile raises these to 12,000 notes, 2,500 documents, 12,000 photos, 1,200 people, 3,000 events, 6,000 tasks, 12,000 transactions, 500 Locker items, 2,500 workout activities and 1,095 health measurement days. Measurements have six metric kinds per day. The generator includes rows for all of these domains, but that does not mean each Home tile's count is populated at the snapshot date.

The test fixture uses an RAII guard: it closes its `Driver` before removing the unique scratch directory, including on assertion or seeding failure. `Driver::over_handle` does not own or remove the caller's directory.

Both Home profiles use the `FixedClock` frozen at **2026-01-01 00:00 UTC**. The shared generator's `instant` spans a three-year interval beginning 2024-01-01 and ending late in 2026; the 365-day sample spaces its measurement days over that same interval. Calendar Upcoming reads its 15-day window from Jan 1; this is why it returns 17 sample and 163 full events. Reminders reads the Today board, but the corpus's task rows have no due fields, so its 600/6,000 tasks do not populate this tile: its zero is not a populated Reminders count-path measurement. Health returns its six metric slots even with no current-day measurement; full has two current-day workout entries. Photos, People, Notes, Locker and Docs response counts are bounded shelf/window rows. Money's Home response unit is currency spend lines, not transactions.

The Money year3 target includes an empty-vault case and the dedicated deterministic Money generator's unignored 4,500-line, one-account sample. Both call six Money screen readers and print page-statement calls and rows delivered to Money, grouped by query. The populated case retains the existing independent parsed-input arithmetic reconciliation and bounded-window assertions. The ignored dedicated Money profile is 18,000 lines across four accounts.

## Observed results

Home's nine apps made **11 load requests** in each corpus. `calendar.day-context` is asked twice: Calendar reads it for its own tile, then Notes reads it to place its journal window. This is a repeated read in the baseline.

| Home corpus | Query | Response units |
| --- | --- | --: |
| Empty | `calendar.day-context` (2 calls) | 0 birthdays each |
| Empty | `calendar.upcoming` | 0 events |
| Empty | `reminders.board` | 0 tasks |
| Empty | `photos.shelf` | 0 photo cells |
| Empty | `money.home-tile` | 0 currency spend lines |
| Empty | `health.today` | 6 metric slots, 0 Home tile count |
| Empty | `people.people` | 0 people |
| Empty | `locker.items` | 0 Locker items |
| Empty | `notes.library` | 0 notes |
| Empty | `docs.drive` | 0 documents |
| Sample | `calendar.day-context` (2 calls) | 0 birthdays each |
| Sample | `calendar.upcoming` | 17 events |
| Sample | `reminders.board` | 0 tasks due today |
| Sample | `photos.shelf` | 24 photo cells |
| Sample | `money.home-tile` | 1 currency spend line |
| Sample | `health.today` | 6 metric/workout response entries |
| Sample | `people.people` | 117 people |
| Sample | `locker.items` | 20 Locker items |
| Sample | `notes.library` | 200 notes |
| Sample | `docs.drive` | 50 documents |
| Full | `calendar.day-context` (2 calls) | 0 birthdays each |
| Full | `calendar.upcoming` | 163 events |
| Full | `reminders.board` | 0 tasks due today |
| Full | `photos.shelf` | 24 photo cells |
| Full | `money.home-tile` | 1 currency spend line |
| Full | `health.today` | 8 metric/workout response entries |
| Full | `people.people` | 1,168 people |
| Full | `locker.items` | 20 Locker items |
| Full | `notes.library` | 200 notes |
| Full | `docs.drive` | 50 documents |

Money page-door call and delivered-row totals per screen:

| Screen | Empty calls / rows | 4,500-line sample calls / rows | 18,000-line full calls / rows |
| --- | --: | --: | --: |
| Spending | 23 / 46 | 37 / 4,935 | 64 / 19,590 |
| Cash flow | 20 / 46 | 35 / 1,550 | 41 / 6,062 |
| Accounts | 8 / 46 | 21 / 4,550 | 51 / 18,062 |
| Recurring | 21 / 46 | 30 / 4,550 | 54 / 18,062 |
| Activity | 10 / 46 | 16 / 323 | 16 / 704 |
| Search | 0 / 0 | 14 / 110 | 14 / 122 |

The empty Money fixture is an empty ledger with no accounts, but founding leaves 23 built-in categories; that explains the 46 returned rows on most reads (23 category rows plus their 23 entity labels). Empty search uses the index and makes no page-door calls. At full size, Accounts reads all 18,000 ledger rows in 36 pages; Spending, Cash flow and Recurring each revisit transaction windows through multiple named query families. These observations nominate targets for F2 but do not establish lock contention or total SQL work.

## Evidence boundaries

- `page_statement_calls` is the number of calls through Money's existing `PageDoor` interface. Each call is one declared page statement execution. `TestDoor` also performs `pragma_table_xinfo` schema probes on continued pages; those are not included, so this number is not a total SQLite statement count.
- `delivered_rows` are rows returned from `TestDoor` to the Money reader after it discards the extra page-probe row. These are not SQLite rows visited or allocations.
- Home observation records the requests made for nine apps (11 total `load(app, query, params)` calls) and typed responses at the core boundary. The reported values are named response collection units (events, tasks, photo cells, currency spend lines, metric slots plus workouts, people, Locker items, notes, documents); in particular Money and Health counts are not transaction or measurement record counts. They are not underlying SQL rows, work, or allocations. The empty-vault test separately asserts that each Home tile's own count is zero.
- Neither path measures allocations. No lock-contention claim follows from these counts.

## Source identity and logs

The measurement was run before any F2 production changes, from base `3700e43ae` plus uncommitted F1 instrumentation. The three production read-path files below hash identically to base `3700e43ae`; the test and observer files include F1 edits. The full working tree did not have a single committed SHA. Source SHA-256 values at review time:

| Source | SHA-256 |
| --- | --- |
| `crates/apps/money/src/phone.rs` | `3f27f3f234d6d80ccfddd97a88aef59a6fff742529de4bf83c5c64457659ee5e` |
| `crates/apps/money/src/queries.rs` | `b4938b8dcacbf142f8fd67ea7d75abf49c0e0fd29bf85c656fc2ed7e881cd38d` |
| `crates/screens/src/shell/tiles.rs` | `0e269352a9bd26a362ca62a1b0f74274cdca9e25d822541b650488b346070167` |
| `crates/apps/money/tests/year3.rs` | `86d2892db5dfabbf2cf0d36eff662e8a31e02c91b00b21bf4ae96464aa9eb7cb` |
| `crates/screens/tests/read_work.rs` | `f9c9c5aab016209c178bf9a36a90fd9dc59ac238e12ea0d9bf6424c60e839964` |
| `crates/screens/src/testing.rs` | `a30e9218434a287d9c875e59f8198e644d558e20ef3b07b01d300fdcfcea17cc` |

The five Cargo commands above used `/private/tmp/centraid-1200-target`. Their output was captured in the task's command transcript; no separate stdout log files were saved.

## Status

The focused runs, scoped Clippy check and both ignored full profiles pass. The shared year-three generator is reused as-is, with the full profile isolated behind an ignored test. No duration assertion, allocation count, total SQLite statement count or contention evidence is claimed.

## F2 after: Accounts streaming fold

F1 remains the before measurement at committed revision `67ecd27f4` (the test-only read instrumentation commit). F2 was revalidated against committed `HEAD` `56dd3f9e4b0df93fd9d28cf3ce82e6ec9fec2bdf` plus the uncommitted Money changes below. No F1 values were edited. The same 4,500-row and 18,000-row generated profiles were rerun after the correctness fixes; arithmetic reconciliation still passes.

Accounts now loads only account metadata and checkpoints. Checkpoint currency uses the already loaded account list, avoiding its second `money.accounts` page. It streams each account's ledger in pages of at most 500 rows, folds directly through the engine's shared balance inclusion rule, and keeps only balance/checkpoint sums. Source-row count, not post-trash count, determines the unchanged 40,000-row boundary. A short page with a continuation is incomplete, preventing an empty/clamped page from looping. When the first ledger page is nonempty, Accounts loads the bounded trash-ID set once and reuses it for all accounts; empty ledgers and an empty account list do not request trash IDs.

The global 400-checkpoint page can omit an account's latest past checkpoint when newer rows from other accounts fill it. If that page has a continuation, Accounts requests a one-row, per-account lookup (`account_id = ? AND day <= today`) only for accounts without a known past checkpoint. This uses the checkpoint `(account_id, day)` primary key; the query-plan regression checks that it seeks that key without a temp sort. The selected checkpoint remains the newest one on or before `today`. An unrepresentable exact balance or checkpoint comparison is surfaced as unavailable via the existing optional balance/comparison, and net-worth arithmetic uses a wider interim sum before converting back to minor units; an unrepresentable final currency total is incomplete rather than clamped.

| Accounts corpus | F1 calls / delivered rows | F2 calls / delivered rows | F2 ledger pages / ledger rows | F2 trash reads / rows |
| --- | --: | --: | --: | --: |
| Empty ledger, no accounts | 8 / 46 | 1 / 0 | 0 / 0 | 0 / 0 |
| 4,500 rows, one account | 21 / 4,550 | 15 / 4,503 | 9 / 4,500 | 1 / 0 |
| 18,000 rows, four accounts | 51 / 18,062 | 42 / 18,012 | 36 / 18,000 | 1 / 0 |

The 18,000-row F2 read also returned four account rows, four account-name rows, four origin rows, and zero archived/checkpoint rows; those six metadata pages account for the other six calls. The 50 fewer delivered rows are the category, category-label, rule, transfer-link and duplicate account rows the Accounts screen did not use. The ledger rows were still all delivered, but no longer accumulated into one account-sized vector. In the year-three response reconciliation, every account balance and the USD net-worth sum still equal independent sums over the parsed source rows.

The empty-vault Accounts path makes just one page call for `money.accounts` and returns no accounts. The four-account profile makes one trash-ID page call rather than one per account. The test door's zero trash rows are included in these counts; these are not claims that no metadata probes or SQL work occurred.

### Bounds and semantic checks

`streamed_ledger_preserves_the_forty_thousand_row_probe_boundary` uses a scripted `PageDoor` with 39,999, 40,000 and 40,001 source rows. The final partial page at 39,999 is complete, exactly 40,000 is complete when its final cursor is absent, and 40,001 is incomplete when the final page advertises a next cursor; no 81st ledger page is requested. Each case returns at most 500 rows per page, and trash IDs are read once. A pending row among the 39,999 is excluded from the arithmetic but still counts toward the source-row ceiling. Separate short-page and empty-page-with-cursor cases return incomplete immediately with bounded call counts. These tests verify page/call/row counts, not allocations.

Accounts output regressions cover opening-day arithmetic, the newest checkpoint at or before today (a later checkpoint is ignored), agreement and delta, void rows, future rows, trash/restore, a closed EUR account, and separate EUR/USD net-worth lines. The 40,001-row synthetic boundary also verifies the resulting balance is unavailable and net worth is incomplete. The scripted 39,999-row case excludes a pending row while counting it against the source-row window; no live pending-row fixture or over-ceiling SQLite vault is present. The existing year-three parsed-row reconciliation covers the populated large profile. The engine's same `balance_row_included` predicate is used by both slice-based `account_balance` and the streaming fold, so posted/opening/as-of inclusion has one definition. The test suite provides no lock-contention or allocation evidence.

### Reproduction and provenance

All Cargo commands used `CARGO_TARGET_DIR=/private/tmp/centraid-1200-target`:

```sh
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo test -p centraid-apps-money --test vault
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo clippy -p centraid-apps-money --all-targets -- -D warnings
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo test -p centraid-apps-money --test year3 -- --nocapture
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo test -p centraid-apps-money --test year3 eighteen_thousand_rows_follow_read_and_reconcile -- --ignored --exact --nocapture
CARGO_TARGET_DIR=/private/tmp/centraid-1200-target cargo test -p centraid-core --test query_plans every_read_plans_without_a_table_scan_or_a_sort_unless_the_ledger_says_why -- --exact --nocapture
```

The corrected sample transcript was saved at `/private/tmp/centraid-1200-after-year3-sample-final.log`; the explicit corrected full-profile transcript was saved at `/private/tmp/centraid-1200-after-year3-full-final.log`. The full ignored profile passed with 18,000 rows across four accounts and retained the existing independent reconciliation. The focused vault suite passed 16 tests; scoped Money Clippy passed with `-D warnings`. The focused year-three query-plan test passed with the added per-account checkpoint fallback plan assertion.

Source SHA-256 values after F2 implementation and tests:

| Source | SHA-256 |
| --- | --- |
| `crates/apps/money/src/phone.rs` | `ace00a17ca7f25f7dfc700ac06b535aba3eb93435001c95f66d0c593826e40d9` |
| `crates/apps/money/src/queries.rs` | `5f6ce8b1dc529ce9b0ad2c12c855747c56c7af6ae5ee09087e9d170d566c2ad6` |
| `crates/apps/money/src/engine.rs` | `60ace81dab872f18e74f7776600405b8d79f73a296a7e950ce30338d7d2a4c84` |
| `crates/apps/money/tests/vault.rs` | `33913f10f78a887c8b848e7650440b8ac76763f833ad601cb3167242748a9095` |
| `crates/apps/money/tests/year3.rs` | `86d2892db5dfabbf2cf0d36eff662e8a31e02c91b00b21bf4ae96464aa9eb7cb` |
| `crates/core/tests/query_plans.rs` | `c0eca761adc6a388eaad579ad6c683661f9fceaef22d1651ff303c82a3f8c165` |

The report is a measurement note, not proof of lower total SQLite work: `PageDoor` calls exclude `TestDoor` schema probes, and result pages still contain up to 500 rows. No query grammar, schema, index, or stored balance changed.
