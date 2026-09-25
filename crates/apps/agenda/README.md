# `crates/apps/agenda` — the calendar, and the one recurrence engine

Agenda is **4 manifest queries plus the core's by-id `event` read, 7 actions, 14 scopes** — the smallest scope set of any app, and the only one besides People that takes `read+act` over a whole schema ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

## What is here

| File | What it owns |
| --- | --- |
| `manifest.json` | the app's manifest: queries, actions and scopes |
| `src/manifest.rs` | the parse, and the claims the manifest makes about itself |
| `src/queries.rs` | the four queries: statements as data, and the folds over them. `search` from a term asks `crates/search`'s FTS door (`load_search_term`) and folds its hits (`load_search`). Every row carries `location_name`, its place's name (the `core.place` read scope) |
| `src/detail.rs` | `load_event`: one event, or one occurrence named by `original_start_local` or `instance_key`, by id — the detail screen's read ([#1029](https://github.com/srikanth235/centraid/issues/1029)); absent for an unknown, trashed or skipped one |
| `src/expansion.rs` | the recurrence FOLD — one row per occurrence, and the cap |
| `src/local.rs` | where an occurrence falls in a stated zone: its local wall clock, the civil days it occupies (a timed end exclusive, an all-day end inclusive), today and now — what the core answers a shell with no calendar |
| `src/commands.rs` | the seven actions, as a table of command invocations |

## The five things this app is about

1. **A repeating event is one row and many occurrences.** `upcoming` materialises a series into one row per occurrence inside the visible range, each carrying the **series' real `event_id`** — reschedule, cancel, RSVP and attach all still target the series — plus an `instance_key` for list render.
2. **The occurrence's identity is its wall clock** (#996 R21, drift ONT-25). `instance_key` and `original_start_local` are the series-local wall clock, never the resolved instant, and the column is spelled once, in `centraid_vault::time::occurrence`.
3. **The recurrence subset is refused, never dropped.** A rule outside `FREQ ∈ DAILY|WEEKLY|MONTHLY|YEARLY` with `INTERVAL/COUNT/UNTIL/BYDAY` expands to nothing, and the anchor stays visible rather than the event vanishing from the agenda.
4. **Two windows, one range.** Events are fetched from before `from` so multi-day spans arrive and the filter re-applies the true lower bound to every row, an expanded occurrence included — v0 bounded only one-offs, and `tests/parity.rs` names the reach-back rows its goldens carry (`ENDED_BEFORE_FROM_PER_CASE`); recurring anchors live in the past and are read separately, capped at `RECURRING_ANCHOR_CAP`. **Neither window reads the trash** (`deleted_at IS NULL`, [#1046](https://github.com/srikanth235/centraid/issues/1046)) — v0's did, and `tests/parity.rs` names the one golden row that encodes it (`TRASHED_IN_V0`).
5. **Civil time is the vault's, never the host's.** A gateway on a VPS runs UTC; a series expands in its own `start_tz`, resolved through the one `FireZone` cron already used. A screen's civil time — which local day, what clock time, today, now — is the zone the request states, passed to `load_upcoming` and `load_day_context` and read by `src/local.rs`.

## How a command states an event's times

`schedule.propose_event`, `schedule.edit_event` and `schedule.edit_event_occurrence` take `dtstart`/`dtend` in one of two shapes (`crates/vault/src/commands/event_time.rs`, [#1029](https://github.com/srikanth235/centraid/issues/1029)):

| Input | `dtstart` / `dtend` | Stored |
| --- | --- | --- |
| no `tz` | an instant (`…Z`, with `start_tz` for a zoned series), a floating wall clock, or an all-day date with `recurrence_semantics: "all-day"` | verbatim |
| `tz` (IANA, e.g. `Asia/Kolkata`) | wall clocks in that zone, `YYYY-MM-DDTHH:MM[:SS]`, no `Z` or offset | the resolved instants, `start_tz = end_tz = tz`, `recurrence_semantics = "zoned"` |

`tz` is exclusive with `start_tz`, `end_tz` and a non-`zoned` `recurrence_semantics`; an unknown zone and a wall clock the zone skips (the spring gap) are refused, and one it repeats takes the earlier instant. A timed end must be after its start; **an all-day end is the last day, inclusive**, so a one-day all-day event has `dtend == dtstart` and that equality is admitted — for all-day only, on the series, occurrence and series-edit paths alike.

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
cargo test -p centraid-apps-agenda                     # unit + parity + trash + lower bound + year-3
cargo test -p centraid-apps-agenda --test year3 -- --ignored --nocapture
```

The parity fixtures under `contracts/apps/agenda/` are **frozen goldens** read by `tests/parity.rs`, captured from an independent implementation and never typed by hand — see [`contracts/README.md`](../../../contracts/README.md).
