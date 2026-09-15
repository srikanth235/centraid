# `crates/apps/agenda` — the calendar, and the one recurrence engine

Agenda is 7,818 lines of v0 TypeScript: **4 queries, 7 actions, 13 scopes** — the smallest scope set of any app, and the only one besides People that takes `read+act` over a whole schema (#1020, wave 4 census §A6).

## What is here

| File | What it owns |
| --- | --- |
| `manifest.json` | `packages/blueprints/apps/agenda/app.json`, byte for byte |
| `src/manifest.rs` | the parse, and the claims the manifest makes about itself |
| `src/queries.rs` | the four queries: statements as data, and the folds over them |
| `src/expansion.rs` | the recurrence FOLD — one row per occurrence, and the cap |
| `src/commands.rs` | the seven actions, as a table of command invocations |

## The five things this app is about

1. **A repeating event is one row and many occurrences.** `upcoming` materialises a series into one row per occurrence inside the visible range, each carrying the **series' real `event_id`** — reschedule, cancel, RSVP and attach all still target the series — plus an `instance_key` for list render.
2. **The occurrence's identity is its wall clock** (#996 R21, drift ONT-25). `instance_key` and `original_start_local` are the series-local wall clock, never the resolved instant, and the column is spelled once, in `centraid_vault::time::occurrence`.
3. **The recurrence subset is refused, never dropped.** A rule outside `FREQ ∈ DAILY|WEEKLY|MONTHLY|YEARLY` with `INTERVAL/COUNT/UNTIL/BYDAY` expands to nothing, and the anchor stays visible rather than the event vanishing from the agenda.
4. **Two windows, one range.** Events are fetched from before `from` so multi-day spans arrive and the filter re-applies the true lower bound; recurring anchors live in the past and are read separately, capped at `RECURRING_ANCHOR_CAP`.
5. **Civil time is the vault's, never the host's.** A gateway on a VPS runs UTC; a series expands in its own `start_tz`, resolved through the one `FireZone` cron already used.

## The bounds, and where each one is stated

| Constant | Value | What it bounds |
| --- | --- | --- |
| `EVENT_WINDOW_CAP` | 2,000 | one visible range's event window |
| `RECURRING_ANCHOR_CAP` | 1,000 | the second window: series anchors |
| `MAX_TOTAL_INSTANCES` | 1,500 | occurrences across ALL series, per read — **enforced during the expansion, and it errors at the size it reaches** |
| `MAX_RANGE_DAYS` | 400 | the calendar grid's widest range |
| `PARTY_CAP` / `TASK_CAP` | 2,000 | the grid's birthday rail and due-work shelf |
| `TAG_CAP` | 5,000 | the star tags behind `inner` |
| `SHELF_CAP` | 8 | a day's due shelf LISTS; it never pages |

## What stops this crate doing more than it should

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement` |
| A second recurrence engine | there is none here: `expansion` calls `centraid_vault::time::recurrence` |
| A raw RRULE shown to a member | `recurrence_summary` is `rrule::describe`'s sentence |
| A write from a query | a query holds statements and a `PageDoor`, whose one method reads |
| A denial turned into an error | `Denial` is a value every query answers beside its payload |

## Running it

```sh
cargo test -p centraid-apps-agenda                     # unit + parity + year-3
cargo test -p centraid-apps-agenda --test year3 -- --ignored --nocapture
```

The parity fixtures under `contracts/apps/agenda/` are **generated from v0** and never typed:

```sh
CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
  tests/quality/agenda-parity.contract.test.ts
bun run format && git diff --exit-code contracts/apps/agenda
```
