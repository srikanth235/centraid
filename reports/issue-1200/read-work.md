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
