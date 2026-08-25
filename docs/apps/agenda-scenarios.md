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
| a recurring event's reminder fires on each occurrence | ✅ | — | — | `packages/server/src/reminders/due-reminders.test.ts`: rrule expansion keys a fire per occurrence |
| recurring events keep wall-clock time across DST | ✅ | — | — | `packages/blueprints/apps/agenda/format-locale.test.ts`: create/edit send `start_tz` |
| a refused create (busy-overlap) keeps the typed draft | — | ✅ | — | `packages/blueprints/apps/agenda/states.test.tsx`: the composer stays open unless propose settles |
| an all-day recurring event lands on the day it names | ✅ | — | — | `packages/blueprints/apps/agenda/format-locale.test.ts`: all-day writes store civil `YYYY-MM-DD` |
| "edit this occurrence" keeps every field that was set | ✅ | — | — | `packages/blueprints/apps/agenda/edits.test.ts`: occurrence payload keeps all eight fields |
| multi-day events stay visible on every day they span | ✅ | — | — | `packages/blueprints/apps/agenda/views.test.ts` (`bucketByDay`) |
