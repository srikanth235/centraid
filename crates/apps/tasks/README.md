# `crates/apps/tasks` — two queries, one promotion rule, no ceiling

Tasks is 8,005 lines of v0 TypeScript: **2 queries, 11 actions, 22 scopes** — the smallest surface of any app (#1020, wave 4 census §A7).

## What is here

| File | What it owns |
| --- | --- |
| `manifest.json` | `packages/blueprints/apps/tasks/app.json`, byte for byte |
| `src/manifest.rs` | the parse, and the claims the manifest makes about itself |
| `src/board.rs` | `nest_task_families` — the promotion rule, as a pure fold — and the open board's order |
| `src/queries.rs` | `board` and `search`: statements as data, and the folds |
| `src/commands.rs` | the eleven actions, as a table of command invocations |

## The five things this app is about

1. **The board is a bounded window, never a whole-table pull** (#262): newest open tasks by `created_at`, caller-sized, plus the 50 most recently closed as the logbook.
2. **`truncated` is the open page's own cursor** — it exists or it does not (#996 R8). `rows.length >= window` cannot tell a window that filled exactly from one that ran out, and the manifest states the rule as a contract: this is the one place in the tree where it does.
3. **An unfinished child of a closed parent is promoted** onto the open board. Completing the parent must not hide remaining work, and the logbook parent then keeps only its closed children so no row is drawn twice.
4. **There is no module-level ceiling.** The caller's `limit` (20…500) is the only bound. **A port that adds one is adding a refusal v0 does not have**, so this crate declares none and a test says so.
5. **Completion is one operation, and it is the vault's** (`centraid_vault::operations::task_lifecycle`). People, automations and an import complete the same row through the same code, and the recurrence rollover is part of it (#996 R21, ONT-27).

## The order the open board is in

Due first, then priority (higher is more urgent, `0` is unset), then title — and then **the primary key**. v0 leaves a full tie to `toSorted`'s stability, which is the order the read happened to return: a fact about the page rather than about the data. The pk tiebreak fires only where v0's answer was arbitrary, and it makes the board reproducible (lane V's nullable-sort finding, adopted here and by People).

`completed_at` is NULLABLE — cancelling a task clears it — so the logbook is read as ONE page and never continued: a keyset page over a nullable sort column silently drops rows, and `KitError::NullableSortKey` is what refuses one.

## What stops this crate doing more than it should

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement` |
| A module-level ceiling | `BOARD_MIN`/`BOARD_MAX` are the MANIFEST's declared window, read off it in a test |
| A second recurrence engine or summariser | `queries` calls `centraid_vault::time` |
| A denial turned into an error | `Denial` is a value both queries answer beside their payload |

## Running it

```sh
cargo test -p centraid-apps-tasks                      # unit + parity + year-3
cargo test -p centraid-apps-tasks --test year3 -- --ignored --nocapture
```

The parity fixtures under `contracts/apps/tasks/` are **generated from v0**:

```sh
CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
  tests/quality/tasks-parity.contract.test.ts
bun run format && git diff --exit-code contracts/apps/tasks
```
