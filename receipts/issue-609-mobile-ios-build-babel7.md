# Receipt: #609 mobile iOS build + Metro bundle repair after the SDK 57 / Babel 8 bump

## Checklist

- [x] `import Expo` → `public import Expo` in `apps/mobile/ios/Centraid/AppDelegate.swift`
- [x] drop the SDK 54 `bindReactNativeFactory(factory)` call
- [x] `@babel/core` `^8.0.1` → `^7.24.0`
- [x] `@babel/runtime` `^8.0.0` → `^7.25.0`
- [x] regenerate `apps/mobile/ios/Podfile.lock` against the SDK 57 pod set
- [x] regenerate `apps/mobile/ios/Centraid.xcodeproj/project.pbxproj` against SDK 57 / RN 0.86
- [x] `REACT_NATIVE_PATH` resolves to the repo root from a clone, not only from a worktree
- [x] iOS app builds, bundles, and launches on a simulator
- [ ] CI `mobile-e2e-ios` green — blocked on the runner's Xcode 16.4 predating the SDK 57 minimum (#587 E24)

## What changed

Swift 6.3 explicit import access level, and the retired SDK 54 factory binding:

- `import Expo` → `public import Expo` in `apps/mobile/ios/Centraid/AppDelegate.swift`. Swift 6.3 (Xcode 26) enforces explicit access levels on imports whose types surface in public API; this file uses Expo at two levels — `public class AppDelegate: ExpoAppDelegate` exposes it, `class ReactNativeDelegate: ExpoReactNativeFactoryDelegate` keeps it internal — so a bare import is ambiguous and fails to compile.
- Same file: drop the SDK 54 `bindReactNativeFactory(factory)` call. That global no longer exists in SDK 57 — `ExpoReactNativeFactory` registers itself through `ExpoAppDelegateSubscriberRepository`, and the `reactNativeFactory = factory` assignment is what keeps it alive. Both changes carry an in-place comment so the next SDK bump does not re-break them silently.

Babel majors pinned back to 7, in `apps/mobile/package.json`:

