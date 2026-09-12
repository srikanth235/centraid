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

## What a budget still needs

- A number on the reference devices, on release builds, through the C ABI — wave 3's, per the issue's Tooling coverage section: host numbers "prove nothing about a phone".
- The journey-ledger row `tally/dashboard/year3-tally/<device>` with the absolute target, which is the root's to write.
- The same volume seeded through `Vault::invoke` rather than through rows, so the ceiling is measured over the write path a member actually creates it with.
