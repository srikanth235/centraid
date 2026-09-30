# `contracts/apps/people`

People's parity fixtures: a **frozen golden**, read by `crates/apps/people/tests/parity.rs`. It was captured from the TypeScript tree's own People handlers before that tree was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020); its generator went with that tree, so a change to these files is a reviewed change in expected behaviour.

| File | What it carries |
| --- | --- |
| `rows.json` | every row of the seventeen tables the seven queries read, by table, with the columns the statements project |
| `queries.json` | `{query, input, output}` for all seven queries at twenty-seven inputs — the roster at its declared floor, ceiling and both clamps, the person sheet for four parties plus an absent one and a merged-away one, the dashboard, the journal, the trash shelf, six history rails and five search terms |
| `commands.json` | the replayable script: sixty-one steps over thirty-three distinct commands — all twenty-eight `people.*`, all four `social.*` and `core.merge_party` — of which fifteen are refusals on purpose |
| `scenarios.json` | the ontology-scenario rows for the three drifts People sits on: ONT-23 (money keyed by party alone), ONT-26 (the month-day calendar) and ONT-27 (task completion) |

**The fixture was captured under `TZ=UTC`.** The captured dashboard's Upcoming rail sorted by the HOST's local midnight (D-1020-PE7), so its order is the UTC order.

## What the fixture cannot show, and where that is proved instead

Every case runs under the owner's own credential, so `vaultDenied` is absent everywhere and People's three-state readings — the share plane, the linked plane and Tally's obligations — have nothing to deny. They are proved in `crates/apps/people/tests/three_state.rs`, which runs the same queries through a door that refuses one plane at a time.
