# `mobile/` — the ABI binding and the two native shells

The Rust core runs on the phone and decides everything a person sees ([`crates/screens`](../crates/screens); the contract is [docs/screens.md](../docs/screens.md)). A Compose shell and a SwiftUI shell draw the `ViewState` it pushes, send the `ScreenEvent`s a person causes and perform the generic `Effect`s it asks for ([#1020](https://github.com/srikanth235/centraid/issues/1020), [#1135](https://github.com/srikanth235/centraid/issues/1135)). There is no shared Kotlin layer above the ABI.

```
mobile/
├── core/        the C ABI binding — JNA on JVM and Android, cinterop on iOS
├── androidApp/  Compose. Gated on -Pcentraid.android=true + ANDROID_HOME. Depends only on :core
├── iosApp/      SwiftUI + XcodeGen. Needs a macOS host. Links libcentraid_core_ffi.a directly
├── maestro/     the Home device flow, and the iOS transfer experiment's protocol
└── scripts/     the core's cross-builds (android-core.sh, ios-core.sh), the demo vault, the Swift proto generator
```

## What runs here, and what is a hand-off

This is the most important table in this file. **Nothing in the right-hand column reads green in CI**: there is no Android SDK, no Xcode, no simulator and no device on the machines that run `cargo xtask gate`, and every claim that needs one is an owner hand-off with a command below.

| Provable on this machine (JVM and Rust) | An owner hand-off |
| --- | --- |
| the **real ABI round trip**: `open → call → next_event → free → close` from Kotlin over JNA against `libcentraid_core_ffi.so`, on a vault the Rust fixture binary founded (`:core:jvmTest`) | the same round trip through cinterop on iOS, and through JNA on a device |
| the UI-thread assertion, the buffer accounting, the poison handling, the bounded-queue behaviour | a panic injected by the real library (it has no fault-injection point — see `contracts/handoff/E/proposed-patches.md`) |
| every screen's behaviour: `centraid_screens::testing::Driver` over the real core (`cargo test -p centraid-screens`) | the Compose screens and the SwiftUI views rendering |
| the emitted token table, catalogue and kit words match `packages/design` (`packages/design`'s `native-emission.test.ts`, and the drift check of the `mobile-jvm` step) | every emitted silhouette parsing in the Swift path reader (`IconSilhouetteTests`); Roborazzi and swift-snapshot-testing snapshots |
| the pass service, the phone imports and the vault shelf's decisions (Rust tests in `crates/screens`) | the windows firing, the background `URLSession` carrying parts with the app suspended, the PhotoKit and MediaStore walkers, the derivatives, the deletions — `maestro/backup-measurement.md` |
| `cargo xtask rules` over the shells' sources (no copy in a view, controls from the kit) | the device numbers that promote `tests/journeys.json`'s parked ceilings |

Both shells have been seen running over the real core: the iOS shell compiles, links and runs its test bundle on a simulator ([#1080](https://github.com/srikanth235/centraid/issues/1080)'s device hand-off results), and the Android shell runs on an emulator against a seeded vault.

## The one command the gate runs

```sh
cd mobile && ./gradlew mobileJvm
```

`:core:jvmTest` and nothing else. It is the `mobile-jvm` step of `cargo xtask gate --profile mobile-jvm`, which `nightly.yml` runs; the step also regenerates the emitted design artifacts and screen fixtures and fails on drift.

**`:core:jvmTest` builds two Rust things first** and fails loudly if `cargo` is not there, because a binding test that skipped would read green on a machine where the ABI does not work at all:

```sh
cargo build -p centraid-core-ffi                                   # the cdylib
cargo run -p centraid-core-ffi --bin spike-fixture -- <build dir>  # a founded vault
```

**Both are built without `--features llama`**, so the cdylib the JVM tests load carries no engine: no Kotlin spec loads a model, `AssistRoundTripSpec` accepts the `NO_ENGINE` a present file reads as there, and the cold llama.cpp build stays out of `mobile-jvm`'s 420 s budget ([R-CHAT-10](../docs/decisions.md#the-assistant)). The two commands must stay in step: a different feature set on the second is a rebuild of the first.

The Gradle build resolves the library from `-Pcentraid.coreLibDir`, then `$CARGO_TARGET_DIR/debug`, then `<repo>/target/debug` — and **never** from the ambient loader path, because a test that silently loaded some other build of the core would be a test of whatever was installed on the machine.

There is no coverage report: the JVM target of `:core` is the one Kotlin module under test, and a number over it would say nothing about the shells.

## The toolchain

Current stable, pinned, and **not** the container's preinstalled versions (D-1020-E0-1):

|  |  |
| --- | --- |
| Gradle | **9.7.1**, via the committed wrapper, with `distributionSha256Sum` |
| Kotlin | **2.4.20** |
| AGP | **9.4.0** — the newest with no alpha/beta/rc suffix in Google's metadata |
| Wire | **7.0.1** (protobuf → Kotlin, over `crates/api-proto/proto`) |
| Kotest / Turbine / JNA | 6.2.5 / 1.2.1 / 5.19.1 |

**`org.gradle.warning.mode=fail`**: a deprecated Gradle feature is a red, not a line in the log. A Gradle or plugin upgrade therefore reds here first, which is the point. `mobile/gradle/libs.versions.toml` is the one place a version lives.

### Dependency locks

Every resolvable configuration of every project is locked (`dependencyLocking { lockAllConfigurations() }` in `mobile/build.gradle.kts`), in Gradle's default lock mode: a resolution that differs from the lock fails the build. The lock state is committed as `settings-gradle.lockfile` (the version catalogue) and one `gradle.lockfile` per project — `core/` and `androidApp/`. After changing a version or a dependency, rewrite them in **both** modes, no-flag first:

```sh
cd mobile
./gradlew dependencies :core:dependencies --write-locks
ANDROID_HOME=/path/to/Android/sdk ./gradlew -Pcentraid.android=true \
    dependencies :core:dependencies :androidApp:dependencies --write-locks
```

Each run rewrites the configurations it resolved and keeps the rest, so the second run adds the Android configurations beside the JVM and iOS ones rather than replacing them. The lock names modules and versions only, never a host classifier, so a Linux runner and a Mac resolve the same file (`kotlin-native-prebuilt` is one entry on both).

Three things are not locked, on purpose:

- **The buildscript classpath**, where AGP arrives only under `-Pcentraid.android=true`; a lock of it would fail whichever mode did not write it. AGP's version is `libs.versions.toml`'s `agp`.
- **`allSourceSetsCompileDependenciesMetadata` and `allTestSourceSetsCompileDependenciesMetadata`**, the Kotlin plugin's IDE-import aggregates: with the flag they carry `:core`'s Android source set's AndroidX graph and without it they cannot, so no single lock fits both modes. No build task resolves them, and every per-source-set configuration they aggregate is locked.
- **The commonized cinterop configurations** (`appleMainCInterop` and its siblings). They have no lock state because the `dependencies` report cannot resolve them: a published library has no commonized-cinterop variant. The build reads them leniently.

## Building the Android app

```sh
export ANDROID_HOME=/path/to/Android/sdk
mobile/scripts/android-core.sh                                   # the Rust core into jniLibs, first and on every core change
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:assembleDebug
```

Without the flag, `:androidApp` **is not in the build at all** and `mobile/settings.gradle.kts` says so once, on every configuration. With the flag and no `ANDROID_HOME`, it refuses with the sentence that names this section. It never skips silently. The `.so` in `jniLibs` is a copied file: nothing in Gradle knows it is stale ([docs/traps/stale-core-slice.md](../docs/traps/stale-core-slice.md)).

**A JDK 21 Gradle can find.** `:core` compiles with `jvmToolchain(21)`, and `:androidApp`'s unit tests run on JDK 21 for the same reason. Gradle looks for one where it is installed system-wide; a Homebrew `openjdk@21` is not there, and the build stops with "Cannot find a Java installation … matching languageVersion=21". Point `JAVA_HOME` at it (`export JAVA_HOME=$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home`), which the `mobile-jvm` gate needs as well, or pass `-Dorg.gradle.java.installations.paths=<that path>` to `./gradlew`.

A **release** build (`assembleRelease`, and the release lane's `bundleRelease`) is shrunk and obfuscated by R8; a debug build is not. The keep rules are `androidApp/proguard-rules.pro`, and they exist for JNA: its native dispatcher reaches back into `com.sun.jna` by name, and `CentraidLibrary`'s method names are the C symbols. A class reached by name that a debug run exercises and a release run crashes on is a missing rule there.

The AGP plugin is added to the build classpath **only** when the flag is set (`mobile/build.gradle.kts`'s `buildscript` block), so a machine with no SDK does not pay a download to reach a failure. The consequence is that `kotlin { androidLibrary { … } }` is configured **by name** rather than through typed accessors, and that block is therefore not type-checked here — the trade is stated in `mobile/core/build.gradle.kts` in full.

**JNA is one library in two packages and the package is the extension.** Same group, name and version — `net.java.dev.jna:jna` — published both as a jar and as an `.aar`. The jar bundles `libjnidispatch` for DESKTOP ABIs as ordinary resources; the aar carries the Android ones as real `lib/<abi>/libjnidispatch.so` entries, which is the only shape a packager installs and `System.loadLibrary` finds. Getting it wrong fails two ways and both were seen:

- **jar on Android** — the app builds, installs, runs, and the first `centraid_open` dies with `dlopen failed: library "libjnidispatch.so" not found`. A `@aar`-less catalogue alias resolves to the jar. `unzip -l` the APK: if you see `com/sun/jna/win32-x86-64/jnidispatch.dll` and no `lib/arm64-v8a/libjnidispatch.so`, this is what happened.
- **both** — `checkDebugDuplicateClasses` refuses out loud, because every `com.sun.jna` class is in each.

`mobile/core/build.gradle.kts` names the `@aar` extension explicitly and says why; the version still comes from the catalogue.

## The iOS hand-off

Everything on iOS needs a macOS host. In order:

```sh
# 0. THE RUST CORE, FIRST AND EVERY TIME IT CHANGES. The app links this archive
#    by PATH (iosApp/project.yml), so nothing but this step builds it, and a
#    stale one links with no error at all — see docs/traps/stale-core-slice.md,
#    written after a byte door that compiled on every layer and ran as the
#    version from five hours earlier.
#    The core carries llama.cpp (the on-device chat's engine) when it is built
#    `--features llama` — every phone build says so, because the feature is off
#    by default (R-CHAT-10) and a core without it reports every model file as
#    NO_ENGINE. CMake builds llama.cpp from source: `cmake` must be on PATH, and
#    the deployment floor must be exported or the C++ is built for the SDK's own
#    version (27.0) and the device link fails on `___chkstk_darwin`. Cargo does
#    not rerun the llama build when the variable changes:
#    `cargo clean -p llama-cpp-sys-2 --target <triple>` after changing it.
#    `scripts/ios-core.sh` is this cargo command for the three slices, in the
#    dev profile; a simulator-only build passes its triple:
IPHONEOS_DEPLOYMENT_TARGET=$(cat mobile/ios-deployment-target) \
  mobile/scripts/ios-core.sh aarch64-apple-ios-sim

# 1. The generated Swift types: NO COMMAND. They are built, not carried.
#    `Sources/Generated` is protoc's output over `crates/api-proto/proto`
#    (gitignored), written by `mobile/scripts/generate-swift-protos.sh`, which
#    Xcode runs as the app target's PRE-BUILD phase and `xcodegen generate`
#    runs first through `options.preGenCommand` (the target globs `Sources`, so
#    the files must exist when the project is generated). The phase declares
#    every `.proto` as an input and every `.pb.swift` as an output, so editing
#    a `.proto` re-runs it on the next build and an untouched tree does not.
#    It needs `protoc` and `protoc-gen-swift`, and stops the build naming the
#    command when either is missing:
brew install protobuf swift-protobuf

# 2. The Xcode project. `project.yml` is the source; the `.xcodeproj` is NOT
#    committed (mobile/.gitignore). Re-run it after
#    ADDING a source file: the target globs a directory, and a new
#    `Sources/**.swift` is invisible until the project is regenerated. The same
#    goes for ADDING a `.proto`: the phase's file lists (`iosApp/.generated/`,
#    gitignored) are rewritten by this command.
brew install xcodegen
cd mobile/iosApp && export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate

# 3. The tests: the fixtures decoded by SwiftProtobuf, the icon silhouettes,
#    the font registration. A SIMULATOR, and the only route: see the note below.
cd mobile/iosApp && xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

**Which steps a change needs.** Every step is silent when skipped, so the rule is by what changed, not by what failed:

| You changed | Re-run | Why it is silent otherwise |
| --- | --- | --- |
| anything under `crates/` the core links — a screen, a command, a query, a proto | 0 | the app links the Rust archive by path; a stale slice answers the old arm and nothing says so ([stale-core-slice](../docs/traps/stale-core-slice.md)) |
| `crates/api-proto/proto/**` — an edited message | 0; nothing for Swift | Xcode's pre-build phase regenerates `Sources/Generated` when a `.proto` is newer than its output |
| a NEW `crates/api-proto/proto/**/*.proto` file | 2 | the phase's input and output lists are written by `xcodegen generate`; a proto the project does not list is a type Swift does not have |
| a new `Sources/**.swift` file | 2 | the target globs a directory, and the project is generated |

Building beside other work on one Mac: give each `xcodebuild` its own `-derivedDataPath`.

**THERE IS NO `swift test`, AND NO SWIFTPM PACKAGE.** `Sources/` imports **UIKit**, which is not a macOS framework, so a host build cannot compile it, and the app target links the core's C archive (`iosApp/CoreBridge` maps `crates/core-ffi/include/centraid.h` to the Swift module `CentraidCoreC`). SwiftProtobuf is a package dependency of the XcodeGen project (`project.yml`), resolved by Xcode.

The simulator bundle is the one route, and it is the right one: `FontRegistrationTests` asserts `UIFont(name:)` resolves, that `UIAppFonts` names every emitted file, and that the 400 register resolves to the derived 470 face rather than a plain 400 static — none of which means anything without a real app bundle, since the last one reads `familyName` and the CoreText weight trait back out of the registered bytes. The test target needs `GENERATE_INFOPLIST_FILE` (it has no `Info.plist`) and the app target `PRODUCT_MODULE_NAME: CentraidApp`, because `Tests/` says `@testable import CentraidApp` and XcodeGen names a module after its target.

**A decode that fails renders the screen's loading state**, never an empty one: an empty `.data` case would be a screen claiming an empty vault before it had read one.

**`.xcode-version` is `26.6`**, confirmed by the first real iOS compile (D-1020-E5a: the first compile confirms or replaces the pin).

### What iOS performs

`Sources/Core.swift` (`actor Core`) is the Swift binding of the five symbols; `Sources/ScreenStore.swift` holds navigation, views and the effect performers; `Sources/RustScreenHost.swift` is the one place that maps `ViewState.kind` to a view. The platform work behind the effects lives beside them:

| Platform work | Where |
| --- | --- |
| secure stores: the Keychain over `kSecClassGenericPassword` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (a background task reads while locked, and a credential cannot ride an iCloud or encrypted-backup restore onto another device), and the synchronised seed | `SecretStores.swift` |
| the link (`NWPathMonitor`) and the charger (`UIDevice` battery monitoring) as the `LinkRead` and `PassFacts` facts | `PassFacts.swift` |
| the photo library: grant, pages, one resource streamed out of Photos (`requestDataForAssetResource`) into the stage door, tiers rendered from the current edit, the change watch | `PhoneLibrary.swift`, `PhotoEffects.swift`, `StageDoor.swift` |
| deleting library originals through the system's confirmation | `PhotoLibraryDeleter.swift` |
| the two `BGTaskScheduler` windows, and the background `URLSession` that carries parts while the app is suspended | `BackgroundPasses.swift`, `BackgroundUploads.swift` |
| contacts per `CNContainer`, EventKit calendars and reminders, followed folders (a security-scoped bookmark in `UserDefaults`, a stale one refreshed, one that resolves into the trash means the folder is gone) | `PhoneContacts.swift`, `PhoneCalendar.swift`, `PhoneReminders.swift`, `Docs/DocsFollow.swift` |
| the gateway browse (`NWBrowser`, `_centraid-gateway._tcp`) | `GatewayBrowser.swift` |

### Seeding the simulator's Health

A simulator's Apple Health is empty, and Centraid never writes to it (R-1129-7: its bundle asks `toShare: []`, carries an empty `com.apple.developer.healthkit.access` and no `NSHealthUpdateUsageDescription`, which `HealthKitReadOnlySpec` holds). So test data comes from a **separate debug app**, `iosApp/HealthSeeder/`: its own XcodeGen spec, bundle id `dev.centraid.HealthSeeder` and entitlement with share types, never named by Centraid's `project.yml` and never linked or embedded in it.

```sh
cd mobile/iosApp && export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate --spec HealthSeeder/project.yml   # writes HealthSeeder/HealthSeeder.xcodeproj (gitignored)
xcodebuild -project HealthSeeder/HealthSeeder.xcodeproj -scheme HealthSeeder -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath build/seeder ARCHS=arm64 ONLY_ACTIVE_ARCH=YES build
xcrun simctl install <udid> build/seeder/Build/Products/Debug-iphonesimulator/HealthSeeder.app
maestro --udid <udid> test maestro/flows/health-seed.yaml      # launches it and answers its sheet once
xcrun simctl launch --terminate-running-process <udid> dev.centraid.HealthSeeder -extra   # later: 2,000 more steps and a walk today
```

It writes a deterministic year: 365 days of steps, active energy, resting heart rate and weight (every third day), 90 nights of sleep in stages with an overlapping unstaged interval beside each (Centraid merges them and counts the night once), and ten runs, walks and rides with distance, energy, heart rate and elevation. Every object carries a sync identifier (a workout's own samples too), so a second run replaces the first rather than doubling it; `-extra` writes at fixed moments of today for the same reason, and a running seeder must be terminated for the argument to reach it. **Exercise minutes are Apple's alone** (`appleExerciseTime` cannot be written by an app), so a seeded simulator's exercise line reads nothing. Then Health → Connect in Centraid, and `maestro/flows/health-connect.yaml` walks Home → Connect → the sheet → Today.

## The other hand-offs

| What | The command | The evidence it should produce |
| --- | --- | --- |
| The backup measurement | [`maestro/backup-measurement.md`](maestro/backup-measurement.md) — three claims on named reference devices: a first backup in an evening, a night's photos confirmed with the app closed, a restored grid in minutes | each claim's numbers and its pass or fail, recorded where that document says |
| The Maestro flow | `maestro test mobile/maestro/flows` (`home.yaml` first; the flows are written against the iOS bundle id, so an Android run uses a copy with `appId: dev.centraid`) with `MAESTRO_VERSION=2.6.1` — see [`maestro/README.md`](maestro/README.md) | a run ledger. **Add the `testTag`/`accessibilityIdentifier` values from `flows/selectors.md` first**, paired with the run that proves each selects exactly one thing |
| Android Macrobenchmark | `./gradlew -Pcentraid.android=true :androidApp:connectedBenchmarkAndroidTest` | the numbers that promote `tests/journeys.json`'s parked Android ceilings (R-1020-20: a named device, never an emulator) |
| Store enrolment | `docs/enrollment.md` + `.github/workflows/lane-release-mobile.yml` | an App Store Connect key and a Play service account, per `docs/release.md`'s per-lane secret rule |
| The gateway browse (#1080, Q-1080-D3, #1152) | on a Mac and a simulator, then on an Android phone, each with a paired gateway: stop the gateway, start it on another port or address on the same network, open the app (or tap Back up now) and watch Backup read the gateway reachable again within one pass with no re-pair; `GatewayBrowseTests` (iOS) and `GatewayBrowseTest` / `GatewayBrowsingTest` (Android) cover the browse's decisions over fakes, and `dns-sd -R x _centraid-gateway._tcp local 17443 gw=<id>` plus a TCP listener on that port is a stand-in advertisement. On Android check an Android 14 or newer phone and an Android 13 or older one, because the resolve differs between them | a reached gateway after a move with no re-pair, on each platform |
| The first-launch deck on both phones (#1152) | `maestro test mobile/maestro/flows/first-launch.yaml` then `onboarding.yaml` with `MAESTRO_VERSION=2.6.1`, on an Android emulator with a cleared app (the `appId: dev.centraid` copy) and on a simulator; swipe, Skip and TalkBack's order by hand on Android | both flows green on each platform, or the failing step with a recording |
| Money's home, the People verb strip, the 18 pt margins, the file picker's types and the lightbox's media type on an Android phone (#1152) | open each by hand on an Android 13 and an Android 14+ phone ([`docs/release/v1-handoffs.md`](../docs/release/v1-handoffs.md) rows 9.5, 9.6) | a screenshot per screen; Money's three tabs beside the simulator's |
| The Swift written without a compiler (#1152) | the simulator test command above, then the five Agenda / shield / scrub / recovery-key / Home checks and the two search and picker checks (rows 9.1 to 9.3) | a green `CentraidTests` run and a line per check |
| Swift snapshots | the step-3 command with `-only-testing:CentraidTests/Snapshot*`, after adding `swift-snapshot-testing` | committed reference images, one per screen per scheme |

## The ABI, in one paragraph

`dev.centraid.core.CentraidCore` (Kotlin) and `Core` (Swift) are the only things that know the ABI exists. Each opens, runs the handshake, checks the artifact identity, and hands up an answer or a typed refusal, never `null`. Every buffer the library allocates is copied into the host language's bytes and freed in the same `finally`, on every path including the timeout; on the JVM, `buffersHandedOver == buffersFreed` is asserted after two hundred calls. `call` is `suspend` and hops to the core dispatcher before it touches the ABI, and it asserts it is not on the UI thread **after** the hop — because the realistic bug is a shell that passed `Dispatchers.Main` as the core dispatcher, and that is the case the assertion has to catch. Read [`crates/core-ffi/CONTRACT.md`](../crates/core-ffi/CONTRACT.md) before touching any of it: ten clauses, each with a Rust test, and a shell's memory safety depends on claims that are not visible in the signatures.

Above `:core`, Android's `dev.centraid.core.Screens` holds the screen runtime's `navigation`, `views` and `effects` as flows; iOS's `ScreenStore` holds the same over `Core`. `mobile/core` is the JVM binding spike (D-1020-D2-7) grown up; the numbers that fixed the ABI's shape are in the spike's receipt.

## Generated files — do not edit

| File | Generator | The drift check |
| --- | --- | --- |
| `androidApp/src/main/kotlin/dev/centraid/android/design/{Tokens,Catalog,Words}.kt` | `contracts/tools/export-native-theme.ts` (the catalogue by `export-native-catalog.ts`, the kit's words by `export-native-words.ts`, from `crates/screens/src/strings/shared.rs`) | `git diff --exit-code design mobile` |
| `iosApp/Design/{Theme,Catalog,Words}.swift` | the same | the same |
| `design/native-{theme,catalog}.json` | the same | the same |
| the Wire types | `crates/api-proto/proto`, by Gradle's `generateCommonMainProtos` | `buf lint` / `buf breaking`; the task is a build input, so a stale tree is not possible |
| `iosApp/Sources/Generated/**` (the SwiftProtobuf types) | `mobile/scripts/generate-swift-protos.sh`: Xcode's pre-build phase, and `xcodegen generate`'s `preGenCommand` | none needed: the phase re-runs when a `.proto` changes, and `Sources/Generated` is gitignored |

One emitter, N committed artifacts, one lint that fails on drift. A hand-maintained Kotlin colour table would be a fourth lowering with no drift gate — and so would a hand-maintained app catalogue, icon set or kit word, which is why the emitter carries them rather than eight app names and 139 silhouettes being typed into two languages. A view's other copy is the Rust `ViewState`'s: the words live in `crates/screens/src/strings`, and `lint:copy` holds them to [DESIGN.md](../DESIGN.md)'s rulebook.

## The shells, and what they hold

**Views decide nothing** ([R-1047-K1](../docs/decisions.md#the-mobile-shell)): a label, sentence, chip, hue key, accessibility label, empty-state choice, enabled flag, grid packing or destination a view needs and the `ViewState` does not carry is a gap in the Rust view, never a computation in Swift or Compose. **Every value is a token or a stated geometry:** no `.secondary`, no SF Symbols, no Material icons. `Catalog.kt`/`Catalog.swift` carry the same 24×24 path data the web renderer draws; Compose reads it with `PathParser`, iOS with `Sources/Icon.swift`, and `Tests/IconSilhouetteTests.swift` asserts every emitted silhouette parses.

**Android** (`androidApp/src/main/kotlin/dev/centraid/android`). `session/AppSession.kt` opens the process's one core over `filesDir` (`{"shelf": dir}`) and its one `Screens`, counted so an activity and a WorkManager window share it. `session/ShellEffects.kt` performs every effect that needs only a context, once, in the order asked per screen; `kit/ScreenEffects.kt` performs the ones that need the activity (a haptic, a prompt, a picker, the owner check, a scan, a sheet) for as long as it is composed. `session/LibraryRoll.kt` answers the camera-roll service from MediaStore, `session/Stage.kt` streams bytes through the stage door, `session/ImportsRelay.kt` tells the imports the two facts only the shell knows, `session/PhoneWatchers.kt` watches the phone's calendar and address book, `session/GatewayBrowsing.kt` (the effect's life), `session/GatewayBrowse.kt` (its pure rules) and `session/NsdBrowse.kt` (`NsdManager`) browse the LAN for a gateway, and `backup/PassWork.kt` maps Rust's windows onto WorkManager. `screens/RustRoot.kt` draws the route stack Rust holds; `MainActivity` names no screen and no destination.

**iOS** (`iosApp/Sources`). `ShellModel.swift` opens `Core` over the app's data directory with the same fronting config, `ScreenStore` holds what it pushes, and the platform work above answers its effects.

**A field one shell reads, the other must read too** ([#1152](https://github.com/srikanth235/centraid/issues/1152)). `cargo xtask rules` runs `native-shell-parity` over the `*_screens.proto` and `screens.proto` messages: for every field it asks whether Compose spells it (`.name`, `name =`, `name_`) and whether SwiftUI does (`.camelCase`, `camelCase:`, `_p`, `ID`/`URL`), comments cut. A field only one shell reads, or neither, fails unless it is a row of `crates/xtask/src/native_parity_register.rs`, and a row has one of four statuses: `Platform { only, why }` when the other platform has no such thing (Doze settings, iOS background uploads, Reminders); `Gap { lane, missing_on }` when a lane owes the other shell its read (lane `F`: read by neither shell, waiting for the owner's decision to expose or delete it); `RustOnly { why, missing_on }` when Rust writes the field and reads it back, or hands it from one screen or service to another, so no shell is owed anything; and `Runtime { why, missing_on }` when the runtime itself originates or consumes it (a timer, a change notice, a service report). A field nothing reads, and no decision is owed on, is deleted from the proto with its name and number `reserved`, not registered. A closed gap leaves the register in the commit that closes it, because the rule fails on a row whose field both shells read now, and a `RustOnly` or `Runtime` row goes stale the moment a shell spells its field. The match is by field name, so two messages sharing a name share a verdict, and an argument passed positionally never spells it; a register comment says so where that is why a row is there.

Adding an app screen is a Rust change ([docs/screens.md](../docs/screens.md), "Writing a screen"): protos, a screen, strings, a registry entry. The shells then need a view for the new `ViewState` arm — one SwiftUI file and one Compose file under the app's folder, routed from `RustScreenHost.swift` and `screens/RustRoot.kt` — and nothing else: a route is whatever the row carries.

### Reads the shells perform for Rust

Rust decides what to read, when and what to do with it (windows, the zero rule, diffs, which vault rows change); the shell reads the phone and answers.

- **Health** (`HealthRead` → `HealthSnapshot`): nothing is ever written to HealthKit or Health Connect (R-1129-7), so iOS asks `requestAuthorization(toShare: [], read: …)` and Android declares `READ_*` permissions only (`HealthKitReadOnlySpec`, `HealthConnectReadOnlySpec`). Day totals come from the store's own statistics (HealthKit's `HKStatisticsCollectionQuery`, Health Connect's `aggregateGroupByPeriod` by local day, so a watch and a phone counting the same steps count once); sleep is the asleep minutes of the nights that end on the day, overlapping sessions merged and awake stages left out; weight is a day's last weighing. The OS is asked only at the member's Connect tap. **Android** (`kit/HealthConnectReader.kt`, performed from `kit/ScreenEffects.kt`): `androidx.health.connect:connect-client` declares minSdk 26 and the app stays at 24, so the manifest admits that one library below its floor (`tools:overrideLibrary`) and nothing touches a class of it below API 26 or while `HealthConnectClient.getSdkStatus` says Health Connect is not available: the snapshot then says `store_present = false` (`installable` where Google Play can bring it). Health Connect's rationale intents (Android 13's action, 14's permission-usage alias) open `HealthRationaleActivity`, which brings the app forward on Health's Connect page. `HealthConnectReadOnlySpec` fails on a write permission, on any `insertRecords`/`updateRecords`/`deleteRecords`, and on the permission sheet being built or launched anywhere but the reader and `ScreenEffects.kt`.
- **Contacts** (`ContactsRead`): iOS reads per `CNContainer` (the origin is `container:<id>`, one contact linked across two containers is kept once under the lowest origin id, and the read is incomplete under limited access (iOS 18) or when a container would not read); Android reads the contacts provider (`screens/people/PhoneContacts.kt`). A following pass never asks the OS for access.
- **Calendar and reminders** (`CalendarRead`, `RemindersRead`): iOS EventKit (reminders: the open ones); Android the calendar provider (`screens/agenda/CalendarImporter.kt`), with no reminders source. A watch (`PhoneWatch`) reports `PhoneChanged` on `CNContactStoreDidChange` / `EKEventStoreChanged` or the content observers.
- **Followed folders** (`FoldersRead`, `StageFolderFile`; `FollowFolder`, `StopFollowing`): the persisted access to a folder is the shell's and never the vault's, keyed by the origin id Rust minted — a security-scoped bookmark on iOS, the tree URI with `takePersistableUriPermission` on Android (`screens/docs/DocsFolders.kt`). A folder with no usable access is left out of the listing and Rust treats it as gone; a listing that failed part-way, or met an iCloud placeholder (`.name.icloud`), is `complete = false`.
- **The photo library** (`LibraryPermission`, `RollPage`, `LibraryStage`, `LibraryDerivatives`, `LibraryDelete`): each resource streams from the OS library into the stage door with its `os_ref` and no copy; a Live Photo is one asset with two resources; burst members and RAW get no inferred grouping; an original only in iCloud is downloaded only when Rust says the link allows it. `LibraryDelete{items}` asks the system's own confirmation and answers `LibraryDeleted` with the hashes that went. iOS asks `PHAccessLevelReadWrite` and the first walk is a keyset on `creationDate` with the `localIdentifier` as tiebreak.

## Seeing it with real data: make a vault

**The phone is the vault** (#1029 §1). Nothing is paired and nothing is placed: the shell founds its own vault, in the app's own data directory, and that file is the authority. A device that holds no vault opens onto Home's first-launch view (`FirstLaunchView.swift`, `screens/words/FirstLaunchScreen.kt`; Rust's `home.first_launch`) over **Get started** and **Restore backup**; both open `words.make` or `words.enter` rather than founding at the tap. With a vault already held, the gear → **Vault** → **Make a vault on this phone** adds another. Onboarding asks the core for the teaching starter rows (`FOUND_CONTENT_STARTERS`, `crates/core/src/starters.rs`) and founds nothing else ([R-ONBOARD-1…12](../docs/decisions.md#deliberate-non-goals)); `maestro/flows/onboarding.yaml` is the claim.

**Pairing is with a gateway the member runs, for its sealed backup** ([#1080](https://github.com/srikanth235/centraid/issues/1080); [R-1047-E12](../docs/decisions.md#identity-and-enrollment)). The gateway runs `centraid-gateway pair --data-dir <dir>`, which prints a pairing payload as text and as a square; the phone's **Pair with your backup device** screen (`pair.laptop`) takes the scan or the pasted text. `mobile/scripts/demo-vault.sh` seeds two vault files and places `demo-vault.sqlite3` and `work-vault.sqlite3` as `<vault dir>/demo-vault/vault.db` and `<vault dir>/work-vault/vault.db` — one directory per vault, the layout every founded and restored vault has — so the switcher lists them beside whatever the device founded itself.

#### The demo vault opens keyed

**Locker unlocks only on a KEYED core** ([D-6](../docs/decisions.md#locker)): `K` is derived from the seed at `centraid_open`, so a core opened without the member's seed and the vault's derivation index refuses the unlock. The Rust shelf (`crates/screens/src/vault`) keys every open it can from the secrets the shell's stores hold (`SecretBatch`): a vault with no index recorded opens unkeyed rather than at a guessed 0, because two vaults at one index are one identity and one `K`.

The demo can be keyed without walking the words, by a **debug-only** launch value:

1. Build and install the debug app, boot the simulator or emulator, and launch it once so its data directory exists.
2. `mobile/scripts/demo-vault.sh ios` (or `android`). It seeds both vaults under the demo words at index 0, places them, and relaunches the app with `CENTRAID_DEMO_SEED` — as `SIMCTL_CHILD_CENTRAID_DEV_SEED` on iOS (read under `#if DEBUG` in `ShellModel.devSeedHex`, handed to Rust as `devSeed`), as the `dev.centraid.DEV_SEED` extra on Android (read only when the app is debuggable). The shelf stores it where a real seed lives and records index 0 for every held vault that has none, so later plain launches stay keyed. Android's store is Block Store, which needs Google Play services on the emulator.
3. Home → Locker → **Unlock with your face** → Features → Enrolled Face → Matching Face in the simulator's menu. The five demo items reveal; `seed_demo_vault.rs` proves the same words reveal them and any others do not.

A release build compiles `nil` on iOS and never reads the Android extra, and neither shell holds the demo words or their seed in source. To drop the demo seed, delete the app.

## The 24 words, and pairing: what the views must do

The screens are Rust's (`words.make`, `words.enter`, `words.show`, `pair.laptop`; [docs/screens.md](../docs/screens.md)); the views are `Sources/WordsViews.swift` and `PairLaptopPageView.swift` on iOS and `screens/words/` and `screens/pairing/` on Android. Three duties belong to the views while a screen's `secure` is set, because nothing in Rust can perform them:

- **Capture shielding, no clipboard, no autocorrect or keyboard learning on the cells.** **Android** sets `FLAG_SECURE` on the activity window **and** on the sheet's own dialog window (a `ModalBottomSheet` is a separate window, and the activity flag alone does not cover it); its word fields drop the text toolbar and the clipboard (`LocalTextToolbar`, `LocalClipboard`) and ask the keyboard for `IME_FLAG_NO_PERSONALIZED_LEARNING`, `NO_SUGGESTIONS` and `VISIBLE_PASSWORD` — Gboard ignores `NO_SUGGESTIONS` on plain text. **iOS** hosts the content in a secure text field's canvas and covers it while `UIScreen.isCaptured` or the scene is not active; `WordField` is a UIKit field with no edit menu, paste, drag or drop, and no autocorrection, spelling, prediction or content type. A simulator screenshot reads the framebuffer, so the iOS shield is verified only on a device ([SECURITY.md](../SECURITY.md#the-claim-register)). `NoAutofill` also keeps Android's autofill service off the Locker editor.
- **The scan is the shell's** (`ScanCode`): with no camera the effect answers a photo picker, and a refusal falls back to paste. iOS reads the square with AVFoundation (`AVCaptureMetadataOutput`, `.qr`) rather than VisionKit's `DataScannerViewController`, which needs an A12, and asks for camera access only when the scan is tapped. **Android** reads it with CameraX (`camera-camera2`, `-lifecycle`, `-view`) feeding ZXing's `MultiFormatReader` (QR only, inverted codes too, for a light-on-dark terminal) in `screens/words/PairScanner.kt` — pure Java, no Google Play services and no model download ([R-1047-E14](../docs/decisions.md#the-mobile-shell)). The manifest declares `CAMERA` with `android.hardware.camera` and `camera.any` as `required=false`; because the permission is declared, Docs' Scan asks for it at the tap too and answers the `PickFile` effect `denied` on a refusal (`screens/docs/DocsFiles.kt`).
- **Discovery** (#1080): the pairing payload carries the gateway's addresses, the core keeps them in its ledger, and the background uploads dial those. `serve` advertises `_centraid-gateway._tcp`, and iOS declares it in `NSBonjourServices` beside `NSLocalNetworkUsageDescription`. **iOS browses** (`GatewayBrowser.swift`, `NWBrowser`) when Rust asks (`BrowseGateways`): each result carrying a TXT `gw` is resolved to `host:port` by one outbound connect per IP family and reported as `GatewaysSighted`; the match is by `gw` and never by name, and the core's `refresh_destination` keeps an address only if the pinned certificate and `/v2/info` confirm that gateway. The phone never listens. **Android browses too** (`session/NsdBrowse.kt`, `NsdManager.discoverServices`, #1152): the same effect, answered the same way. A discovered service carries no TXT record until it is resolved, so Android resolves every advertisement of the type and drops the ones with no `gw` afterwards (iOS drops them before its connect); from Android 14 the service-info callback reports every address, below it `resolveService` gives one and runs one at a time. A multicast lock is held only while a window runs (`CHANGE_WIFI_MULTICAST_STATE`), and a browse ends on `on: false` or when the runtime closes the screen that asked (`session/GatewayBrowsing.kt` against `Screens.views`). The phone never listens on either platform, and the real-network check on a phone is a hand-off (above).

## Thumbnails, and the two traps between a byte and a pixel

The core answers a byte-door request with a **path**, never bytes: the platform opens the file, so decoding and caching stay where they belong (`ContentImage` on both shells). Two things will waste an afternoon if you do not know them:

- **`UIImage(contentsOfFile:)` leans on the path extension.** A content-addressed file is named by its digest and has none, so that initializer returns nil for every photograph in the store — silently. `UIImage(data:)` sniffs the bytes, and is the only thing that can be right when the name is a hash.
- **The Rust archive is linked by path** and nothing rebuilds it. See [docs/traps/stale-core-slice.md](../docs/traps/stale-core-slice.md) and step 0 above.

A cell stays a placeholder when the door says the bytes are not here, when it refuses to call them embeddable (`image/svg+xml` is executed by a renderer in the embedding page's origin), or when they are **not a still image** — a video's thumbnail is its poster derivative, and handing a mosaic an MP4 draws a blank that reads as a failed render.

## The backup plane, native half (#1080)

The pass service in Rust decides when a pass runs, over what, and what the Backup screen and Home's line say ([docs/mobile-offline.md](../docs/mobile-offline.md)). The shells carry the platform's half:

- **Windows.** Rust sends the windows it wants (`ScheduleWindows`) and the shell maps each onto the OS, then reports `ShellFact.window` when one opens and answers `PassWindowDone`. iOS asks for the refresh window (`dev.centraid.sync-pass`) and a processing window that needs external power and a network (`dev.centraid.upload-pass`), and resubmits after every pass because a `BGTaskRequest` is one-shot. Android enqueues WorkManager work (`backup/PassWork.kt`): a periodic window on Wi-Fi unless the rule lets photographs cross cellular, an hourly night shift on a charger and Wi-Fi, and a one-off nudge under the rule's floor.
- **The mover on iOS.** The pass service hands parts to the shell as `UploadsOp`; the shell installs its background `URLSession` (`BackgroundUploads.swift`, TLS pinned to the paired gateway certificates) and reports each finished task as `UploadSettled` / `UploadsDrained`. A changed rule cancels every task the OS holds, because each keeps the cellular flag it was handed off under. Android moves bytes in-process and has no twin of this file.
- **Back up now** is a run the platform keeps alive (Android's user-initiated job or a `dataSync` service, `backup/BackupNow.kt`; iOS's awake screen); a second press while a run goes starts nothing. The battery sentence is Rust's; whether battery saving applies is the shell's to read and report.
- **The way back and free-up-space.** The download arrow on a grid cell or the lightbox is Rust's `fetch_original`; freeing space runs Rust's census/releasable/released flow and asks the shell only `LibraryDelete` (`PhotoLibraryDeleter.swift`, `backup/MediaStoreDeleter.kt`).

## Android, end to end

```sh
mobile/scripts/android-core.sh                                   # the Rust core, first
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:installDebug
mobile/scripts/demo-vault.sh android                             # two seeded vaults — "Seeing it with real data" above
```

The app screens are covered on Android by `:androidApp:assembleDebug` and its unit tests; the emulator is the hand-off for walking them, and `adb` hangs on some hosts — when it does, say so rather than claim a walk.
