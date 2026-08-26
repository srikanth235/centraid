# Tally scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: Tally · **north star**: Splitwise ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `record-only`.
- **Graduation issue**: none — the v17 rebuild ([#872](https://github.com/srikanth235/centraid/issues/872)) drew the web interface again after [#831](https://github.com/srikanth235/centraid/issues/831) cleared it. The native cover stays held (`AWAITING_HANDOFF.mobile`).
- **Journey ownership**: none yet — seat e2e journeys are the follow-up on #872; the seats are `skip` in `tests/matrix.json#appSeats` citing it.
- **Structural exclusions**: see `tests/matrix.json#appEngines` (record-only: custody skipped).

| Tally scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| designed dayone | — | ✅ | — | `packages/blueprints/apps/tally/states.test.tsx` |
| figure sign convention and formatting | ✅ | — | — | `packages/blueprints/apps/tally/format.test.ts` |
| split resolution and odd-penny placement | ✅ | — | — | `packages/blueprints/apps/tally/split-model.test.ts` |
| recurring schedule sentences and withheld verbs | ✅ | — | — | `packages/blueprints/apps/tally/schedule-model.test.ts` |
| write payloads and refusal narration | ✅ | — | — | `packages/blueprints/apps/tally/writes.test.ts` |
