# iOS smoke budget (rung 3)

`mobile-ios-smoke` runs three journeys on the iOS Release `.app` — `pairing-canary`, `cold-start`, `notes-library` — on every candidate (every push to `main`). The runner fails when aggregate wall time is **ten minutes or more**, measured from the first flow process start through the third verdict. `pairing-canary` runs first and **short-circuits**: it is the shared prerequisite, and on a broken one the two behind it would each spend their own minutes failing on their own unrelated-looking assertion.

## Why three, and why these three

iOS is a **separate artifact**: a different binary, built by a different toolchain, autolinking a different native tree, driven over XCUITest rather than UIAutomator2. "It paired and reached a usable Home on Android" is not evidence about it. So rung 3's iOS question is the narrowest one that can answer _is this a build we would hand to a device_ —

| Member | What it settles that Android cannot |
| --- | --- |
| `pairing-canary` | The `.app` launches, redeems a ticket and reaches Home at all. Everything else in the lane is meaningless without it. |
| `cold-start` | `tests/journeys.json` names both jobs as probe hosts, and a launch time measured on a swiftshader-rendered x86_64 emulator says nothing about a hardware-accelerated simulator. Per-platform evidence or no evidence. |
| `notes-library` | One home-app journey: a write round-trips through the device replica and survives a real process death. It is the cheapest member that exercises the replica and the navigation stack together, and #870 is the reason a home-app journey is in the smallest set at all. |

Everything else iOS owns — the MediaLibrary refusal, the Keychain boundary, the frame denominator, the Dynamic Island insets — is `ios-depth` on rung 4. This lane is not a small copy of that one; it is the promotion question.

## Where ten minutes came from

**Derived, not observed.** The lane is new with [#915](https://github.com/srikanth235/centraid/issues/915) Wave 2, so there is no distribution to sit on top of. It is built from the two rates the sibling budgets use, on a **WARM** runner — the native shell restored from the fingerprint cache with this SHA's JS bundle injected, so no compilation is inside this clock.

| Component | Minutes | Where the number comes from |
| --- | --- | --- |
| Fresh pairing (`pairing-canary`) | 4 | `lib/harness.mjs`: "Fresh pairing is the slowest legitimate chunk (~4 minutes on the reviewed CI runner)". |
| `cold-start` | 2.5 | Eight per-launch cold starts, reusing the paired profile. `ios-depth-budget.md` prices the same member at 5 minutes because it pays its own pairing there; here it does not. |
| `notes-library` | 1.5 | Android CI measures 106–154 s (`pr-gate-budget.md`), reusing the paired profile. Rounded up for the XCUITest driver. |
| Headroom | 2 | The XCUITest driver's disconnect-and-retry behaviour past ~10 commands is recorded in [../README.md](../README.md#known-caveats) and is real time when it happens. |

**What is deliberately NOT in this budget: the native build.** The shell is cached by the native fingerprint alone (`apps/mobile/native-fingerprints.json` + `apps/mobile/scripts/native-fingerprint.mjs`), and a JS-only candidate re-uses it with the bundle re-exported into it — the "pay packaging, not compilation" path the Android gate has used since [#905](https://github.com/srikanth235/centraid/issues/905). A cold shell is the build's cost, not this suite's. See [`../../../apps/mobile/scripts/ios-simulator-install.sh`](../../../apps/mobile/scripts/ios-simulator-install.sh).

## What to do when it is breached

After **three real runs**, re-derive from the observed p95 in [`../ledger/durations.json`](../ledger/durations.json) and **tighten**; `bun run check:mobile-suite-budgets` starts enforcing that at three samples and names the number to lower to. Until then, if two consecutive candidates exceed ten minutes:

1. Check the ledger's failure classes first. Minutes spent on infrastructure-classified retries are an infrastructure problem, not a budget problem.
2. Batch adjacent Maestro chunks — on iOS this also reduces exposure to the driver's long-flow disconnects, so it usually helps twice.
3. Move a member to `ios-depth`. That costs the candidate a claim, which is a decision to make deliberately and to record.

Do not raise the ceiling to buy time and do not add retries. macOS minutes are the scarcest thing this repo spends.
