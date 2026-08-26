# Locker scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md). Locker was not in the six-app Wave 7 drill; these rows are the proofs the suite already owns, closed against the bundled-app axis.

- **App**: Locker · **north star**: 1Password ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `byte-bearing` (secrets). Viewer seat is disabled; see `appSeats`.
- **Graduation issue**: none yet. Tracked under [#864](https://github.com/srikanth235/centraid/issues/864) only for ledger closure.
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/locker-gate.mjs`; custodian `apps/desktop/tests/e2e/locker.spec.ts`; viewer structurally skipped.
- **Structural exclusions**: see `tests/matrix.json#appEngines`.

| Locker scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| gate origin journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/locker-gate.mjs` |
| designed dayone | — | ✅ | — | `packages/blueprints/apps/locker/states.test.tsx` |
| TOTP generation | ✅ | — | — | `packages/blueprints/apps/locker/totp.test.ts` |
| origin matching for autofill | ✅ | — | — | `packages/blueprints/apps/locker/origin-matching.test.ts` |
| item type partition | ✅ | — | — | `packages/blueprints/apps/locker/locker-item-type.test.ts` |
| row-recipe derivations | ✅ | — | — | `packages/blueprints/apps/locker/format.test.ts` |
