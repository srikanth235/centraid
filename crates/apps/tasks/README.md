# `crates/apps/tasks` — the board, one task, search, one promotion rule, no ceiling

Tasks' manifest declares **2 queries, 11 actions, 22 scopes** — the smallest surface of any app ([#1020](https://github.com/srikanth235/centraid/issues/1020)). The phone reaches it through `crates/core`'s `app_query` ([#1046](https://github.com/srikanth235/centraid/issues/1046)): five typed arms (`tasks.proto` — board, task, projects, search, catch-up) run this crate's loaders in the core and answer every civil reading in the zone the device states.

## What is here

| File | What it owns |
| --- | --- |
| `manifest.json` | the app's manifest: queries, actions and scopes |
| `src/manifest.rs` | the parse, and the claims the manifest makes about itself |
| `src/board.rs` | `nest_task_families` — the promotion rule, as a pure fold — and the open board's order |
| `src/queries.rs` | `board`, `task`, `search` (from a term, through the FTS door) and the chrome: statements as data, and the folds |
| `src/local.rs` | a task's civil readings in one zone: its due's local day and time, days from today, overdue, lands today, the reminder's wall clock |
| `src/views.rs` | what each place shows — Today, Upcoming, Inbox, Anytime, All, Logbook, Reminders, one project — and the counts and Catch up's piles |
| `src/commands.rs` | the thirteen actions, as a table of command invocations |

## The five things this app is about

1. **The board is a bounded window, never a whole-table pull** (#262): newest open tasks by `created_at`, caller-sized, plus the 50 most recently closed as the logbook.
2. **`truncated` is the open page's own cursor** — it exists or it does not (#996 R8). `rows.length >= window` cannot tell a window that filled exactly from one that ran out, and the manifest states the rule as a contract: this is the one place in the workspace where it does.
3. **An unfinished child of a closed parent is promoted** onto the open board. Completing the parent must not hide remaining work, and the logbook parent then keeps only its closed children so no row is drawn twice.
4. **There is no module-level ceiling.** The caller's `limit` (20…500) is the only bound. **Adding one would add a refusal the contract does not have**, so this crate declares none and a test says so.
5. **Completion is one operation, and it is the vault's** (`centraid_vault::operations::task_lifecycle`). People, automations and an import complete the same row through the same code, and the recurrence rollover is part of it (#996 R21, ONT-27).

## The trash is not the board

`schedule.delete_task` trashes a task and every subtask under it (`deleted_at`, `purge_at`). Every statement over `schedule_task` says `deleted_at IS NULL` (`queries::LIVE`), so a trashed task is on no place, in no search, never promoted as an orphan, and opens no detail. The `purge` action (`schedule.purge_task`, #1015 D1, confirmation required) destroys a trashed task and the subtasks trashed with it through the entity supertype, so every link, tag and annotation on them goes too; a subtask restored on its own is promoted to the top level rather than lost. The `restore` action (`schedule.restore_task`) brings a trashed task back with the subtasks trashed with it — the trash screen's one verb every app has.

## Civil time is the device's

A `due_at` is a civil date (`YYYY-MM-DD`, the same day in every zone) or an instant (read on the request zone's calendar). The **effective due** is a repeating task's next open period, else its stored due. `local` places it against the device's today — counted in civil days, so a 23-hour spring-forward day is still one day — and `views` groups the places from those readings, with v0's arithmetic and two corrections: "today" is the device's day, never the UTC prefix, and Catch up's repeating pile holds only repeating work that is behind (v0 bulk-completed every open repeating task). A task's own `tz` is the zone its recurrence expands in, not the display zone.

`remind_before_min` is read back on every row, and `remind_at_local` is the due instant less the lead. **A date-only due has no moment to count back from, so it has no reminder time** — which moment a date-only reminder fires at is an owner question, not something this crate invents.

## The order the open board is in

Due first, then priority (higher is more urgent, `0` is unset — D-1020-S5, and the vault's `schedule` comment now says the same rather than RFC 5545's 1-highest), then title — and then **the primary key**. Leaving a full tie to sort stability would give the order the read happened to return: a fact about the page rather than about the data. The pk tiebreak fires only where the order would otherwise be arbitrary, and it makes the board reproducible (the same rule People adopts).

`completed_at` is NULLABLE — cancelling a task clears it — so the logbook is read as ONE page and never continued: a keyset page over a nullable sort column silently drops rows, and `KitError::NullableSortKey` is what refuses one.

## What stops this crate doing more than it should

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement` |
| A module-level ceiling | `BOARD_MIN`/`BOARD_MAX` are the MANIFEST's declared window, read off it in a test |
| A second recurrence engine or summariser | `queries` calls `centraid_vault::time` |
| A denial turned into an error | `Denial` is a value every loader answers beside its payload |
| An action input the vault refuses | a test reads every `schedule.*` action's declared input keys against its command's schema (`additionalProperties: false`) |

## Running it

```sh
cargo test -p centraid-apps-tasks                      # unit + parity + year-3
cargo test -p centraid-apps-tasks --test year3 -- --ignored --nocapture
```

The parity fixtures under `contracts/apps/tasks/` are **frozen goldens** read by `tests/parity.rs`, captured from an independent implementation and never typed by hand — see [`contracts/README.md`](../../../contracts/README.md).
