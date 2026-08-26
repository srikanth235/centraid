# Locker scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md). Locker was not in the six-app Wave 7 drill; these rows are the proofs the suite already owns, closed against the bundled-app axis.

- **App**: Locker · **north star**: 1Password ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `byte-bearing` (secrets). Viewer seat is disabled; see `appSeats`.
- **Graduation issue**: none yet. Tracked under [#864](https://github.com/srikanth235/centraid/issues/864) only for ledger closure.
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/locker-gate.mjs`; custodian `apps/desktop/tests/e2e/locker.spec.ts`; viewer structurally skipped.
- **Structural exclusions**: see `tests/matrix.json#appEngines`.
- **Origin seat**: the phone draws every custodian/origin route of the v17 surface inventory's Locker table. Import, Export and Companion are surfaces of another seat and are drawn as facts plus the sentence naming where the act happens, never as controls. Access history is drawn against the ask — the receipts are written and no query serves them yet.

| Locker scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| gate origin journey | — | — | ✅ | `tests/agent-e2e-mobile/flows/locker-gate.mjs` |
| designed dayone | — | ✅ | — | `packages/blueprints/apps/locker/states.test.tsx` |
| TOTP generation | ✅ | — | — | `packages/blueprints/apps/locker/totp.test.ts` |
| origin matching for autofill | ✅ | — | — | `packages/blueprints/apps/locker/origin-matching.test.ts` |
| item type partition | ✅ | — | — | `packages/blueprints/apps/locker/locker-item-type.test.ts` |
| row-recipe derivations | ✅ | — | — | `packages/blueprints/apps/locker/format.test.ts` |
| origin boundary — boots locked, locks on hide, wipes the bag | ✅ | — | — | `apps/mobile/src/apps/locker/locker-store.test.ts` |
| origin band and More sheet tables | ✅ | — | — | `apps/mobile/src/apps/locker/locker-band.test.ts` |
| origin state precedence, window foot and elsewhere-surfaces | ✅ | — | — | `apps/mobile/src/apps/locker/locker-view-model.test.ts` |
| origin designed states — dayone, offline, pending, window end | — | ✅ | — | `apps/mobile/src/apps/locker/LockerItemsView.test.tsx` |
| origin gates — first run, lock, denied | — | ✅ | — | `apps/mobile/src/apps/locker/LockerWall.test.tsx` |
| origin sealed field, reveal countdown and permit gate | — | ✅ | — | `apps/mobile/src/apps/locker/LockerFields.test.tsx` |
| origin review registers and all clear | — | ✅ | — | `apps/mobile/src/apps/locker/LockerReviewView.test.tsx` |
| online-only write door on the origin seat | ✅ | — | — | `apps/mobile/src/lib/replica/locker-online-only.test.ts` |
| otpauth seed grammar for the camera scan | ✅ | — | — | `apps/mobile/src/apps/locker/otpauth.test.ts` |
