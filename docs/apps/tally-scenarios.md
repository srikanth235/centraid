# Tally scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: Tally · **north star**: Splitwise ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `record-only`.
- **Graduation issue**: none — the v17 rebuild ([#872](https://github.com/srikanth235/centraid/issues/872)) drew the web interface again after [#831](https://github.com/srikanth235/centraid/issues/831) cleared it, and [#873](https://github.com/srikanth235/centraid/issues/873) drew the native cover. `AWAITING_HANDOFF.mobile` is empty; Tally's own suspension is gone.
- **Journey ownership**: origin `tests/agent-e2e-mobile/flows/tally-derived.mjs`; custodian `apps/desktop/tests/e2e/tally.spec.ts`; viewer `skip` in `tests/matrix.json#appSeats` pending the web seat's own journey.
- **Structural exclusions**: see `tests/matrix.json#appEngines` (record-only: custody skipped).
- **Origin seat**: the phone draws every origin-seat route of the v17 surface inventory's Tally table. It OWNS Receipt — SURFACES.md gives capture to `origin (read on others)` — and Export is the one surface whose door is elsewhere, drawn as facts plus the sentence naming where the act happens rather than as a control. Waiting draws the phone's own durable outbox and hands a steward-only act to the shell's Approvals inbox: no mobile transport reaches the gateway's per-intent decide door, so neither Approve nor Decline is offered (`TALLY_CONTRIB_DOORS.decide = false`).
- **Read plane**: reads are the gateway's query handlers, because `queries/dashboard.ts` holds the one balance engine; writes are the replica's, with an optimistic projection each, so recording never needs the gateway. See [docs/mobile-offline.md](../mobile-offline.md#durable-path-and-at-rest-decision).

| Tally scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| designed dayone | — | ✅ | — | `packages/blueprints/apps/tally/states.test.tsx` |
| figure sign convention and formatting | ✅ | — | — | `packages/blueprints/apps/tally/format.test.ts` |
| split resolution and odd-penny placement | ✅ | — | — | `packages/blueprints/apps/tally/split-model.test.ts` |
| recurring schedule sentences and withheld verbs | ✅ | — | — | `packages/blueprints/apps/tally/schedule-model.test.ts` |
| write payloads and refusal narration | ✅ | — | — | `packages/blueprints/apps/tally/writes.test.ts` |
| derived origin journey — read-time figures and no verb this seat cannot fire | — | — | ✅ | `tests/agent-e2e-mobile/flows/tally-derived.mjs` |
| origin band, Waiting slot and More sheet tables | ✅ | — | — | `apps/mobile/src/apps/tally/tally-band.test.ts` |
| origin state precedence, honest window foot and the outbox's Waiting rows | ✅ | — | — | `apps/mobile/src/apps/tally/tally-view-model.test.ts` |
| origin read plane — denial as data, search races, forgetting a payload | ✅ | — | — | `apps/mobile/src/apps/tally/tally-store.test.ts` |
| origin Balances — hero derivation, All settled, day one and the sign convention | — | ✅ | — | `apps/mobile/src/apps/tally/BalancesView.test.tsx` |
| origin Waiting — the doors this transport has, and the two verbs it does not | — | ✅ | — | `apps/mobile/src/apps/tally/WaitingView.test.tsx` |
