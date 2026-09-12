# `mobile/` — the KMP shared module and the two native shells

One Kotlin Multiplatform shared module over the five-function C ABI, with a Compose shell and a SwiftUI shell that render finished state messages and own nothing ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3 lane E).

```
mobile/
├── core/        the C ABI binding — JNA on JVM and Android, cinterop on iOS
├── shared/      screen state machines, navigation, the sync scheduler
├── androidApp/  Compose. Gated on -Pcentraid.android=true + ANDROID_HOME
├── iosApp/      SwiftUI + XcodeGen + SPM. Needs a macOS host
└── maestro/     device flows, and the iOS transfer experiment's protocol
```

## What runs here, and what is a hand-off

This is the most important table in this file. **Nothing in the right-hand column reads green anywhere**: there is no Android SDK, no Xcode, no simulator and no device on the machines that run `cargo xtask gate`, and every claim that needs one is an owner hand-off with a command below.

| Provable on this machine (JVM) | An owner hand-off |
| --- | --- |
| the screen state machines, the navigation model, the mount rules, the sync scheduler, the write gate — Kotest + Turbine on `jvmTest` | the Compose screens compiling at all |
| the **real ABI round trip**: `open → call → next_event → free → close` from Kotlin over JNA against `libcentraid_core_ffi.so`, on a vault the Rust fixture binary founded | the same round trip through cinterop on iOS |
| the UI-thread assertion, the buffer accounting, the poison handling, the bounded-queue behaviour | a panic injected by the real library (it has no fault-injection point — see `contracts/handoff/E/proposed-patches.md`) |
| 19 `contracts/screens` fixtures decoded by Wire, with the screen laws asserted | the same 19 fixtures decoded by SwiftProtobuf (`mobile/iosApp/Tests/ScreenFixtureTests.swift`) |
| `commonMain` is platform-free (Konsist), icon-only controls carry labels (a source scan over both surfaces) | Roborazzi and swift-snapshot-testing snapshots |
| the emitted token table matches `packages/design` in both schemes, in Kotlin, in Swift and in JSON | the iOS framework linking, and the XCFramework |
| the `call` budget for the three screens' reads, measured | the device numbers that promote `tests/journeys.json`'s parked ceilings |

## The one command the gate runs

```sh
cd mobile && ./gradlew mobileJvm
```

`:shared:jvmTest`, `:core:jvmTest` and `:shared:koverXmlReport`. It is the `mobile-jvm` step of `cargo xtask gate`; the patch that splices it in is `contracts/handoff/E/`.

**`:core:jvmTest` builds two Rust things first** and fails loudly if `cargo` is not there, because a binding test that skipped would read green on a machine where the ABI does not work at all:

```sh
cargo build -p centraid-core-ffi                                   # the cdylib
cargo run -p centraid-core-ffi --bin spike-fixture -- <build dir>  # a founded vault
```

The Gradle build resolves the library from `-Pcentraid.coreLibDir`, then `$CARGO_TARGET_DIR/debug`, then `<repo>/target/debug` — and **never** from the ambient loader path, because a test that silently loaded some other build of the core would be a test of whatever was installed on the machine.

### Coverage

`mobile/shared/build/reports/kover/report.xml` is titled _"centraid mobile :shared — JVM only; not a Kotlin/Native number"_, and that is not a caveat added for politeness. It covers `commonMain` **as compiled for the JVM target**. It says nothing about the iOS framework, which no machine in CI links today. Generated code (`centraid.screen.v1.*` from Wire, `dev.centraid.design.*` from the token emitter) is excluded from the report: it is four times the hand-written source, and including it would make the number a measurement of a code generator.

## The toolchain

Current stable, pinned, and **not** the container's preinstalled versions (D-1020-E0-1):

|  |  |
| --- | --- |
| Gradle | **9.7.1**, via the committed wrapper, with `distributionSha256Sum` |
| Kotlin | **2.4.20** |
| AGP | **9.4.0** — the newest with no alpha/beta/rc suffix in Google's metadata |
| Wire | **7.0.1** (protobuf → Kotlin, over `crates/api-proto/proto`) |
| Kotest / Turbine / kover / Konsist / JNA | 6.2.5 / 1.2.1 / 0.9.9 / 0.17.3 / 5.19.1 |

**`org.gradle.warning.mode=fail`**: a deprecated Gradle feature is a red, not a line in the log. A Gradle or plugin upgrade therefore reds here first, which is the point. `mobile/gradle/libs.versions.toml` is the one place a version lives.

`apps/mobile/android`'s wrapper asks for Gradle 9.3.1 and is an `expo prebuild` output. **Do not reuse it.**

## Building the Android app

```sh
export ANDROID_HOME=/path/to/Android/sdk
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:assembleDebug
```

Without the flag, `:androidApp` **is not in the build at all** and `mobile/settings.gradle.kts` says so once, on every configuration. With the flag and no `ANDROID_HOME`, it refuses with the sentence that names this section. It never skips silently.

