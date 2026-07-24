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
- [x] fix the Android dev-client launch: build via gradle + `adb install`, target the `.debug` package
- [x] replace the vendored cargo-ndk iroh tree with the official `computer.iroh:iroh-android` AAR; align iOS and desktop-node to iroh v1.1.0
- [x] skip first-run onboarding after a clearState launch so Android reaches Home
- [x] update home-loads assertions to the launcher-redesign Home copy the app actually renders

## What changed

- **`apps/mobile/scripts/native-fingerprint.mjs` — new native fingerprint script.** `node scripts/native-fingerprint.mjs <ios|android>` prints the `@expo/fingerprint` hash for that platform, and refuses to emit an empty digest (which would be a constant, always-hit key).
- **`@expo/fingerprint` declared as an `apps/mobile` devDependency** (`apps/mobile/package.json`, `bun.lock`), pinned `~0.15.5` — the version Expo SDK 54 already resolves transitively, so no second copy enters the tree.
- **`knip.json` — `scripts/*.mjs` added to the mobile entry** (entry + project), so knip sees the script's import and does not flag the dep as unused.
- **iOS lane keyed on the `@expo/fingerprint` hash plus host toolchain** (`.github/workflows/e2e.yml`): key `ios-app-<os>-xc<12>-fp<40>`. `bun install` now precedes the fingerprint step (fingerprint reads `node_modules`). Net −31 lines — the bespoke `git ls-files` block is gone. Transport (split restore/save, all-or-nothing key, `if: always()` save) unchanged.
- **Android lane keyed on the `@expo/fingerprint` hash plus host toolchain** (`.github/workflows/e2e.yml`): new `native_android` fingerprint step, a `Restore the built Android app` step, an `ANDROID_CACHE_HIT`-branched emulator script (install banked apk + `adb reverse` on hit; build + bank apk on miss), and an `if: always() && steps.emu.outputs.built == 'true'` save. Key `android-app-<os>-jdk<12>-fp<40>`.
- **repin `reactivecircus/android-emulator-runner` to v2.38.0 (dead SHA, F6)** — the previously pinned SHA `1dcd0090…` no longer resolves upstream, so the Android job failed at "Set up job" before any step ran (proven on dispatch run 30074719338). The lane has therefore been dead, not merely slow — this repin is a prerequisite for the Android cache (or the lane at all) to run.
- **migrate the Android lane to ubuntu-latest + KVM so the emulator can boot** (`.github/workflows/e2e.yml`) — after the repin, the emulator still could not boot on `macos-15` (`HVF error: HV_UNSUPPORTED`: those runners have no Hypervisor.framework, so QEMU cannot hardware-accelerate). Moved the job to `ubuntu-latest`, added an `Enable KVM` udev step, pinned the build JDK via `actions/setup-java@v4.8.0` (temurin 17), and switched the emulator to `arch: x86_64` / `target: google_apis` (the KVM-accelerable image). The fingerprint keying, cache transport, and build-vs-install branch are unchanged; only the host and emulator image differ. This is what makes an actual Android cold/warm timing obtainable. Confirmed on run 30078700178 that the x86_64 emulator boots under KVM in ~1m — the macos-15 blocker is gone.
- **`apps/mobile/scripts/android-emulator-e2e.sh` — extract the emulator-side logic to a committed bash file** (`.github/workflows/e2e.yml` now calls `script: bash apps/mobile/scripts/android-emulator-e2e.sh`). The `reactivecircus/android-emulator-runner` action runs its inline `script:` under dash, which rejected first `set -o pipefail` and then the multi-line `if/else` with `#` comments and non-ASCII em-dashes (two separate parse failures on the Linux runner; macOS `sh` is bash, so neither bit before the re-host). Moving the logic into a `#!/usr/bin/env bash` file executed via a single-line hand-off removes the action's script-parser from the path entirely.
- **replace the vendored cargo-ndk iroh tree with the official `computer.iroh:iroh-android` AAR; align iOS and desktop-node to iroh v1.1.0** (`apps/mobile/modules/centraid-tunnel/android/build.gradle`, `apps/mobile/modules/centraid-tunnel/ios/CentraidTunnel.podspec`, `apps/mobile/modules/centraid-tunnel/README.md`, `apps/mobile/modules/centraid-tunnel/.gitignore`, `packages/tunnel/package.json`, `bun.lock`). With the launch fixed, run 30085043376 got the app to the JS bundle and then redboxed: `dlopen failed: library "libiroh_ffi.so" not found`. Root cause: the tunnel module's Android natives were a git-ignored, dev-machine-only cargo-ndk cross-compile, **arm64-v8a only and never provisioned in CI at all** — invisible while the lane was dead on macos-15, exposed the first time the app actually ran (on an x86_64 AVD). Upstream shipped the missing piece on 2026-07-17: the `computer.iroh:iroh-android` **1.1.0** AAR on Maven Central, bundling `libiroh_ffi.so` for all four ABIs (arm64-v8a, armeabi-v7a, x86, x86_64) plus `IrohAndroid`. build.gradle now declares that artifact instead of the `iroh:1.0.0`-jar + jna@aar hand-wiring — no Rust/cargo-ndk/NDK step anywhere, and the x86_64 natives are what let the KVM emulator load the tunnel (the arm64-runner + cross-compile alternative was considered and dropped as strictly more machinery). A gradle guard fails fast with a delete-me message if a stale vendored tree (`src/main/jniLibs/`, `src/main/java/computer/iroh/`) is still present, since it would duplicate the AAR's classes and natives. The iOS podspec is bumped v1.0.0 → v1.1.0 (checksum verified against the downloaded artifact: `ad46dadf…`; same iOS 17.5 floor in upstream Package.swift) so both mobile platforms speak the same iroh, and its fetch is now version-aware via a `.iroh-version` marker (a bare existence check would silently keep the old framework after a tag bump). Kotlin API compatibility proven locally: `./gradlew :centraid-tunnel:compileDebugKotlin` exits 0 against the AAR. Both cache keys rotate, so the iroh-less apk banked by run 30085043376 (and the v1.0.0 iOS app) can never be warm-hit: android fingerprint `9bc0c57a…` → `62575531…`, iOS `af99369b…` (the exact hash CI recorded) → `03157292…`. Desktop-node (`packages/tunnel`, `@number0/iroh`) is bumped 1.0.0 → 1.1.0 (`package.json` + `bun.lock`) so it matches the mobile binding; the desktop Rust data-plane (`iroh 1.0.2` crate) and web (`iroh-wasm` cargo build of the `iroh 1.0.0` crate) already consume official channels and keep wire compat within 1.x — their crate bumps are a separate lockfile-churn follow-up, not required for this Android fix.
- **fix the Android dev-client launch: build via gradle + `adb install`, target the `.debug` package** (`apps/mobile/scripts/android-emulator-e2e.sh`, `tests/agent-e2e-mobile/lib/harness.mjs`, `tests/agent-e2e-mobile/flows/home-loads.mjs`, `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`, `tests/agent-e2e-mobile/flows/template-gate.mjs`, `tests/agent-e2e-mobile/README.md`). On run 30079552726 the emulator booted and gradle reported `BUILD SUCCESSFUL in 20m 39s`, but the job then failed at `CommandError: No development build (dev.centraid.mobile) for this project is installed`. Root cause: debug builds carry `applicationIdSuffix '.debug'` (android/app/build.gradle, kept so a debug and a Play-release build coexist — J1/#501), so the apk installs as `dev.centraid.mobile.debug`, while `expo run:android`'s post-install launch check looks for the un-suffixed base id. The build and install had *succeeded*; only expo's launch step failed — and it is unnecessary, since Maestro launches the app. Two changes: (1) the cold path now builds with `./gradlew :app:assembleDebug` and installs with `adb install -r` + `adb reverse` — the same handoff the warm path already uses — instead of `expo run:android`, dropping expo's broken launch entirely; (2) the harness resolves the installed package per platform (`dev.centraid.mobile` on iOS, `dev.centraid.mobile.debug` on Android) and threads it through `ctx.state.appId`, so Maestro's `launchApp` (and the harness install check + Metro prewarm) target the package that is actually installed. Flows read `ctx.state.appId` instead of the hardcoded `APP_ID`. iOS is unaffected — its bundle id has no suffix, which is why only Android hit this.
- **skip first-run onboarding after a clearState launch so Android reaches Home** (`tests/agent-e2e-mobile/lib/first-run.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`, `tests/agent-e2e-mobile/flows/home-loads.mjs`, `tests/agent-e2e-mobile/README.md`). With the app finally loading (iroh AAR), run 30090178855 rendered — but the "Welcome to Centraid" **onboarding** screen (`src/screens/Onboarding.tsx`), not Home: `App.tsx` gates the tab shell on `profile.onboarded`, which is AsyncStorage-backed and therefore wiped by `launchApp: {clearState: true}`, so every fresh Android launch starts in onboarding. iOS never surfaced this — its simulator persists the flag across the clearState the flows use, so it was already past onboarding. Added a shared `skipOnboarding(platform, timeoutMs)` helper — for Android it emits `extendedWaitUntil visible "Skip" → tapOn "Skip"` (the header button, which calls `setOnboarded(true)` and drops straight to Home), for every other platform an empty string — and inserted its output right after the `clearState: true` launch in `home-loads` and the harness `configureGateway` helper. It must **wait**, not test point-in-time: the first attempt used `runFlow: when visible`, which fired the instant `launchApp` returned — before the JS bundle had painted onboarding — so it saw nothing, no-op'd, and the app sat on onboarding until the Home assertion timed out (CI run 30093591058, which DID confirm the warm cache-hit path: "Android cache hit … skipping gradle"). Empty on iOS keeps its Home assertion — the next step — unchanged. The helper plus the existing `DISMISS_KEYBOARD_ONBOARDING` live in a new `lib/first-run.mjs`, extracted (mirroring the earlier `metro.mjs` split) so `harness.mjs` stays under the 500-line repo-hygiene cap. Making the flow progress instead of idling for 120s also stops the emulator's Pixel Launcher ANR-ing under the software GPU. `lint:e2e-flows` green (no vacuous assertions). Flow-only change — it does not move the native fingerprint, so the banked apk warm-hits and the re-run skips the ~34m gradle build.
- **update home-loads assertions to the launcher-redesign Home copy the app actually renders** (`tests/agent-e2e-mobile/flows/home-loads.mjs`). With onboarding skipped, run 30094372690 reached Home — proven by the debug screenshot — but the flow still failed: its assertions were **stale**. `Home.tsx` was redesigned into the "Good afternoon, …" launcher (a `#498` design port), and the strings the flow asserted — `"Everything you build, in one place."`, `"Built in"`, `"Connect your desktop"` — **do not exist anywhere in `apps/mobile/src`** (verified by grep; the only near-match is unrelated onboarding-"done" copy). They could not have been passing on iOS either — the iOS lane's journeys were treated as "flaky", masking that this assertion never matched the current app. Re-pointed the flow at what Home paints: the stable first-paint rail label `"YOUR APPS"` for "Home rendered" (the greeting above it is time-of-day dependent, so unassertable), and the real no-gateway card `"Connect your computer"` + `"Pair desktop"` (`Home.tsx`) for the pairing affordance. This is why every fix in this receipt advanced the failure exactly one screen further — dead lane → boots → installs → launches → loads → onboarding → Home → correct Home copy. The parallel stale copy in the iOS-only flows (`native-v0-resilience`, `template-gate`, harness `configureGateway`) is left for a focused follow-up — the Android nightly lane runs only `home-loads`, and those flows are already-broken-on-the-same-string, so touching them here would be untested iOS churn.

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
number becomes obtainable.

Android progress is measured, not assumed: on `ubuntu-latest` + KVM the x86_64
emulator boots in ~1m (run 30078700178) and the cold gradle build takes **20m39s**
(`BUILD SUCCESSFUL`, run 30079552726) — so the native-build cost the Android cache
targets is now a real number. That run still red-failed at expo's post-install
launch check (the `.debug` applicationId mismatch, fixed in What changed); the
cold-completes-green run and the warm (cache-hit) Android figure are recorded here
once a run with the launch fix finishes end-to-end.

## Audit

The launch fix was independently sub-agent-attested when first added; the two
follow-on bullets below (iroh AAR switch, desktop-node bump) are author-attested
against the staged diff — verdicts re-derived, not re-run through a sub-agent.

- **A1 — PASS:** `## What changed` names every staged file and describes each accurately. Launch bullet: cold path swaps `expo run:android` for `./gradlew :app:assembleDebug` + `adb install -r` + `adb reverse`; harness adds `appIdForPlatform` (`.debug` on Android), threads it via `state.appId`; flows use `ctx.state.appId`. iroh bullet: `android/build.gradle` replaces the `iroh:1.0.0`-jar + `jna@aar` pair with `computer.iroh:iroh-android:1.1.0` and adds a stale-vendored-tree guard; podspec bumps `iroh_tag` v1.0.0 → v1.1.0 (sha `ad46dadf…`, `.iroh-version` marker); `.gitignore`/README reframed; `packages/tunnel/package.json` + `bun.lock` bump `@number0/iroh` to 1.1.0. All named with full paths.
- **A2 — PASS:** Every `[x]` item is realized: the launch fix (gradle+adb+`.debug`), and "replace the vendored cargo-ndk iroh tree with the official `computer.iroh:iroh-android` AAR; align iOS and desktop-node to iroh v1.1.0" (gradle AAR dep + guard, podspec v1.1.0, desktop-node package.json/lock 1.1.0). Each `[x]` text appears verbatim in a What-changed bullet.
- **A3 — PASS:** Both are prerequisites for the Android e2e lane actually running the app end-to-end (launch + a loadable x86_64 native lib) — squarely the #535 mobile-CI-build-cache slice; `## Out of scope` still correctly excludes the Expo remote build-cache provider and the other umbrella slices. Verified locally: `./gradlew :centraid-tunnel:compileDebugKotlin` exits 0 against the 1.1.0 AAR; the v1.1.0 xcframework SHA-256 matches upstream `Package.swift`; both native fingerprints rotate so the broken cached artifacts can't warm-hit.

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
| claude-code-955653fc-da5-1784887193-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 182 | 534648 | 13617601 | 176025 | 710855 | 14.5519 | 1705 | 6372760 | 142073207 | 1289475 |  |
| claude-code-955653fc-da5-1784887267-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 8 | 20681 | 750847 | 8024 | 28713 | 0.7053 | 1713 | 6393441 | 142824054 | 1297499 |  |
| claude-code-955653fc-da5-1784892973-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 293 | 1610512 | 35637902 | 194592 | 1805397 | 32.7509 | 2017 | 8023742 | 179847668 | 1498675 |  |
| claude-code-955653fc-da5-1784894885-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 130 | 182009 | 25063490 | 111926 | 294065 | 16.4681 | 2147 | 8205751 | 204911158 | 1610601 |  |
| claude-code-955653fc-da5-1784895222-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 35 | 64192 | 7461210 | 45308 | 109535 | 5.2647 | 2182 | 8269943 | 212372368 | 1655909 |  |
| claude-code-955653fc-da5-1784895851-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 87 | 92973 | 19931963 | 70404 | 163464 | 12.3076 | 2269 | 8362916 | 232304331 | 1726313 |  |
| claude-code-955653fc-da5-1784896202-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 59 | 43498 | 14132686 | 28535 | 72092 | 8.0519 | 2328 | 8406414 | 246437017 | 1754848 |  |
| claude-code-955653fc-da5-1784896340-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 12 | 17919 | 2795427 | 9144 | 27075 | 1.7384 | 2340 | 8424333 | 249232444 | 1763992 |  |
| claude-code-955653fc-da5-1784896426-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 3 | 7431 | 1408197 | 10071 | 17505 | 1.0023 | 2343 | 8431764 | 250640641 | 1774063 |  |
| claude-code-955653fc-da5-1784897188-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 73 | 66945 | 18999523 | 56524 | 123542 | 11.3316 | 2416 | 8498709 | 269640164 | 1830587 |  |
| claude-code-955653fc-da5-1784898073-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | claude-opus-4-8 | 72 | 86233 | 20322280 | 64140 | 150445 | 12.3040 | 2488 | 8584942 | 289962444 | 1894727 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-955653fcda5-20260724-1 | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | correction | classifier | Add skip cells + template-gate fix to in-scope; agents can do the work | 817fed1c | 219 | 2026-07-24T06:13:41.607Z |

## Steering

**PASS.** One genuine human-steering event recorded:

At 2026-07-24T06:13:41.607Z (ordinal 219, user message), the user corrected the agent's scope assumptions, stating "coding agents can do the work…so I don't think we should skip" in reference to the 46 amber `skip` cells in #535. The user redirected the agent to add both the skip-cell closure and the template-gate product regression fix to the in-scope phase, contrary to the initial working assumption that these were out-of-scope. This correction reflects a deliberate scope expansion based on changed cost-benefit analysis (agent capabilities now make marginal effort tractable). The event is recorded as a classifier-tier correction and does not affect the current receipt (which addresses the mobile-CI-cache slice), but it steers other slices now in active work.
