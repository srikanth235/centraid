# issue-535 — Mobile CI build-cache: @expo/fingerprint keying (iOS + Android)

GitHub issue: [#535](https://github.com/srikanth235/centraid/issues/535)

Part of the #535 nightly-report-honesty umbrella: the mobile lanes were the
most expensive and least-reliably-cached part of the nightly. This slice
addresses the **cost/flakiness of the mobile e2e build**, not report content.

The iOS `.app` cache was keyed by a hand-rolled `git ls-files | shasum` that
mixed in the **whole `.github/workflows/e2e.yml`** and all of `apps/mobile/ios/**`
(including git-ignored build products). Any workflow edit — or a leftover
`ios/build` dir — busted the key and forced the ~32-minute native compile on an
otherwise JS-only night. The Android lane had **no build cache at all** and
recompiled every nightly.

Both lanes now key the built-binary cache on
[`@expo/fingerprint`](https://docs.expo.dev/versions/latest/sdk/fingerprint/),
which hashes exactly the native inputs (config plugins, autolinked native
modules, the bare `ios/`+`android/` projects, the resolved Expo config, the RN
version) and ignores `apps/mobile/src/**` and the CI YAML.

## Checklist

- [x] `apps/mobile/scripts/native-fingerprint.mjs` — new native fingerprint script
- [x] `@expo/fingerprint` declared as an `apps/mobile` devDependency
- [x] `knip.json` — `scripts/*.mjs` added to the mobile entry
- [x] iOS lane keyed on the `@expo/fingerprint` hash plus host toolchain
- [x] Android lane keyed on the `@expo/fingerprint` hash plus host toolchain
- [x] repin `reactivecircus/android-emulator-runner` to v2.38.0 (dead SHA, F6)
- [x] migrate the Android lane to ubuntu-latest + KVM so the emulator can boot

## What changed

- **`apps/mobile/scripts/native-fingerprint.mjs` — new native fingerprint script.** `node scripts/native-fingerprint.mjs <ios|android>` prints the `@expo/fingerprint` hash for that platform, and refuses to emit an empty digest (which would be a constant, always-hit key).
- **`@expo/fingerprint` declared as an `apps/mobile` devDependency** (`apps/mobile/package.json`, `bun.lock`), pinned `~0.15.5` — the version Expo SDK 54 already resolves transitively, so no second copy enters the tree.
- **`knip.json` — `scripts/*.mjs` added to the mobile entry** (entry + project), so knip sees the script's import and does not flag the dep as unused.
- **iOS lane keyed on the `@expo/fingerprint` hash plus host toolchain** (`.github/workflows/e2e.yml`): key `ios-app-<os>-xc<12>-fp<40>`. `bun install` now precedes the fingerprint step (fingerprint reads `node_modules`). Net −31 lines — the bespoke `git ls-files` block is gone. Transport (split restore/save, all-or-nothing key, `if: always()` save) unchanged.
- **Android lane keyed on the `@expo/fingerprint` hash plus host toolchain** (`.github/workflows/e2e.yml`): new `native_android` fingerprint step, a `Restore the built Android app` step, an `ANDROID_CACHE_HIT`-branched emulator script (install banked apk + `adb reverse` on hit; build + bank apk on miss), and an `if: always() && steps.emu.outputs.built == 'true'` save. Key `android-app-<os>-jdk<12>-fp<40>`.
- **repin `reactivecircus/android-emulator-runner` to v2.38.0 (dead SHA, F6)** — the previously pinned SHA `1dcd0090…` no longer resolves upstream, so the Android job failed at "Set up job" before any step ran (proven on dispatch run 30074719338). The lane has therefore been dead, not merely slow — this repin is a prerequisite for the Android cache (or the lane at all) to run.
- **migrate the Android lane to ubuntu-latest + KVM so the emulator can boot** (`.github/workflows/e2e.yml`) — after the repin, the emulator still could not boot on `macos-15` (`HVF error: HV_UNSUPPORTED`: those runners have no Hypervisor.framework, so QEMU cannot hardware-accelerate). Moved the job to `ubuntu-latest`, added an `Enable KVM` udev step, pinned the build JDK via `actions/setup-java@v4.8.0` (temurin 17), and switched the emulator to `arch: x86_64` / `target: google_apis` (the KVM-accelerable image). The fingerprint keying, cache transport, and build-vs-install branch are unchanged; only the host and emulator image differ. This is what makes an actual Android cold/warm timing obtainable. Confirmed on run 30078700178 that the x86_64 emulator boots under KVM in ~1m — the macos-15 blocker is gone.
- **`apps/mobile/scripts/android-emulator-e2e.sh` — extract the emulator-side logic to a committed bash file** (`.github/workflows/e2e.yml` now calls `script: bash apps/mobile/scripts/android-emulator-e2e.sh`). The `reactivecircus/android-emulator-runner` action runs its inline `script:` under dash, which rejected first `set -o pipefail` and then the multi-line `if/else` with `#` comments and non-ASCII em-dashes (two separate parse failures on the Linux runner; macOS `sh` is bash, so neither bit before the re-host). Moving the logic into a `#!/usr/bin/env bash` file executed via a single-line hand-off removes the action's script-parser from the path entirely.

## Out of scope

- Expo **remote build cache** (`buildCacheProvider`) — the `eas` provider needs EAS enrollment this repo deliberately lacks, and the only posture-aligned alternative is a vendored GitHub Releases provider (new code + `contents: write`, CI-verify-only). Deferred by decision; `@expo/fingerprint` keying already removes most of the cache-eviction churn that motivated it.
- The rest of #535 (evidence transport double-nesting, red-run invariants, template-gate regression, 46 skip cells) — separate slices.

## Decisions

- **Kept the existing `actions/cache` split restore/save transport** instead of migrating to Expo's `buildCacheProvider` (see Out of scope). Fingerprint keying alone captures most of the win and is verifiable locally; the provider migration is not.
- **Android save is guarded on `steps.emu.outputs.built`**, which the emulator script writes to `$GITHUB_OUTPUT` from *inside* the `reactivecircus/android-emulator-runner` action. If that action does not forward `$GITHUB_OUTPUT`, the save no-ops — the cache never populates and the lane degrades to today's no-cache behaviour (safe, never a stale hit). This is the first thing to confirm on the dispatch run.
- **Android toolchain component is `java -version` (`jdk<…>`)** rather than a full SDK/NDK hash: Gradle/AGP/NDK/compileSdk already live in the tracked `android/` gradle files the fingerprint hashes, and a debug APK is runtime-portable across build JDKs, so this is a coarse belt-and-suspenders guard.

## Verification

Fingerprint behaviour proven locally against the installed SDK-54 tree
(`@expo/fingerprint@0.15.5`) — deterministic given the lockfile; iOS/Android
hashes differ; `.github/workflows/e2e.yml` is **not** an input (the old bug);
only `src/version-core.cjs` is hashed from `src/**` (it feeds `app.config.ts`),
so an `App.tsx` JS edit leaves the hash unchanged; a native-input edit
(`app.config.ts` plugin list) changes the hash or fails loud — never a stale
hit; declaring the devDependency is not itself an input.

```sh
# From apps/mobile, after `bun install`. Edit App.tsx (JS) → hash unchanged;
# edit app.config.ts plugins (native) → hash changes. This is the invariant the
# whole build cache depends on.
node scripts/native-fingerprint.mjs ios
node scripts/native-fingerprint.mjs android
```

Static gates green locally:

```sh
bun run format:check && bun run lint && bun run lint:packages && bun run knip \
  && bun run lint:e2e-flows && (cd apps/mobile && bun run typecheck)
```

CI timing measured on this branch via `workflow_dispatch` — a cold cache-miss
run (30074717423) then a warm cache-hit run (30076766957) with only a JS change
between them, so the fingerprint is identical and the warm run hits. Isolating
the native-build portion (the only part the build cache touches):

| Step | Cold (miss) | Warm (hit) |
| --- | ---: | ---: |
| Restore the built iOS app | 0m42s | 0m48s |
| Build and install the mobile dev app | **22m04s** | **skipped (0m01s)** |
| Save the built iOS app | 0m03s | skipped |
| Install the cached mobile dev app | 0m00s | 0m33s |
| **Native-build portion** | **22m49s** | **1m22s** |

**Measured saving: 21m27s per JS-only night** (~94% off the native-build
portion) — the ~22-minute Xcode compile is fully skipped and replaced by a 48s
restore + 33s install. iOS cache size on disk: **30.3 MiB**. Cross-machine
determinism confirmed: the CI fingerprint (`af99369b…`) equals the local hash.
The `Fingerprint the iOS native build inputs` step adds ~9–15s on both runs.

Not comparable across the two runs (unrelated to the build cache): the gateway
build (~5m36s both) and the journeys step (cold 3m33s / warm 6m04s — product
flakiness, not cache). The Android lane originally could not be timed at all: its
emulator cannot boot on the `macos-15` runner (`HVF error: HV_UNSUPPORTED`), a
pre-existing infra defect independent of this cache change. That lane has now
been moved to `ubuntu-latest` + KVM (see What changed) so an Android cold/warm
number becomes obtainable; the measured Android figures are recorded here once
that run completes.

## Audit

- **A1 — PASS:** Receipt's "## What changed" accurately describes all files in the staged diff (native-fingerprint.mjs, package.json, bun.lock, knip.json, e2e.yml) with correct scope for each.
- **A2 — PASS:** All four checklist items are realized in the diff: fingerprint script created, @expo/fingerprint declared, knip.json updated, iOS and Android lanes converted to fingerprint keying.
- **A3 — PASS:** Checklist maps to the issue's mobile-CI-cache-cost slice (#535 umbrella); receipt correctly excludes other umbrella phases (transport fixes, honesty invariants, 46 skip cells).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-955653fc-da5-1784876182-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 463 | 1473640 | 28623217 | 405320 | 1879423 | 33.6572 | 463 | 1473640 | 28623217 | 405320 | ci(mobile): key native build cache on @expo/fingerprint (#535)The iOS .app cache |
| claude-code-955653fc-da5-1784876540-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 11 | 21255 | 1314115 | 8112 | 29378 | 0.9928 | 474 | 1494895 | 29937332 | 413432 | ci(mobile): key native build cache on @expo/fingerprint (#535)The iOS .app cache |
| claude-code-955653fc-da5-1784876601-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 6 | 2847 | 578499 | 819 | 3672 | 0.3275 | 480 | 1497742 | 30515831 | 414251 | ci(mobile): key native build cache on @expo/fingerprint (#535) |
| claude-code-955653fc-da5-1784876733-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 12 | 17900 | 1172349 | 15967 | 33879 | 1.0973 | 492 | 1515642 | 31688180 | 430218 | ci(mobile): key native build cache on @expo/fingerprint (#535)The iOS .app cache |
| claude-code-955653fc-da5-1784876794-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 6 | 13293 | 612261 | 996 | 14295 | 0.4141 | 498 | 1528935 | 32300441 | 431214 | ci(mobile): key native build cache on @expo/fingerprint (#535) |
| claude-code-955653fc-da5-1784877007-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 21 | 9625 | 2521549 | 8078 | 17724 | 1.5230 | 519 | 1538560 | 34821990 | 439292 |  |
| claude-code-955653fc-da5-1784877314-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 56 | 28038 | 6764185 | 25451 | 53545 | 4.1939 | 575 | 1566598 | 41586175 | 464743 |  |
| claude-code-955653fc-da5-1784879567-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 171 | 190771 | 24377411 | 122589 | 313531 | 16.4466 | 746 | 1757369 | 65963586 | 587332 |  |
| claude-code-955653fc-da5-1784880476-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 254 | 1193300 | 14752495 | 187551 | 1381105 | 19.5244 | 1000 | 2950669 | 80716081 | 774883 |  |
| claude-code-955653fc-da5-1784880905-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 57 | 51783 | 2633089 | 27274 | 79114 | 2.3223 | 1057 | 3002452 | 83349170 | 802157 |  |
| claude-code-955653fc-da5-1784881287-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-fable-5 | 67 | 276302 | 3471563 | 37017 | 313386 | 8.7769 | 1124 | 3278754 | 86820733 | 839174 |  |
| claude-code-955653fc-da5-1784881762-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 75 | 85040 | 5255307 | 45279 | 130394 | 4.2915 | 1199 | 3363794 | 92076040 | 884453 |  |
| claude-code-955653fc-da5-1784882134-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 65 | 82025 | 5482893 | 57461 | 139551 | 4.6910 | 1264 | 3445819 | 97558933 | 941914 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-955653fcda5-20260724-1 | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | correction | classifier | Add skip cells + template-gate fix to in-scope; agents can do the work | 817fed1c | 219 | 2026-07-24T06:13:41.607Z |

## Steering

**PASS.** One genuine human-steering event recorded:

At 2026-07-24T06:13:41.607Z (ordinal 219, user message), the user corrected the agent's scope assumptions, stating "coding agents can do the work…so I don't think we should skip" in reference to the 46 amber `skip` cells in #535. The user redirected the agent to add both the skip-cell closure and the template-gate product regression fix to the in-scope phase, contrary to the initial working assumption that these were out-of-scope. This correction reflects a deliberate scope expansion based on changed cost-benefit analysis (agent capabilities now make marginal effort tractable). The event is recorded as a classifier-tier correction and does not affect the current receipt (which addresses the mobile-CI-cache slice), but it steers other slices now in active work.
