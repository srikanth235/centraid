# People scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: People · **north star**: Google Contacts ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `record-only`.
- **Graduation issue**: none yet; write-path holes tracked under [#864](https://github.com/srikanth235/centraid/issues/864).
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/people-roster.mjs`; custodian `apps/desktop/tests/e2e/people.spec.ts`; viewer `apps/web/tests/e2e/people.spec.ts`.
- **Structural exclusions**: see `tests/matrix.json#appEngines`.

| People scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| roster origin journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/people-roster.mjs` |
| designed pending/parked/dayone | — | ✅ | — | `packages/blueprints/apps/people/states.test.tsx` |
| per-person grants | — | ✅ | — | `packages/blueprints/apps/people/components/PersonGrants.test.tsx` |
| share-link projection | ✅ | — | — | `packages/blueprints/apps/people/queries/share-links.test.ts` |
| "Erased after 30 days" erases the person | ✅ | — | — | `packages/vault/src/gateway/duties.test.ts`: the grace-lapse sweep deletes party, identifiers, tags, and channels |
| merge keeps folded-in cadence, last-contacted, and colour | ✅ | — | — | `packages/vault/src/commands/merge.test.ts`: `core.merge_party` folds cadence, last-contacted, and colour onto the survivor |
| overdue arithmetic matches the cadence | ✅ | — | — | `packages/blueprints/apps/people/format.test.ts` |
| leap-day birthdays fire on 28 Feb in non-leap years | ✅ | — | — | `packages/blueprints/apps/people/format.test.ts` |
| month_day validation refuses impossible days | ✅ | — | — | `packages/vault/src/commands/people-dates.test.ts` |
| the roster is not silently capped at 200 rows | ✅ | — | — | `packages/blueprints/apps/people/queries/people-roster.test.ts` |
