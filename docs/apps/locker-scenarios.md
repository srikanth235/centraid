# Locker scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md). Locker was not in the six-app Wave 7 drill; these rows are the proofs the suite already owns, closed against the bundled-app axis.

- **App**: Locker · **north star**: 1Password ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `byte-bearing` (secrets). Viewer seat is disabled; see `appSeats`.
- **Graduation issue**: none yet. Tracked under [#864](https://github.com/srikanth235/centraid/issues/864) only for ledger closure.
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/locker-gate.mjs`; custodian `apps/desktop/tests/e2e/locker.spec.ts`; viewer structurally skipped.
- **Structural exclusions**: see `tests/matrix.json#appEngines`.
- **Origin seat**: the phone draws every custodian/origin route of the v17 surface inventory's Locker table. Import, Export and Companion are surfaces of another seat and are drawn as facts plus the sentence naming where the act happens, never as controls. Access history is served by the `access` query and drawn on both seats.
- **Custodian seat**: the web app performs what it used to describe. Import runs the staged-import doors (stage → review → publish/discard), Export commits and assembles the plaintext file on the device, and Access history renders the receipts. Each door is feature-detected and there is no fallback: a seat without one draws no control and names the seat that has it.
- **Item model**: fifteen types. Six own columns on `locker_item`; the other nine are sets of fields the vault mints from a template, which is the same mechanism that degrades a type this build does not know to a note that still carries its fields. The rail stays **six rows with counts** (README-Locker §1) — the other nine are reached from the add form's type chip and from the `type:` filters.
- **Paper cuts closed**: the connector alias is read back, clearable and reassignable on the edit form; the window foot says `300 of 312` whenever the items read carries `total`, and states what it knows when it does not. Archive is distinct from trash everywhere — nothing archived carries a purge date.
- **Sealed sidecars**: `locker.item_field.value_sealed`, `locker.item_history.password` and `locker.item_passkey.private_key` are reported as PRESENT and never returned by any read. Locker's manifest grant carries `reveal` on all three, and the gateway resolves each row's **owning item** and spends that item's permit, so a sidecar reveal costs exactly what revealing the item costs. The web item screen draws `Reveal` and `Copy` on each of those rows through the same permit gate, receipt and 30-second countdown the item's own sealed columns use; one permit buys one reveal, so a sidecar reveal is its own gesture and the item's own columns stay sealed through it. The phone's item screen still reveals the item's own columns only.

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
| custodian item sections — fields, addresses, passkey, attachments, history | — | ✅ | — | `packages/blueprints/apps/locker/item-sections.test.tsx` |
| custodian live surfaces — import door gating, access rendering, export confirm | — | ✅ | — | `packages/blueprints/apps/locker/route-states.test.tsx` |
| archive shelf, the six-row rail ruling and the window total | — | ✅ | — | `packages/blueprints/apps/locker/states.test.tsx` |
| password age joins the runnable checks | ✅ | — | — | `packages/blueprints/apps/locker/review-model.test.ts` |
