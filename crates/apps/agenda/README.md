# `crates/apps/agenda` — the calendar, and the one recurrence engine

Agenda is **4 manifest queries plus the core's by-id `event` read, 7 actions, 17 scopes (10 reads, 7 acts)** — the smallest scope set of any app, and the only one besides People that takes `read+act` over a whole schema ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

## What is here

| File | What it owns |
| --- | --- |
| `manifest.json` | the app's manifest: queries, actions and scopes |
| `src/manifest.rs` | the parse, and the claims the manifest makes about itself |
| `src/queries.rs` | the four queries: statements as data, and the folds over them. `search` from a term asks `crates/search`'s FTS door (`load_search_term`) and folds its hits (`load_search`). Every row carries `location_name`, its place's name. The reads are one table at a time: the window's `event` rows, then the entity, guests (`attendee` edges), overrides (`occurrence`) and calendars of the ids it named, joined here ([R-1135-4-8](../../../docs/decisions.md#lane-4--agenda-1135)) |
| `src/detail.rs` | `load_event`: one event, or one occurrence named by `original_start_local` or `instance_key`, by id — the detail screen's read ([#1029](https://github.com/srikanth235/centraid/issues/1029)); absent for an unknown, trashed or skipped one. It also carries the event's calendar row (#1047). `next_occurrence` names the occurrence a repeating search hit opens: the first at or after the vault clock within a year, else the last before it. |
| `src/expansion.rs` | the recurrence FOLD — one row per occurrence, and the cap |
| `src/local.rs` | where an occurrence falls in a stated zone: its local wall clock, the civil days it occupies (a timed end exclusive, an all-day end inclusive), today and now — what the core answers a shell with no calendar |
| `src/window.rs` | `occurrences`: the occurrences that occupy a range of local days (`YYYY-MM-DD` in a stated zone), series expanded, cancelled and trashed left out, each with its `Placement` — `upcoming` and `local::place` composed for a reader that only needs what is on when. The assistant runtime's read model reaches it through `Door::events` (the harness over a vault file, the core over the phone's vault), so it cannot disagree with this tab ([#1088](https://github.com/srikanth235/centraid/issues/1088), R-1088-8) |
| `src/commands.rs` | the seven actions, as a table of command invocations |

## The five things this app is about

1. **A repeating event is one row and many occurrences.** `upcoming` materialises a series into one row per occurrence inside the visible range, each carrying the **series' real `event_id`** — reschedule, cancel, RSVP and attach all still target the series — plus an `instance_key` for list render.
2. **The occurrence's identity is its wall clock** (#996 R21, drift ONT-25). `instance_key` and `original_start_local` are the series-local wall clock, never the resolved instant, and the column is spelled once, in `centraid_vault::time::occurrence`.
3. **The recurrence subset is refused, never dropped.** A rule outside `FREQ ∈ DAILY|WEEKLY|MONTHLY|YEARLY` with `INTERVAL/COUNT/UNTIL/BYDAY` expands to nothing, and the anchor stays visible rather than the event vanishing from the agenda.
4. **Two windows, one range.** Events are fetched from before `from` so multi-day spans arrive and the filter re-applies the true lower bound to every row, an expanded occurrence included — v0 bounded only one-offs, and `tests/parity.rs` names the reach-back rows its goldens carry (`ENDED_BEFORE_FROM_PER_CASE`); recurring anchors live in the past and are read separately, capped at `RECURRING_ANCHOR_CAP`. **Neither window reads the trash** (`deleted_at IS NULL`, [#1046](https://github.com/srikanth235/centraid/issues/1046)) — v0's did, and `tests/parity.rs` names the one golden row that encodes it (`TRASHED_IN_V0`).
5. **Civil time is the vault's, never the host's.** A gateway on a VPS runs UTC; a series expands in its own `start_tz`, resolved through the one `FireZone` cron already used. A screen's civil time — which local day, what clock time, today, now — is the zone the request states, passed to `load_upcoming` and `load_day_context` and read by `src/local.rs`.

## How a command states an event's times

`event.propose`, `event.edit` and `event.edit_occurrence` take `starts`/`ends` in one of four shapes (`crates/vault/src/commands/event.rs`, [R-1135-4-3](../../../docs/decisions.md#lane-4--agenda-1135)):

| Input | `starts` / `ends` | Stored |
| --- | --- | --- |
| an instant with `zone` | `…Z` and an IANA name | verbatim, `timing = "zoned"` |
| a wall clock with `zone` | `YYYY-MM-DDTHH:MM[:SS]` in that zone | the resolved instant, `timing = "zoned"` |
| `timing: "floating"` | a wall clock, no zone | verbatim: 09:00 wherever the member is |
| `timing: "all-day"` | dates; `ends` is the LAST day | verbatim |

An instant with no zone, an unknown zone and a wall clock the zone skips are refused; one it repeats takes the earlier instant. A timed end must not precede its start. A series' days are overridden by `event.edit_occurrence` (`override`, `skip`, `restore`; scope `occurrence` or `future`, [R-1135-4-1](../../../docs/decisions.md#lane-4--agenda-1135)), keyed by the series-local wall clock.

## The bounds, and where each one is stated

| Constant | Value | What it bounds |
| --- | --- | --- |
| `EVENT_WINDOW_CAP` | 2,000 | one visible range's event window |
| `RECURRING_ANCHOR_CAP` | 1,000 | the second window: series anchors |
| `MAX_TOTAL_INSTANCES` | 1,500 | occurrences across ALL series, per read — **enforced during the expansion, and it errors at the size it reaches** |
| `MAX_RANGE_DAYS` | 400 | the calendar grid's widest range |
| `PARTY_CAP` | 2,000 | the grid's birthday rail |
| `TAG_CAP` | 5,000 | the star tags behind `inner` |

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