The AGP plugin is added to the build classpath **only** when the flag is set (`mobile/build.gradle.kts`'s `buildscript` block), so a machine with no SDK does not pay a download to reach a failure. The consequence is that `kotlin { androidLibrary { … } }` is configured **by name** rather than through typed accessors, and that block is therefore not type-checked here — the trade is stated in `mobile/core/build.gradle.kts` in full.

## The iOS hand-off

Everything on iOS needs a macOS host. In order:

```sh
# 1. The Kotlin side. Cinterop needs an Apple toolchain, so klib
#    cross-compilation is OFF on Linux and back ON here.
cd mobile && ./gradlew -Pkotlin.native.enableKlibsCrossCompilation=true \
    :shared:linkDebugFrameworkIosSimulatorArm64

# 2. The generated Swift types. `buf.gen.yaml` names this lane's plugin.
buf generate --template buf.gen.yaml     # after adding the protoc-gen-swift entry

# 3. The Xcode project. `project.yml` is the source; the `.xcodeproj` is NOT
#    committed (mobile/.gitignore), which is the rule v0 broke.
brew install xcodegen
cd mobile/iosApp && export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate

# 4. The fixture test — the other half of "one fixture, two languages".
cd mobile/iosApp && swift test
```

**What step 2 unblocks:** `mobile/iosApp/Sources/StateViews.swift` has one `unwired()` function that every decoder funnels through, and it is a `fatalError` rather than a default value because a screen that rendered an empty list there would be indistinguishable from an empty vault. Nineteen fixtures are waiting for it.

**What is deliberately unimplemented on iOS, and fails loudly:**

|  | Why, and what it needs |
| --- | --- |
| `IosSecureStore` | the Keychain needs a `Security.framework` cinterop. It **fails** rather than writing a vault credential to `NSUserDefaults`, which is a plist in the app container. The first thing a macOS session should write. |
| `IosMediaLibrary.page` | `PHAsset` enumeration plus a streamed SHA-256 over `PHAssetResource`. The largest single piece. Four v0 rules it must keep: exact SHA-256 is identity, dHash is a hint that never auto-merges, a Live Photo pair shares one `capture_group_id`, and motion photos / RAW / burst members get **no inferred grouping**. |
| `IosNetworkStatus` | `NWPathMonitor`. Until then it reports `platformRefused`, which is a **true** statement, and `WriteGate` treats an unknown answer as not-reachable so a guess cannot send a write into a void. |
| `ShellModel.send` | the bridge from SwiftUI to `CentraidShared`'s `ScreenHost`. A `fatalError`, so a half-wired build fails on the first tap instead of looking inert. |

**`.xcode-version` stays `16.4`, and this lane did not change it.** No machine here can compile Kotlin/Native or run `xcodebuild`, so raising it would be a guess dressed as a decision. The census expects exactly this: E confirms or replaces it **on the first real iOS compile**. The command is `xcodes install $(cat ../.xcode-version)` followed by step 1 above; if Kotlin 2.4.20's Kotlin/Native refuses that Xcode, the refusal names the version it wants and that number goes in the file.

## The other hand-offs

| What | The command | The evidence it should produce |
| --- | --- | --- |
| The iOS transfer experiment | `mobile/maestro/ios-transfer-experiment.md` — 5 states × 2 transports, 4 measurements | four JSON files under `receipts/experiments/ios-transfer/`, and one line saying which decision row they land in |
| Maestro flows | `maestro test mobile/maestro/flows` with `MAESTRO_VERSION=2.6.1` | a run ledger per flow. **Add the `testTag`/`accessibilityIdentifier` values from `flows/selectors.md` first** — seventeen strings, paired with the run that proves each selects exactly one thing |
| Android Macrobenchmark | `./gradlew -Pcentraid.android=true :androidApp:connectedBenchmarkAndroidTest` | the numbers that promote `tests/journeys.json`'s parked Android ceilings (R-1020-20: a named device, never an emulator) |
| Store enrolment | `docs/enrollment.md` + `.github/workflows/lane-release-mobile.yml` | an App Store Connect key and a Play service account, per `docs/release.md`'s per-lane secret rule |
| Swift snapshots | `swift test --filter Snapshot` after adding `swift-snapshot-testing` | committed reference images, one per screen per scheme |

## The ABI, in one paragraph

`dev.centraid.core.CentraidCore` is the only thing above `mobile/core` that knows the ABI exists. It opens, runs the handshake, checks the artifact identity, and hands up `CoreOutcome<Envelope>` — an answer or a typed refusal, never `null`. Every buffer the library allocates is copied into a Kotlin `ByteArray` and freed in the same `finally`, on every path including the timeout; `buffersHandedOver == buffersFreed` is asserted after two hundred calls. `call` is `suspend` and hops to the core dispatcher before it touches the ABI, and it asserts it is not on the UI thread **after** the hop — because the realistic bug is a shell that passed `Dispatchers.Main` as the core dispatcher, and that is the case the assertion has to catch. Read [`crates/core-ffi/CONTRACT.md`](../crates/core-ffi/CONTRACT.md) before touching any of it: ten clauses, each with a Rust test, and a shell's memory safety depends on claims that are not visible in the signatures.

`crates/core-ffi/spike/jna` was wave 2's throwaway measurement of the same binding (D-1020-D2-7). **`mobile/core` supersedes it**; the spike stays where it is as the record of the numbers that fixed the ABI's shape.

## Generated files — do not edit

| File | Generator | The drift check |
| --- | --- | --- |
| `shared/src/commonMain/kotlin/dev/centraid/design/{Tokens,Copy}.kt` | `contracts/tools/export-native-theme.ts` | `git diff --exit-code design copy mobile` |
| `iosApp/Design/Theme.swift` | the same | the same |
| `design/native-theme.json`, `copy/*.json` | the same | the same |
| `contracts/screens/**/*.bin` | `contracts/tools/build-screen-fixtures.ts` | `git diff --exit-code contracts/screens` |
| the Wire and SwiftProtobuf types | `crates/api-proto/proto` | `buf lint` / `buf breaking` |

One emitter, N committed artifacts, one lint that fails on drift. A hand-maintained Kotlin colour table would be a fourth lowering with no drift gate.
