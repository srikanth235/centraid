# iOS depth-roster budget

The `ios-depth` suite runs six journeys on the iOS Release artifact — `pairing-canary`, `native-v0-resilience`, `locker-gate`, `cold-start`, `scroll-frames`, `photos-permissions`. The runner fails when aggregate wall time is **twenty-five minutes or more**, measured from the first flow process start through the sixth verdict.

`pairing-canary` runs first and short-circuits, for the same reason it does on the PR gate: it is the shared prerequisite, and on a broken one the five after it would each spend their own minutes failing on their own unrelated-looking assertion.

## Why the roster is six and not eighteen

iOS is the **depth** platform, not a second copy of Android's roster ([D1](../../../docs/decisions.md#mobile-testing-890)). A macOS runner minute costs roughly ten Linux minutes, and every journey that asserts product logic over the replica is platform-independent by construction — one TypeScript source, one replica schema — so running it twice on the same night buys a second green at that multiple and nothing else. The six members each carry a claim that is a fact about **iOS**, and each member's `claim` in [`roster.json`](../roster.json) names that fact, so a member whose reason stops holding can be removed by a reader rather than defended by tradition.

## Where twenty-five minutes came from

**Derived, not observed.** The lane is new in this configuration — [#890](https://github.com/srikanth235/centraid/issues/890) W1 moved it off the dev client — so there is no distribution to sit on top of.

| Component | Minutes | Where the number comes from |
| --- | --- | --- |
| Fresh pairing (`pairing-canary`) | 4 | `lib/harness.mjs`: "Fresh pairing is the slowest legitimate chunk (~4 minutes on the reviewed CI runner)". |
| `native-v0-resilience` | 5 | On iOS the flow is the Settings hop through the all-apps sheet plus a process restart — the airplane arc is Android's, and the covers-open claim is held off the device entirely ([G-device-only-gate](../../../docs/decisions.md#the-pr-gate-loop-892)). Priced at four navigation units plus the restart; its `minimumTests` floor of 13 is a floor rather than a ceiling, and the flow's declared checks still clear it. |
| `locker-gate`, `photos-permissions` | 3 | ~1.15 each at `home-apps-budget.md`'s per-journey rate, plus `locker-gate`'s own restart. |
| `cold-start` | 5 | Eight per-launch cold starts. On a release artifact each is a real app launch rather than a bundle fetch, which is the point of the probe and also why it is no longer the ~43-second figure the dev client produced. |
| `scroll-frames` | 4 | Eight flings each on two surfaces, plus arming and reading the frame probe. |
| Headroom | 4 | The XCUITest driver's disconnect-and-retry behaviour past ~10 commands is recorded in [../README.md](../README.md#known-caveats) and is real time when it happens. |

## What to do when it is breached

After **three real runs**, re-derive from the observed p95 in [`../ledger/durations.json`](../ledger/durations.json) and **tighten**. Until then, if two consecutive nightlies exceed twenty-five minutes:

1. Check the ledger's failure classes first. Minutes spent on infrastructure-classified retries are an infrastructure problem, not a budget problem.
2. Batch adjacent Maestro chunks — on iOS this also reduces exposure to the driver's long-flow disconnects, so it usually helps twice.
3. **Remove a member whose reason no longer holds.** This is the first structural move on this lane, not the last: the roster is six because six claims are iOS's, and if one of them stops being iOS-specific it belongs on Android, where it costs a tenth as much.

Do not raise the ceiling to buy time, do not add retries, and do not "balance" the lane by adding Android journeys to it. macOS minutes are the scarcest thing this repo spends, and the whole `≈150 macOS-minutes` half of the [#890](https://github.com/srikanth235/centraid/issues/890) W4 envelope is this job plus the desktop macOS lane.
