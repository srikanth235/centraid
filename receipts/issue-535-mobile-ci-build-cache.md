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

## What changed

- **`apps/mobile/scripts/native-fingerprint.mjs` — new native fingerprint script.** `node scripts/native-fingerprint.mjs <ios|android>` prints the `@expo/fingerprint` hash for that platform, and refuses to emit an empty digest (which would be a constant, always-hit key).
- **`@expo/fingerprint` declared as an `apps/mobile` devDependency** (`apps/mobile/package.json`, `bun.lock`), pinned `~0.15.5` — the version Expo SDK 54 already resolves transitively, so no second copy enters the tree.
- **`knip.json` — `scripts/*.mjs` added to the mobile entry** (entry + project), so knip sees the script's import and does not flag the dep as unused.
- **iOS lane keyed on the `@expo/fingerprint` hash plus host toolchain** (`.github/workflows/e2e.yml`): key `ios-app-<os>-xc<12>-fp<40>`. `bun install` now precedes the fingerprint step (fingerprint reads `node_modules`). Net −31 lines — the bespoke `git ls-files` block is gone. Transport (split restore/save, all-or-nothing key, `if: always()` save) unchanged.
- **Android lane keyed on the `@expo/fingerprint` hash plus host toolchain** (`.github/workflows/e2e.yml`): new `native_android` fingerprint step, a `Restore the built Android app` step, an `ANDROID_CACHE_HIT`-branched emulator script (install banked apk + `adb reverse` on hit; build + bank apk on miss), and an `if: always() && steps.emu.outputs.built == 'true'` save. Key `android-app-<os>-jdk<12>-fp<40>`.
- **repin `reactivecircus/android-emulator-runner` to v2.38.0 (dead SHA, F6)** — the previously pinned SHA `1dcd0090…` no longer resolves upstream, so the Android job failed at "Set up job" before any step ran (proven on dispatch run 30074719338). The lane has therefore been dead, not merely slow — this repin is a prerequisite for the Android cache (or the lane at all) to run.

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

CI timing (cold cache-miss vs warm cache-hit) measured on this branch via
`workflow_dispatch` — results recorded below once both runs complete.

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

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-955653fcda5-20260724-1 | 955653fc-da50-425f-95f2-bc71a62f0f63 | #535 | correction | classifier | Add skip cells + template-gate fix to in-scope; agents can do the work | 817fed1c | 219 | 2026-07-24T06:13:41.607Z |

## Steering

**PASS.** One genuine human-steering event recorded:

At 2026-07-24T06:13:41.607Z (ordinal 219, user message), the user corrected the agent's scope assumptions, stating "coding agents can do the work…so I don't think we should skip" in reference to the 46 amber `skip` cells in #535. The user redirected the agent to add both the skip-cell closure and the template-gate product regression fix to the in-scope phase, contrary to the initial working assumption that these were out-of-scope. This correction reflects a deliberate scope expansion based on changed cost-benefit analysis (agent capabilities now make marginal effort tractable). The event is recorded as a classifier-tier correction and does not affect the current receipt (which addresses the mobile-CI-cache slice), but it steers other slices now in active work.
