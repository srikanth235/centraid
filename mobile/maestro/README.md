# `mobile/maestro` — the device flows for the native shells

Flows for the three v1 screens, and the protocol for the iOS background transfer experiment ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3 lane E).

## Nothing here has ever run

There is no Android SDK, no Xcode, no emulator and no device on the machines that run `cargo xtask gate`. Every file in this directory is an **owner hand-off**: the flow is written, the CLI version is pinned, the harness contract is named, and the run is the owner's. `cargo xtask gate --profile nightly` reports its device lanes as a loud `Skipped` with the self-hosted-runner contract rather than as a pass (lane G's `device-lanes` step), and that is the only honest status this directory can carry.

## The CLI is pinned, and it is v0's pin

```
MAESTRO_VERSION=2.6.1
```

The same version both v0 CI lanes install (`.github/workflows/ci.yml:1191`, `e2e.yml:449`, `mobile-alarm-test.yml:74`). v0's own README says why in one sentence worth keeping: _"driving your local simulator with a different CLI than the nightly is how a flow passes here and reds there"_ (`tests/agent-e2e-mobile/README.md:14-18`).

## Why these flows are here and not in `tests/agent-e2e-mobile/flows`

v0's 21 flows drive the **Expo** app: they discover a target through `adb devices` / `xcrun simctl`, they select by React Native `testID`, and `scripts/lint-mobile-testids.mjs` fails on an id no screen renders. The native shells render Compose and SwiftUI, whose accessibility identifiers are set differently, so a flow that reused a v0 id would select nothing. The v0 flows stay where they are and keep driving v0 until wave 6 retires it; these are the native set, and they are deliberately a **subset** — three screens, not seventy-two.

## The selectors

Compose gets `Modifier.testTag`, SwiftUI gets `.accessibilityIdentifier`, and both use **the same string**, which is what lets one flow file drive both platforms. The ids are listed in `flows/selectors.md` beside the screen that renders them; an id no screen renders is the failure v0's lint exists to catch, and the same rule applies here by hand until wave 4 ports the lint.

## Running them, when there is a device

```sh
# Android
export ANDROID_HOME=/path/to/sdk
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:installDebug
maestro test ../mobile/maestro/flows

# iOS
cd mobile/iosApp && export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate && xcodebuild -scheme Centraid -destination 'generic/platform=iOS' build
maestro test ../maestro/flows
```
