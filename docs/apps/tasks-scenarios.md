# Tasks scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: Tasks · **north star**: Todoist ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `record-only`.
- **Graduation issue**: none yet; write-path holes tracked under [#864](https://github.com/srikanth235/centraid/issues/864).
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/tasks-board.mjs`; custodian `apps/desktop/tests/e2e/tasks.spec.ts`; viewer `apps/web/tests/e2e/tasks.spec.ts`. Shared replica overlay until a Tasks-specific native integration exists.
- **Structural exclusions**: see `tests/claims.json#appEngines`.

| Tasks scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| board origin journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/tasks-board.mjs` |
| designed pending/parked/offline/conflict/stale | — | ✅ | — | `packages/blueprints/apps/tasks/states.test.tsx` |
| board derivation | ✅ | — | — | `packages/blueprints/apps/tasks/logic.test.ts` |
| route table | ✅ | — | — | `packages/blueprints/apps/tasks/routes.test.ts` |
| completing a parent leaves unfinished subtasks visible | ✅ | — | — | `packages/blueprints/apps/tasks/logic.test.ts` (`nestTaskFamilies`) |
| catch-up "Release all" does not re-date the someday pile | ✅ | — | — | `packages/blueprints/apps/tasks/logic.test.ts` (`catchUpWrites`) |
| a HOUSE-scope write stays in the HOUSE scope | ✅ | — | — | `packages/blueprints/apps/tasks/writes.test.ts` (`taskWrite`) |
| delete-confirm removes the row, it does not cancel it | ✅ | — | — | `packages/blueprints/apps/tasks/writes.test.ts` (`removeTaskWrite`) |
| priority scale matches the north star | ✅ | — | — | `packages/blueprints/apps/tasks/format.test.ts` (`priorityLevel`) |
| "Today" is the member's day, not UTC | ✅ | — | — | `packages/blueprints/apps/tasks/format.test.ts` (`dayKey`) |
