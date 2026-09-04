# Device rung budget (#927 W4)

The two rung-5 suites — `device-rung-android` and `device-rung-ios` — run on **leased hardware**, which makes their ceiling a different kind of number from every other suite in this roster. An emulator minute is a runner minute; a device minute is a device-hour bought from a farm, and the lease is held for the whole suite whether a member is running or not.

## What the ceilings are, and what they are not

| Suite | `budgetMs` | What priced it |
| --- | --- | --- |
| `device-rung-android` | 2,700,000 (45 min) | The ten members' own flow budgets sum to ~1,060 s. The ceiling is ~2.5x that, because **not one of those flow budgets was measured on a phone**: every one is derived from an emulator or simulator run (see `$budgets` in `roster.json` — `ledger/durations.json` holds zero records). A ceiling set at the emulator sum would fail the first night on hardware that is slower at cold start and faster at everything else, and nobody would know which. |
| `device-rung-ios` | 1,500,000 (25 min) | Five members, same arithmetic, same caveat. Matches `ios-depth`'s ceiling, because until a device run exists there is no evidence an iPhone differs from the simulator by more than the simulator differs from itself — a different number here would be an invention. |

**Neither number is a measurement.** Both are provisional ceilings whose only job is to stop a wedged lease from burning an hour. The first real run of each cell replaces them with `p95 x 1.5` from `ledger/durations.json`, the same rule `scripts/check-mobile-suite-budgets.mjs` applies to every other suite once three samples exist — and that run is also what lets `tests/journeys.json` promote its mobile `_intended*` ceilings to gating ones.

## The volume caveat, stated once

Both cells seed the **demo corpus**, not the golden year-3 replica. A cold-start or dropped-frame number over a hundred rows is not a year-3 number, and every ledger row this rung feeds must carry the volume it was taken at. Seeding a gateway from `goldenYear3Replica()` is the rung's first debt; the seeder is `@centraid/test-kit/year3-vault`, imported from source (plain Node needs `--experimental-strip-types`, which the web e2e harness already passes).

## On breach

A leased device-hour is the most expensive minute this repository spends. Drop a journey whose claim an emulator rung already carries before raising either ceiling — `$doctrine` in `roster.json` applies here twice over.
