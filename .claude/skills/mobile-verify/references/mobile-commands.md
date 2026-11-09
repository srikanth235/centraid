# Mobile verification commands and capabilities

All repository-root commands below assume the current directory is the repository root. Commands marked **from `mobile/`** or **from `mobile/iosApp/`** require changing to that directory first. Keep each working directory explicit; a `cd` in one shell command does not affect the next command.

## What this environment can prove

| Environment | Supported evidence | Requirements and limits |
| --- | --- | --- |
| Linux JVM | Rust tests, `cargo xtask rules`, the ABI's JNA JVM round trip, `mobile-jvm` gate, TypeScript checks | Cargo, Bun, JDK 21, and Gradle distribution access. No Apple toolchain. |
| Linux Compose build | Compile the Android app | Android SDK (`ANDROID_HOME`) and JDK 21. A generic Linux environment without the SDK cannot compile Compose. An emulator/device requires a separate runtime. |
| macOS Apple | SwiftUI app and iOS simulator tests | Xcode, XcodeGen, and the required Apple SDKs. iOS core cross-builds use the scripts below. |
| Physical Android or iOS device | Device flows and measurements | A connected, named device and the platform toolchain. Emulator/simulator results are not physical-device performance evidence. |

## Rust and JVM checks

Choose checks that cover the changed layer; this is a menu, not a requirement to run every command for every change. Run from the repository root:

```sh
cargo test -p centraid-screens
cargo xtask rules
cargo xtask screens-catalog --check   # only when a manifest changed
bun run lint:product                  # copy, native controls, journey ledger
cargo xtask design --check            # generated design outputs are current (cargo xtask design writes them)
buf lint                              # and buf breaking against the PR base, when installed
cargo xtask gate --profile pr
cargo build -p centraid-core-ffi
cargo xtask gate --profile mobile-jvm # JDK 21; JVM ABI round trip and artifact drift check
bun run check
```

The JVM gate builds the cdylib without `--features llama`, runs `:core:jvmTest` against the real library, then regenerates and checks emitted design artifacts. It does not compile Compose or SwiftUI and does not run a simulator, emulator, or device. For a faster binding iteration after building the cdylib, run from `mobile/`:

```sh
./gradlew mobileJvm
```

## Android

Compose compilation is supported on Linux when the Android SDK is installed and `ANDROID_HOME` is set. From the repository root:

```sh
export ANDROID_HOME=/path/to/Android/sdk
```

Then from `mobile/`:

```sh
./gradlew -Pcentraid.android=true :androidApp:assembleDebug
./gradlew -Pcentraid.android=true :androidApp:installDebug # requires a running emulator or connected device
```

If Rust changed, rebuild the Rust core before assembling/running the app:

```sh
# From the repository root. This script currently uses the macOS NDK toolchain.
mobile/scripts/android-core.sh
```

## iOS

iOS builds, core slices, simulator tests, and XcodeGen need macOS with Xcode. From the repository root, rebuild the Rust archive before an app run whenever Rust changed:

```sh
IPHONEOS_DEPLOYMENT_TARGET=$(cat mobile/ios-deployment-target) mobile/scripts/ios-core.sh aarch64-apple-ios-sim
```

Then from `mobile/iosApp/`:

```sh
export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate # required after adding a Swift file or proto file
xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

There is no `swift test` path: the sources import UIKit and link the core's C archive. Swift protobuf output is generated in the Xcode pre-build phase; it requires `protoc` and `protoc-gen-swift` (`brew install protobuf swift-protobuf`). A new proto also requires `xcodegen generate` to update the generated input/output lists.

For iOS Maestro runs, use the command in the [Maestro section](#maestro). The simulator's Apple Health store is empty; the debug seeder and `flows/health-seed.yaml` are available for that flow. Simulator scheduling is not evidence of iOS background scheduling on a phone.

## Maestro

For iOS, run from the repository root after installing the app:

```sh
maestro test mobile/maestro/flows
```

For Android, the committed flows name the iOS bundle id. Adapt the selected flow's `appId` in a temporary copy, then run that copy from the repository root; for example, with the Android app installed:

```sh
android_flow_dir=$(mktemp -d)
trap 'rm -rf "$android_flow_dir"' EXIT
sed 's/^appId: dev.centraid.Centraid$/appId: dev.centraid/' mobile/maestro/flows/home.yaml \
  > "$android_flow_dir/home.yaml"
maestro test "$android_flow_dir/home.yaml"
```

The Android package id is `dev.centraid`; the committed selectors are shared across shells. Use the pinned `MAESTRO_VERSION=2.6.1`. There are no committed Roborazzi capture tests or reference images yet; the plugin is not applied, so there are no `record` or `verify` tasks.

## Device lanes and reporting

`cargo xtask gate --profile nightly` includes device lanes. Without `CENTRAID_DEVICE_RUNNER`, it reports `Skipped`, not a pass. With a runner configured but no attached device, it fails as infrastructure. Use `--lane <name>` for one lane; Android macrobenchmarks require a physical Android device, and iOS metrics require `CENTRAID_REFERENCE_DEVICE` naming the device.

In a hand-off, list each command actually run and each layer not run. For unrun work, name the exact command above and the needed platform or device. Claim verification only for evidence collected.
