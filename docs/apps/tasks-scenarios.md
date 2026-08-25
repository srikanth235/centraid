# Tasks scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: Tasks · **north star**: Todoist ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `record-only`.
- **Graduation issue**: none yet; write-path holes tracked under [#864](https://github.com/srikanth235/centraid/issues/864).
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/tasks-board.mjs`; custodian `apps/desktop/tests/e2e/tasks.spec.ts`; viewer `apps/web/tests/e2e/tasks.spec.ts`. Shared replica overlay until a Tasks-specific native integration exists.
- **Structural exclusions**: see `tests/matrix.json#appEngines`.

| Tasks scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| board origin journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/tasks-board.mjs` |
| designed pending/parked/offline/conflict/stale | — | ✅ | — | `packages/blueprints/apps/tasks/states.test.tsx` |
| board derivation | ✅ | — | — | `packages/blueprints/apps/tasks/logic.test.ts` |
| route table | ✅ | — | — | `packages/blueprints/apps/tasks/routes.test.ts` |
| completing a parent leaves unfinished subtasks visible | — | — | — | **product-bug** (#864): completing/releasing a parent hides every unfinished subtask |
| catch-up "Release all" does not re-date the someday pile | — | — | — | **product-bug** (#864): Release all re-dates undated tasks into Today irreversibly |
| a HOUSE-scope write stays in the HOUSE scope | — | — | — | **product-bug** (#864): `act()` never passes `scope`, so every write targets the wrong scope |
| delete-confirm removes the row, it does not cancel it | — | — | — | **product-bug** (#864): confirm copy promises removal but the handler sets `status:cancelled` |
| priority scale matches the north star | — | — | — | **product-bug** (#864, S2): priority scale is inverted versus Todoist |
| "Today" is the member's day, not UTC | — | — | — | **product-bug** (#864, S2): Today is computed in UTC |
