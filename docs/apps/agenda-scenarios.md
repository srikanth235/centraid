# Agenda scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: Agenda · **north star**: Google Calendar ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `record-only`.
- **Graduation issue**: none yet; write-path holes tracked under [#864](https://github.com/srikanth235/centraid/issues/864).
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/agenda-week.mjs`; custodian `apps/desktop/tests/e2e/agenda.spec.ts`; viewer `apps/web/tests/e2e/agenda.spec.ts`.
- **Structural exclusions**: see `tests/matrix.json#appEngines`.

| Agenda scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| week origin journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/agenda-week.mjs` |
| designed pending/parked/offline/conflict/stale/dayone | — | ✅ | — | `packages/blueprints/apps/agenda/states.test.tsx` |
| view derivation | ✅ | — | — | `packages/blueprints/apps/agenda/views.test.ts` |
| edit-occurrence model | ✅ | — | — | `packages/blueprints/apps/agenda/edits.test.ts` |
| day-context copy | ✅ | — | — | `packages/blueprints/apps/agenda/day-context.test.ts` |
| a recurring event's reminder fires on each occurrence | — | — | — | **product-bug** (#864): `due-reminders.ts` never expands the rrule; the reminder fires once, on the anchor |
| recurring events keep wall-clock time across DST | — | — | — | **product-bug** (#864): no surface sends `start_tz`; occurrences drift +1h |
| a refused create (busy-overlap) keeps the typed draft | — | — | — | **product-bug** (#864): the refused create discards everything typed on web |
| an all-day recurring event lands on the day it names | — | — | — | **product-bug** (#864): all-day recurring lands a day early off UTC+0 |
| "edit this occurrence" keeps every field that was set | — | — | — | **product-bug** (#864): the occurrence edit drops 5 of 8 fields |
| multi-day events stay visible on every day they span | — | — | — | **product-bug** (#864, S2): multi-day visibility is wrong |
