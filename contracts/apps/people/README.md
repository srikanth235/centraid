# `contracts/apps/people`

People's parity fixtures, generated from the v0 tree by `contracts/tools/export-people-parity.ts` and asserted by `tests/quality/people-parity.contract.test.ts` (the emitter and the oracle are one file) and by `crates/apps/people/tests/parity.rs` (the Rust side).

| File | What it carries |
| --- | --- |
| `rows.json` | every row of the seventeen tables the seven queries read, by table, with the columns the statements project |
| `queries.json` | `{query, input, output}` for all seven queries at twenty-seven inputs — the roster at its declared floor, ceiling and both clamps, the person sheet for four parties plus an absent one and a merged-away one, the dashboard, the journal, the trash shelf, six history rails and five search terms |
| `commands.json` | the replayable script: sixty-one steps over thirty-three distinct commands — all twenty-eight `people.*`, all four `social.*` and `core.merge_party` — of which fifteen are refusals on purpose |
| `scenarios.json` | the ontology-scenario rows for the three drifts People sits on: ONT-23 (money keyed by party alone), ONT-26 (the month-day calendar) and ONT-27 (task completion) |

## Regenerating

```
bun install && bun run build
TZ=UTC CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
  --config vitest.quality.config.ts tests/quality/people-parity.contract.test.ts
bun run format && git diff --exit-code contracts/apps/people
```

**`TZ=UTC` is not optional.** The dashboard's Upcoming rail sorts by `daysUntilMonthDay`, which reads the HOST's local midnight in v0 (D-1020-PE7), so a run in another zone records an order that is a fact about the machine. The generator refuses to run outside UTC rather than writing such a fixture.

## What the fixture cannot show, and where that is proved instead

Every case runs under the owner's own credential, so `vaultDenied` is absent everywhere and People's three-state readings — the share plane, the linked plane and Tally's obligations — have nothing to deny. They are proved in `crates/apps/people/tests/three_state.rs`, which runs the same queries through a door that refuses one plane at a time.
