# Tally's year-3 ceiling — the volume, the query, and the first numbers

This note states what Tally's ceiling **is**, so a budget can be set against it. It is not the budget: the journey ledger's row and its absolute targets are the root's, on the reference devices ([#1020](https://github.com/srikanth235/centraid/issues/1020), wave 0). What is here is the volume, the query, the cells it was measured on, and the two numbers this container produced — a **projected** provenance note that says the order of magnitude before wave 3 measures the real one on a phone.

## The volume

`centraid_apps_kit::fixtures::YEAR3_TALLY`, declared in one place so that changing it changes what year-3 Tally volume means repo-wide:

| Field | Value | Why this number |
| --- | --- | --- |
| `expenses` | 2,000 | Tally's own stated ledger window, `LEDGER_ROWS` |
| `sharers_per_expense` | 4 | 2,000 × 4 = 8,000 split rows, which is exactly `LEDGER_FAN_OUT`'s cap — the profile sits **on** the ceiling, not under it |
| `groups` | 40 | so a group's ledger is a fold over ~50 expenses, not over the whole file |
| `parties` | 200 | plus the owner; the rotation puts each party in several groups |
| `members_per_group` | 6 | owner plus five, so the pairwise matrix is 6 × 6 per group |
| `multi_payer_every` | 7 | one expense in seven has two payers, so the matched-off attribution is exercised at volume and not only in a unit test |
| `trashed_every` | 50 | 40 trashed expenses: the trash shelf is non-empty and the live window excludes them |
| `settlements` | 300 | real cash across the groups |
| `recurring` | 60 | standing orders, so the template window has rows |
| `currencies` | USD, EUR, JPY | three, one of them with **no minor unit**, so the formatter's exponent table is exercised |

