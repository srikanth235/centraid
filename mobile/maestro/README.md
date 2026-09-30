# `mobile/maestro` — the device flows for the native shells

One flow, `flows/home.yaml`, and the protocol for the iOS background transfer experiment ([#1020](https://github.com/srikanth235/centraid/issues/1020)), `ios-transfer-experiment.md`.

## The flow has not run under Maestro

There is no Android SDK, no Xcode, no emulator and no device on the machines that run `cargo xtask gate`. `flows/home.yaml` is an **owner hand-off**: the flow is written, the CLI version is pinned, and the run is the owner's. `cargo xtask gate --profile nightly` reports its device lanes as a loud `Skipped` with the self-hosted-runner contract rather than as a pass (the `device-lanes` step), and that is the only honest status this directory can carry.

## The CLI is pinned

```
MAESTRO_VERSION=2.6.1
```

Driving a local simulator with a different CLI than the one a runner installs is how a flow passes on one machine and fails on the other.

## The selectors

Compose gets `Modifier.testTag`, SwiftUI gets `.accessibilityIdentifier`, and both use **the same string**, which is what lets one flow file drive both platforms. The ids are listed in `flows/selectors.md` beside the screen that renders them. An id no screen renders selects nothing, so a flow may only name ids that table lists; nothing checks that rule mechanically.

## Running it, when there is a device

```sh
# Android
export ANDROID_HOME=/path/to/sdk
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:installDebug
maestro test maestro/flows

# iOS
cd mobile/iosApp && export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate && xcodebuild -scheme Centraid -destination 'generic/platform=iOS' build
maestro test ../maestro/flows
```
