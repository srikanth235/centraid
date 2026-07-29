# Receipt: #620 keep mobile nightly Xcode above the SDK minimum

## Checklist

- [x] The selected `mobile-e2e-ios` image reports an installed Xcode version at or above the React Native SDK minimum.
- [x] The environment assertion passes and the lane proceeds to the native build/test step.
- [ ] A green full nightly records mobile native journey evidence instead of an `infra-mismatch` state.

## What changed

Nightly run [30417451436](https://github.com/srikanth235/centraid/actions/runs/30417451436) failed `mobile-e2e-ios` at the ExpoModulesJSI xcframework step with exit 65 and an empty `Could not resolve package dependencies` footer; `test-health-report` then failed the zero-grey contract for `mobile:journey` / `mobile:offline` / `mobile:scalability` (Android only runs `home-loads`).

Root cause was toolchain, not the earlier "hosted resource pressure" diagnosis: Expo SDK 57's `expo-modules-jsi` declares `swift-tools-version: 6.2` and documents Xcode 26.4+ (Swift 6.3). The lane ran on `macos-15` with default Xcode 16.4, which still cleared React Native's 16.1 floor (`xcode-compat: installed 16.4, required 16.1`) and then died on the JSI package. `macos-15` only ships Xcode up to 26.3, so the floor cannot be met there.

- `.github/workflows/e2e.yml`: `mobile-e2e-ios` moves to `macos-26`, selects the newest installed Xcode ≥26.4 before fingerprinting, and drops the serialize-compile / zero-error DerivedData retry that was compensating for the wrong toolchain.
- `apps/mobile/scripts/check-xcode-minimum.mjs`: required Xcode is now `max(RN helpers.rb minimum, ExpoModulesJSI floor)`. When `Package.swift` declares Swift tools ≥6.2, the Expo floor is `26.4`; a too-old runner still writes `artifacts/e2e/mobile-xcode-infra.json` as `infra-mismatch`.
- `apps/mobile/scripts/verify-native-state.test.mjs`: covers the Swift-tools parse, the 26.4 floor, and that 16.4 loses to it.
- `TESTING.md`: replaces the resource-pressure narrative with the Xcode / ExpoModulesJSI contract.

The selected `mobile-e2e-ios` image reports an installed Xcode version at or above the React Native SDK minimum. Realized by moving the job to `macos-26` with an explicit ≥26.4 `xcode-select`, which also clears RN's 16.1 helper floor. The environment assertion passes and the lane proceeds to the native build/test step. Realized by making `ci:xcode` require `max(RN, ExpoModulesJSI 26.4)` before the cold build. The third item waits on a green full nightly after merge.

## Decisions

- **Move the job to `macos-26` rather than selecting Xcode 26.x on `macos-15`.** The Sequoia image tops out at 26.3, below Expo's documented 26.4 floor for prebuilt JSI frameworks; staying on 15 would leave the assertion permanently red.
- **Derive the Expo floor from `Package.swift` + a documented constant (`26.4`), not from React Native alone.** RN's `min_xcode_version_supported` stayed at 16.1 after the SDK 57 bump, so the existing E24 preflight could not catch this class of failure.
- **Remove the concurrency=1 + one-shot retry.** Those steps were added after runs that progressed farther under load caps but still ended with the same empty package-deps footer; with the correct Xcode they only slow the cold build.

## Out of scope

- Re-running Android mobile flows beyond `home-loads` (still iOS-owned per `e2e.yml`).
- Bumping local developer docs beyond `TESTING.md`.
- Closing #586 (product flow assertions); this PR only unblocks the native toolchain under that lane.

## Verification

```sh
bun run --filter @centraid/mobile test -- scripts/verify-native-state.test.mjs
```

Expect the React Native contract test and the new ExpoModulesJSI floor test to pass.

Remote: after merge, the next full `e2e` nightly should show `mobile-e2e-ios` green with `nightly-evidence-mobile` containing evidence for the three previously grey cells, and `test-health-report` should exit 0.

## Audit

Self-review of the staged diff against this receipt and issue #620.

- **(1) What changed faithful to the diff** — PASS. Workflow `runs-on` flips to `macos-26`, adds the ≥26.4 `xcode-select` step, removes the serialize/retry block, and renames the assert step. `check-xcode-minimum.mjs` exports the Expo floor helpers and takes `max(RN, Expo)`. Tests and `TESTING.md` match the narrative.
- **(2) Each `- [x]` realized in the diff** — PASS for the two checked items (image/Xcode selection + assertion gate). The unchecked nightly-evidence item is correctly left open pending remote proof.
- **(3) Checklist mirrors the issue** — PASS. The three acceptance rows match issue #620 verbatim.

Verdict: PASS — ready to land; green nightly evidence is the remaining remote gate.

## Steering

No human interrupt or mid-task correction in this session — the user asked to fix the failed e2e run and open a PR; work stayed on that goal.

Verdict: PASS — zero steering events to record.