- `@babel/core` `^8.0.1` → `^7.24.0` (resolves 7.29.0). Every Expo/RN Babel plugin asserts `Requires Babel "^7.0.0-0"` at runtime through `@babel/helper-plugin-utils`, so Babel 8 aborts the Metro transform.
- `@babel/runtime` `^8.0.0` → `^7.25.0` (resolves 7.29.2). Babel 8 dropped the `./regenerator` subpath from `@babel/runtime`'s `exports` map, and `react-devtools-core` — pulled in unconditionally by `react-native/Libraries/Core/setUpReactDevTools` — still imports it.
- Both were bumped by `f43e002a` (#565).
- `bun.lock` regenerated. Net line count drops sharply because the per-package Babel-7 override tree collapses back into top-level entries once the root is on 7 again.

Native project files, last touched at `e8c72feb` — before the SDK 54 → 57 bump:

- Regenerate `apps/mobile/ios/Podfile.lock` against the SDK 57 pod set.
- Regenerate `apps/mobile/ios/Centraid.xcodeproj/project.pbxproj` against SDK 57 / RN 0.86: `hermes.framework` → `hermesvm.framework`; `RNCAsyncStorage_resources` → `AsyncStorage_resources`; the notifications privacy bundle moves from `EXNotifications/` to `ExpoNotifications/`; adds `ExpoModulesJSI.framework` and `React-timing_privacy.bundle`; drops the `react-native-maps` privacy bundle that no longer ships; adds `RCT_REMOVE_LEGACY_ARCH=1` to `OTHER_CFLAGS` / `OTHER_CPLUSPLUSFLAGS` plus `PODFILE_DIR`.
- Same file: `REACT_NATIVE_PATH` resolves to the repo root from a clone, not only from a worktree — `${PODS_ROOT}/../../../../../../../node_modules/react-native` → `${PODS_ROOT}/../../../../node_modules/react-native`. Seven levels up from `apps/mobile/ios/Pods` lands on the parent of a `.claude/worktrees/<name>/` checkout, so the committed value only ever worked from a worktree at that exact depth. Four levels is the repo root, correct from both.

Rebased onto `main` after #611–#613 merged. `#613` bumped `react-native` 0.86.0 → 0.86.2 and `@op-engineering/op-sqlite` 17.1.2 → 17.1.3, so:

- `bun.lock` conflicted and was resolved by discarding both sides' lockfile and re-running `bun install` against the merged manifests — the pins are the manifest's job, not the lockfile's. `@babel/core` still resolves 7.29.0, `@babel/runtime` 7.29.2 with the `./regenerator` subpath present, and zero Babel-8 entries remain.
- `Podfile.lock` was regenerated again: leaving it at the 0.86.0 pod set against 0.86.2 in `node_modules` would have re-created, on this very PR, the native-lock drift class the PR exists to clear. The delta is version-tracking only — `React-*`/`FBLazyVector`/`RCT*` 0.86.0 → 0.86.2, `hermes-engine` 250829098.0.14 → .16, `op-sqlite` 17.1.2 → 17.1.3 — with no pod added or removed, and `pod install` left `project.pbxproj` untouched.

## Decisions

- **Pinned Babel back to 7 rather than upgrading the ecosystem to 8.** Babel 8 is unusable here until `babel-preset-expo`, `@react-native/babel-preset`, and `react-native-worklets` ship Babel 8 support and `react-devtools-core` stops importing `@babel/runtime/regenerator`. All four are upstream. Reverting the dependabot bump is the only move that restores a working bundle today.
- **Pinned in `apps/mobile/package.json`, not via a root override.** The mobile app is the only workspace that breaks; a root-level pin would hold the whole repo back for one package's constraint. The tradeoff is that a future dependabot run can re-raise the same bump — which is why #587 E25 records the peer-range blind spot and proposes ungrouping `@babel/*` majors.
- **Committed the regenerated native project files rather than gitignoring them.** They were already tracked, and the stale state is precisely what made the failure confusing. The tradeoff is churn on every prebuild; the drift guard in #587 E23 is the intended long-term answer.
- **Fixed `REACT_NATIVE_PATH` even though it was not a reported symptom.** It sits in the same regenerated hunk and the committed value was a latent worktree-only artifact — leaving it would have meant knowingly re-committing a broken path.
- **Prevention deliberately excluded.** The gates live in #587 Decision E (items 22–25) with the root-cause write-up in that issue's Context §4; this issue is scoped to the repair.

## Out of scope

- **Prevention gates.** PR-time Metro bundle smoke on lockfile change, `@expo/fingerprint` native-drift guard, CI-Xcode-vs-SDK-minimum assert, ungrouping `@babel/*` majors in dependabot — all #587 Decision E items 22–25.
- **Upgrading to Babel 8.** Blocked upstream, as above.
- **CI `mobile-e2e-ios`.** The `macos-15` runner's Xcode 16.4 fails at `Could not resolve package dependencies` before compiling any Swift, so it cannot confirm this fix. Runner bump is #587 E24.
- **Android.** Not exercised.

## Verification

iOS app builds, bundles, and launches on a simulator. Native build, from `apps/mobile`:

```sh
bunx expo run:ios
```

`Build Succeeded`, then install and launch on iPhone 17 Pro (iOS 26). Before this change the same command failed with `xcodebuild` exit 65 and four `ambiguous implicit access level for import of 'Expo'` errors at `AppDelegate.swift:1:8`.

JS bundle, from `apps/mobile`:

```sh
bunx expo start --clear
```

`iOS Bundled 35373ms apps/mobile/index.ts (2252 modules)` — clean, no warnings. Before this change the same command failed first with `[BABEL] ... Requires Babel "^7.0.0-0", but was loaded with "8.0.1"`, and after pinning `@babel/core` alone, with `Unable to resolve "@babel/runtime/regenerator" from "node_modules/react-devtools-core/dist/backend.js"`.

Resolved versions after `bun install`:

```sh
grep -E '"@babel/(core|runtime)":' bun.lock | head -2
```

Runtime, on the simulator: the app renders the #603 ticket-only pairing screen — "Connect your gateway.", device-name field prefilled `iPhone`, pairing-code textarea, "Continue with pasted code", "Scan QR instead" — in dark theme with brand-teal accents. Confirmed by screenshot.

## Audit

Fresh-context sub-agent, inputs limited to `git diff --cached`, this receipt, and `gh issue view 609`.

- **(1) What changed faithful to the diff** — PASS. Every file in `git diff --cached --stat` is described. `AppDelegate.swift` shows exactly `import Expo` → `public import Expo` with the claimed comment, and `bindReactNativeFactory(factory)` removed and replaced by a comment rather than silently deleted. `package.json` shows exactly `@babel/runtime` `^8.0.0`→`^7.25.0` and `@babel/core` `^8.0.1`→`^7.24.0`. `project.pbxproj` confirms every specific claim: `hermes.framework`→`hermesvm.framework`, `RNCAsyncStorage_resources`→`AsyncStorage_resources`, `EXNotifications/`→`ExpoNotifications/` privacy bundle, added `ExpoModulesJSI.framework` and `React-timing_privacy.bundle`, dropped `ReactNativeMapsPrivacy.bundle`, added `-DRCT_REMOVE_LEGACY_ARCH=1` to `OTHER_CFLAGS`/`OTHER_CPLUSPLUSFLAGS` plus `PODFILE_DIR`, and `REACT_NATIVE_PATH` seven levels → four. `Podfile.lock` confirms `hermes-engine` 0.81.5 → 250829098.0.14, `React-timing` 0.81.5 → 0.86.0, and new `AsyncStorage` / `ExpoModulesJSI` / `ExpoNotifications` pods. `bun.lock`'s 3519 diff lines are re-resolution churn from the Babel pin — spot-checked `@img/sharp-darwin-arm64` (identical content, moved position); no unrelated version bumps found among package-name lines.
- **(2) Each `- [x]` realized in the diff** — PASS, with one caveat. The seven code-change items are each confirmed by a diff hunk. The eighth, "iOS app builds, bundles, and launches on a simulator", is a runtime claim backed by the `## Verification` transcripts and screenshot rather than by any file change — expected for that kind of item, but not independently confirmable from the diff alone. The unchecked item is correctly left unchecked and matches its stated blocker.
- **(3) Checklist mirrors the issue** — PASS. All nine items appear in the same order with textually identical wording; the only difference is check state (issue all unchecked, receipt 8 of 9), which is the expected progression.

Verdict: PASS — the diff, the receipt's narrative, its checklist, and the issue's checklist are mutually consistent, with every claimed change independently confirmed in the staged diff.

## Steering

Fresh-context sub-agent, inputs limited to the session transcript and this receipt.

- **(1) Every human-steering event is recorded as a row** — PASS. Four events found and recorded: (ordinal 3, interrupt at 2026-07-28T09:18:00.037Z), (ordinal 4, interrupt at 2026-07-28T10:45:49.259Z), (ordinal 29, correction at 2026-07-28T10:46:14.087Z redirecting with "wait, this is brainstorming only..just keep note of it"), (ordinal 32, correction at 2026-07-28T14:12:34.248Z redirecting with "what I meant aws add it to github issue").
- **(2) No non-steering message recorded as a steering event** — PASS. 34 unique human turns total after filtering system messages and command-caveat markers; 4 classified as steering (2 interrupts, 2 corrections). Remaining 30 are regular questions, requests, instructions, and feedback—no redirections or mid-task course corrections.

Verdict: PASS — all human-steering events identified, recorded, and verified; no false-positives.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-52daa03c-5de-1785254880-1 | claude-code | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | claude-opus-5 | 5562 | 5314282 | 457583791 | 1692393 | 7012237 | 304.3438 | 5562 | 5314282 | 457583791 | 1692393 |  |
| claude-code-52daa03c-5de-1785255111-1 | claude-code | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | claude-opus-5 | 14 | 24757 | 839206 | 4006 | 28777 | 0.6746 | 5576 | 5339039 | 458422997 | 1696399 |  |
| claude-code-52daa03c-5de-1785255175-1 | claude-code | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | claude-opus-5 | 5 | 5312 | 387070 | 1374 | 6691 | 0.2611 | 5581 | 5344351 | 458810067 | 1697773 |  |
| claude-code-52daa03c-5de-1785255238-1 | claude-code | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | claude-opus-5 | 6 | 4668 | 396724 | 1226 | 5900 | 0.2582 | 5587 | 5349019 | 459206791 | 1698999 |  |
| claude-code-52daa03c-5de-1785255305-1 | claude-code | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | claude-opus-5 | 8 | 5950 | 540218 | 2576 | 8534 | 0.3717 | 5595 | 5354969 | 459747009 | 1701575 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-52daa03c-1785230280-0 | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | interrupt | structural |  | fix(mobile): restore the iOS build and Metro bundle after the SDK 57 bump (#609) | 3 | 2026-07-28T09:18:00.037Z |
| steer-52daa03c-1785235549-1 | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | interrupt | structural |  | fix(mobile): restore the iOS build and Metro bundle after the SDK 57 bump (#609) | 4 | 2026-07-28T10:45:49.259Z |
| steer-52daa03c-1785235574-2 | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | correction | classifier | Mark brainstorming tasks, do not implement yet | fix(mobile): restore the iOS build and Metro bundle after the SDK 57 bump (#609) | 29 | 2026-07-28T10:46:14.087Z |
| steer-52daa03c-1785247954-3 | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #609 | correction | classifier | Clarify: record findings to GitHub issue, not as separate commits | fix(mobile): restore the iOS build and Metro bundle after the SDK 57 bump (#609) | 32 | 2026-07-28T14:12:34.248Z |