Deterministic by seed (`YEAR3_DEFAULT_SEED = 679_003`, v0's own): a date is `start + index days`, an id is `prefix-000000`, and every choice comes from one seeded integer stream. Two runs of the same seed produce byte-identical rows.

The generator creates **no tables**: it is handed a connection carrying `contracts/schema/vault-ddl.sql`, so there is one copy of the model. Today it writes rows directly; when `crates/vault`'s command path lands it re-points at `Vault::invoke` and the row values do not change, because they are already the values the commands produce (resolved splits that sum to the amount, a full payer set including the degenerate single-payer row, a group-scoped currency every expense in it agrees with).

## The query

`load_tally` — seventeen statements, then the party resolution that depends on what the first sixteen named — plus `load_dashboard_extras`' three windows (trash, standing orders, occurrence exceptions). That is the whole read every Tally surface folds; the group ledger, the friend view, the activity feed and the export are folds over it, not second reads.

The fold measured beside it is the balance engine over every group: `group_net` and `group_pair_nets`, with the reconciliation property asserted on every row (each pair row sums to that member's net with the sign flipped).

## What was measured, and where

`crates/apps/tally/tests/year3.rs`, on `ci-linux-x64-4c` — 4 vCPU, 15 GB, a container, in-memory SQLite through `rusqlite` 0.32 bundled.

| Profile | `load_tally` + extras | balance fold (40 groups, 240 pair rows) |
| --- | --- | --- |
| `dev` (our crates unoptimised, dependencies at `opt-level = 2`) | 124 ms | 27 ms |
| `release` | 58 ms | 6 ms |

**These are not comparable to v0's 188 ms**, and the reason is the finding below, not the platform: the number on record for v0 was taken while its dashboard was reading 500 expenses, not 2,000.

## The two findings this volume produced

Both are recorded as **D-1020-D3-12** and both are v0 bugs the port does not reproduce.

1. **`MAX_PAGE_ROWS` silently halves a declared fan-out.** `paged-reads.ts` computes a ceiling as `pageSize × fanOutPages` and walks `pageSize` rows a page, but the window clamps every page to 500. Tally declares `LEDGER_FAN_OUT = {pageSize: 1000, fanOutPages: 8}` and states 8,000 rows; it reaches 4,000 and then throws a sentence naming 8,000. At this volume — 2,000 expenses with four sharers each, which is the window Tally's own ceiling is stated at — v0's `loadTally` **throws**. The port states its bounds at a page size of 500 (16 and 64 pages), so the stated ceilings are the reachable ones, and `FanOutBound::cap` reports the number it can reach.

2. **The ledger window is read as one page and clamped to a quarter of itself.** `loadTally` asks for `limit: LEDGER_ROWS` — 2,000 — as a single page and takes `.rows`, discarding the `next` cursor that says there are more (`queries/dashboard.ts:267-280`). The door clamps to 500. So the dashboard reads 500 expenses while declaring 2,000 and **folds a balance over them**, which is the failure its own doctrine names four lines earlier: _a balance derived from a silently short ledger is a WRONG NUMBER — not a slow screen._ Reproduced here: the ported statement returns 500 of 1,960 live expenses in one page. The port walks a stated window to its stated size (`centraid_apps_kit::reads::read_window`) and carries `filled` into `TallyData`, so a surface can say the ledger is longer than what was read. v0 has no such field and no way to know.

## Wave 4: the eight views, and the write path (#1020 lane Tally-finish)

`loadTally` is the read; a SCREEN is the read plus the fold that turns it into an answer, and until wave 4 nothing in the port measured the second half. `tests/year3.rs`'s second case answers all eight queries over the same seeded vault and times each separately, because they are not one number: the dashboard folds forty groups' nets, `search` decorates every matching row with its parties, and `export` walks the revision plane.

Three runs of `cargo test -p centraid-apps-tally --test year3 -- --nocapture`, on a container also compiling three other lanes:

| Answer | `dev` profile, `ci-linux-x64-4c` | Rows in the answer |
| --- | --- | --- |
| `load_tally` + the three extra pages | 107 / 107 / 127 ms | 1,960 live expenses, 8,000 split rows |
| balance fold (40 groups) | 23 / 23 / 22 ms | 240 pair rows |
| `dashboard` | 35 / 34 / 34 ms | 40 group cards |
| `group` | 10 / 9 / 9 ms | 40 ledger rows |
| `friend` | 29 ms | 15 ledger rows |
| `activity` | 42 / 39 / 40 ms | 2,260 entries |
| `search` (a term that matches every row) | 218 / 215 / 209 ms | 1,960 decorated rows |
| `export` (2,000 limit) | 3 ms | 40 expenses, and no revisions — see below |
| `matches` | 0 ms | 0 proposals |
| `history` | 0 ms | 0 revisions |

**Two of those ten numbers bound nothing yet, and had better say so.** `matches` reads `core_transaction` and `history` reads `core_entity_revision`, and the year-3 Tally axis in `crates/apps/kit::fixtures` writes neither table (`git grep -n 'core_transaction\|core_entity_revision' crates/apps/kit/src/fixtures.rs` — no hit). So both answered over an empty plane, `export` walked a revision plane with nothing in it, and 0 ms is the cost of the statement round trip rather than of the fold. The fix is to extend the axis with a settlement's transaction and an edited expense's revisions, which is listed below rather than left to be inferred from a suspiciously round number.

For `history` the parity fixture covers the fold and only the volume is missing: `queries.json` carries seven `history` cases and one of them answers three revisions of a trashed-and-edited expense. For `matches` **nothing covers the fold at any volume** — v0's own seed holds one `core_transaction` row, a bucket of one proposes nothing, and a second account with a second transaction is the finance plane's writer rather than any of Tally's 23 commands. That is why the pairing fold is extracted as `views::match_proposals` and asserted over constructed rows in `views.rs`'s unit tests: the same-account skip, the amount and currency buckets, the already-answered pair, the unparseable posting date, the window boundary either side, and the nearest-first order. A generated fixture that answers `[]` would have covered none of it.

**A port bug this measurement found, in this lane's own code.** The first run read 277 ms for the dashboard, and the cause was `group_card` calling `data.balance_data()` per card: the fold is over every expense, so forty cards folded the whole ledger forty times. Folding once for the screen and passing it in took the dashboard to 34 ms. v0 does not have this bug — it passes `data` and folds inside `groupNet` — so it was the port's, and it was invisible at fixture volume.

### The write path

`tests/door.rs` (with `--features vault-door`) drives 200 `tally.add_expense` calls through the real `Commands` door, which means the whole gate order per write: the invocation row, every precondition, the handler's statements, the postconditions, the receipt and the explanation.

| Path                            | `dev` profile, `ci-linux-x64-4c` |
| ------------------------------- | -------------------------------- |
| `tally.add_expense`, 200 writes | 889 ms total, **4.45 ms each**   |

That is the number the last bullet below asked for, at a two-hundredth of the volume: seeding all 2,000 through the command path would be ~9 s in a `dev` build, which is a nightly's job rather than a test's.

## What a budget still needs

- A number on the reference devices, on release builds, through the C ABI — wave 3's, per the issue's Tooling coverage section: host numbers "prove nothing about a phone".
- The journey-ledger row `tally/dashboard/year3-tally/<device>` with the absolute target, which is the root's to write.
- The full 2,000-expense volume seeded through the command path rather than through rows, as a nightly rather than a test.
- A `core_transaction` and a `core_entity_revision` axis in `crates/apps/kit::fixtures`' year-3 shape, so that `matches` and `history` are timed over a populated plane instead of an empty one. Both tables belong to planes other than Tally's, so the axis is the kit's to grow and the shape of the rows is the finance and revision lanes' to state — an owner hand-off, not a number to invent here.
