# `mobile/` — the KMP shared module and the two native shells

One Kotlin Multiplatform shared module over the five-function C ABI, with a Compose shell and a SwiftUI shell that render finished state messages and own nothing ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

```
mobile/
├── core/        the C ABI binding — JNA on JVM and Android, cinterop on iOS
├── shared/      the shell, the apps, the screen contract, navigation, sync
├── androidApp/  Compose. Gated on -Pcentraid.android=true + ANDROID_HOME
├── iosApp/      SwiftUI + XcodeGen + SPM. Needs a macOS host
└── maestro/     the Home device flow, and the iOS transfer experiment's protocol
```

## What runs here, and what is a hand-off

This is the most important table in this file. **Nothing in the right-hand column reads green in CI**: there is no Android SDK, no Xcode, no simulator and no device on the machines that run `cargo xtask gate`, and every claim that needs one is an owner hand-off with a command below.

**SEVERAL HAVE BEEN CASHED, AND BOTH SHELLS HAVE BEEN SEEN.** On an owner's Mac with Xcode 26.6 the iOS shell compiles, links the XCFramework, runs its test bundle green on a simulator (24 tests), and runs on a simulator drawing Home from the real `HomeMachine` over the real Rust core. **Android now does the same** on an `sdk_gphone64_arm64` emulator: same seeded vault, same tiles, same thumbnails, same vault switcher. The rows below say so where it is true.

| Provable on this machine (JVM) | An owner hand-off |
| --- | --- |
| the screen state machines, the navigation model, the mount rules, the shelf's derivations, the `VAULT_MOVED` freeze — Kotest + Turbine on `jvmTest` | the Compose screens rendering — **seen**: Home on an emulator, reading a seeded vault through JNA and the real core |
| the **real ABI round trip**: `open → call → next_event → free → close` from Kotlin over JNA against `libcentraid_core_ffi.so`, on a vault the Rust fixture binary founded | the same round trip through cinterop on iOS |
| the UI-thread assertion, the buffer accounting, the poison handling, the bounded-queue behaviour | a panic injected by the real library (it has no fault-injection point — see `contracts/handoff/E/proposed-patches.md`) |
| 26 `contracts/screens` fixtures decoded by Wire, with the screen laws asserted | the same 26 decoded by SwiftProtobuf — **run: 17 tests, green**, step 4 below |
| the emitted app catalogue, identity marks and band places (`CatalogSpec`) | every emitted silhouette PARSING in the Swift path reader (`IconSilhouetteTests`) — **run: 3 tests, green** |
| `commonMain` is platform-free (Konsist), icon-only controls carry labels (a source scan over both surfaces) | Roborazzi and swift-snapshot-testing snapshots |
| the emitted token table matches `packages/design` in both schemes, in Kotlin, in Swift and in JSON | the iOS framework linking, and the XCFramework — **both done** |
| the `call` budget for the three screens' reads, measured | the device numbers that promote `tests/journeys.json`'s parked ceilings |

## The one command the gate runs

```sh
cd mobile && ./gradlew mobileJvm
```

`:shared:jvmTest`, `:core:jvmTest` and `:shared:koverXmlReport`. It is the `mobile-jvm` step of `cargo xtask gate --profile mobile-jvm`, which `gate-nightly.yml` runs.

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

## Building the Android app

```sh
export ANDROID_HOME=/path/to/Android/sdk
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:assembleDebug
```

Without the flag, `:androidApp` **is not in the build at all** and `mobile/settings.gradle.kts` says so once, on every configuration. With the flag and no `ANDROID_HOME`, it refuses with the sentence that names this section. It never skips silently.

A **release** build (`assembleRelease`, and the release lane's `bundleRelease`) is shrunk and obfuscated by R8; a debug build is not. The keep rules are `androidApp/proguard-rules.pro`, and they exist for JNA: its native dispatcher reaches back into `com.sun.jna` by name, and `CentraidLibrary`'s method names are the C symbols. A class reached by name that a debug run exercises and a release run crashes on is a missing rule there.

The AGP plugin is added to the build classpath **only** when the flag is set (`mobile/build.gradle.kts`'s `buildscript` block), so a machine with no SDK does not pay a download to reach a failure. The consequence is that `kotlin { androidLibrary { … } }` is configured **by name** rather than through typed accessors, and that block is therefore not type-checked here — the trade is stated in `mobile/core/build.gradle.kts` in full.

## The iOS hand-off

Everything on iOS needs a macOS host. In order:

```sh
# 0. THE RUST CORE, FIRST AND EVERY TIME IT CHANGES. The framework links this
#    archive by PATH, so Gradle does not know it exists and will happily link a
#    stale one with no error at all — see docs/traps/stale-core-slice.md, which
#    was written after a byte door that compiled on every layer and ran as the
#    version from five hours earlier.
cargo build -p centraid-core-ffi --target aarch64-apple-ios-sim

# 1. The Kotlin side, AND IT IS THE XCFRAMEWORK TASK, NOT THE LINK TASK.
#    `iosApp/project.yml` names
#    `shared/build/XCFrameworks/debug/CentraidShared.xcframework` as the
#    framework dependency, and `:shared:linkDebugFrameworkIosSimulatorArm64`
#    does not write that path — it produces a plain `.framework` under
#    `shared/build/bin/`, leaves the XCFramework as stale (or as absent) as it
#    found it, and reports success. Xcode then builds against whatever bytes
#    were last assembled, so a Kotlin change simply does not reach the app and
#    nothing anywhere says so — the same silent-staleness shape as the Rust
#    slice, one layer out (docs/traps/stale-core-slice.md).
#    Cinterop needs an Apple toolchain, so klib cross-compilation is OFF on
#    Linux and back ON here.
#    The task links EVERY slice it holds, and each force-loads its own Rust
#    archive, so on a Mac that built only the simulator archive above it
#    fails on `target/aarch64-apple-ios/debug/libcentraid_core_ffi.a`. For a
#    simulator build, pass `-Pcentraid.iosSimulatorOnly=true`: the XCFramework
#    then holds the one `ios-arm64-simulator` slice, at the same path. A
#    device build leaves it off and builds `aarch64-apple-ios` (and
#    `x86_64-apple-ios`) first.
cd mobile && ./gradlew -Pkotlin.native.enableKlibsCrossCompilation=true \
    -Pcentraid.iosSimulatorOnly=true \
    :shared:assembleCentraidSharedDebugXCFramework

# 2. The generated Swift types. `buf.gen.yaml` is documentation-only
#    (`plugins: []`), so this is protoc directly; the output is gitignored.
protoc --proto_path=../../crates/api-proto/proto \
    --swift_out=Sources/Generated --swift_opt=Visibility=Public \
    $(find ../../crates/api-proto/proto -name '*.proto')

# 3. The Xcode project. `project.yml` is the source; the `.xcodeproj` is NOT
#    committed (mobile/.gitignore). Re-run it after
#    ADDING a source file: the target globs a directory, and a new
#    `Sources/**.swift` is invisible until the project is regenerated.
brew install xcodegen
cd mobile/iosApp && export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate

# 4. The tests — the other half of "one fixture, two languages", plus the
#    icon silhouettes and the font registration. A SIMULATOR and not
#    `swift test`: see the note below.
cd mobile/iosApp && xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

**Which steps a change needs.** Every step is silent when skipped, so the rule is by what changed, not by what failed:

| You changed | Re-run | Why it is silent otherwise |
| --- | --- | --- |
| anything under `crates/` the core links — an `app_query` arm, a command, a proto | 0, then 1 | the framework links the Rust archive by path; a stale slice answers the old arm and nothing says so ([stale-core-slice](../docs/traps/stale-core-slice.md)) |
| `mobile/shared/src/commonMain` (a machine, a bridge, copy) | 1 | Xcode links `XCFrameworks/debug/CentraidShared.xcframework`; check with `find shared/src/commonMain -newer shared/build/XCFrameworks/debug/CentraidShared.xcframework` |
| `crates/api-proto/proto/**` (`screen.proto`, `app_query.proto`) | 2, and 1 for the Wire side | `Sources/Generated` is gitignored and only protoc writes it |
| a new `Sources/**.swift` file | 3 | the target globs a directory, and the project is generated |

Building beside other work on one Mac: give each `xcodebuild` its own `-derivedDataPath`, and run one Gradle build at a time — two Kotlin/Native links contending for one daemon run out of memory rather than failing cleanly.

**`swift test` IS NOT THE COMMAND, AND HAS NOT BEEN SINCE #1020.** This file said it was for a long time, with a green count beside it. `Package.swift` still argues for it at length — a macOS floor, a commented-out `binaryTarget`, Kotlin-touching declarations behind `#if canImport(CentraidShared)` — and every one of those pieces is real. What defeats it is simpler and newer: `Sources/` imports **UIKit**, which is not a macOS framework and cannot be guarded into existence. `ShellModel.swift` took the first one in `a4dd49d0d` and `ContentImage.swift` the second in `b3832bb6e`, both #1020 waves, and the host build has failed at dependency scanning ever since — so the three files under `Tests/` were not merely unrun, they were **uncompiled**, and the counts this file carried were from before those commits.

The simulator bundle is the route now, and it is the better one regardless: `FontRegistrationTests` asserts `UIFont(name:)` resolves, that `UIAppFonts` names every emitted file, and that the 400 register resolves to the derived 470 face rather than a plain 400 static — none of which means anything without a real app bundle, since the last one reads `familyName` and the CoreText weight trait back out of the registered bytes. It needed two fixes to exist at all — `GENERATE_INFOPLIST_FILE` on the test target, which had no `Info.plist` and so was refused before compiling, and `PRODUCT_MODULE_NAME: CentraidApp` on the app target, because `Tests/` says `@testable import CentraidApp` and XcodeGen names a module after its target. **26 tests, 0 failures.**

**What step 2 unblocked:** `mobile/iosApp/Sources/StateViews.swift` used to funnel every decoder through one `unwired()` `fatalError`. The SwiftProtobuf types are generated (`Sources/Generated`) and every decoder in that file is real (#1025 S5, lane L5): the three-state read law is a Swift `enum` with three cases per screen, and a decode that fails renders the screen's LOADING state rather than an empty one, because an empty `.data` case would be a screen claiming an empty vault before it had read one.

**What was deliberately unimplemented on iOS, and what became of each** (#1025 S5):

|  | Where it stands |
| --- | --- |
| `IosSecureStore` | **Implemented** over `kSecClassGenericPassword` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a background task can read while locked and a credential cannot ride an iCloud or encrypted-backup restore onto another device. This row used to say the Keychain "needs a `Security.framework` cinterop that no machine in this repository's CI can build" — **that claim was never checked and is false**: `platform.Security` ships as a DEFAULT Kotlin/Native platform library, and the same compiler that was already compiling the file compiled `SecItemAdd` on the first try. It held the per-vault ENDPOINT KEY until #1029 §1 deleted the enrolment plane; what is in it now is `Shelf.FOREGROUND_KEY` and the member's transfer rule, and it is where W5's restore credentials land. |
| `IosNetworkStatus` | **Implemented** over `NWPathMonitor` (`platform.Network`, also a default platform library). `platformRefused` is now reserved for the monitor failing to answer within 2 s; a satisfied path is online and an unsatisfied one is offline, which are facts rather than refusals. While this row stood, it hard-coded `platformRefused = true` and `WriteGate` treats unknown as not-reachable — so **every write on iOS was refused, always**. `UIDevice.isBatteryMonitoringEnabled` is set at construction, without which `charging` read false for ever. |
| `IosMediaLibrary.page` | **Implemented** (#1025 S6, D-1025-S7-70/71/72). `PHAsset` enumeration keyset on `creationDate` with the `localIdentifier` as the tiebreak — `NSPredicate` over `PHAsset` cannot express `localIdentifier`, so the predicate is `>=` and the overlap is dropped in Kotlin — plus a **streamed `PHAssetResource` byte door** (`MediaLibrary.open`) that feeds `Staging`, so THE CORE hashes and the phone never names its own bytes. `requestPermission` now actually asks, at `PHAccessLevelReadWrite`; it used to return the current status, so the "Allow photo access" button could be pressed for ever without the system prompt appearing. A Live Photo is two assets sharing one `capture_group_id`; burst members and RAW get **no inferred grouping**; `phash` is derived at commit from bytes the vault holds rather than by the phone, which would be a second opinion about a value that merges nothing. The whole pass — enumerate, stage, commit `media.add_asset` — is `dev.centraid.shared.shell.CameraRoll`. The `needs` declaration a GATEWAY pulled bytes on went with the gateway (#1029 §1), and so did `Request::Intent`: the bytes are staged into this vault's own store and the command commits the row beside them. |
| `ShellModel.send` | **Wired for every screen, through the registry** ([#1047](https://github.com/srikanth235/centraid/issues/1047) K5). Home goes through `HomeBridge` and the Photos screens through their own bridges; every other app registers its bridges and routes through `AppRegistry` (see [Adding an app screen](#adding-an-app-screen)). A bridge lives in the app's own package because it names its screen's types and `PerAppLayoutSpec` keeps that inside `apps`. Each attaches to the ONE `HomeSession` — one session, whatever the number of open cores — through `HomeSession.attachScreen` (page reads, `sync/ScreenRuntime.kt`) or `HomeSession.attachQueries` (app queries, `sync/ScreenQueries.kt`), which serve the screen's `ReadPage` and route it onto the change stream. An unknown screen name is dropped, because in a build where every screen is wired it would only turn a typo into a crash on a member's phone. |

**`.xcode-version` is `26.6`, confirmed by the first real iOS compile.** The pin was `16.4` and had never been tested against anything; D-1020-E5a's rule was that the first compile confirms or replaces it. Kotlin/Native 2.4.20 **accepted** Xcode 26.6 — it refused nothing and named no other version — so 26.6 is what the file now holds, and it is a measurement rather than the guess the `16.4` was. `:shared:linkDebugFrameworkIosSimulatorArm64` links in **26 s** on an M-series Mac. **Thirteen** defects stood between the committed tree and a green test run, and a fourteenth (a `nm` invocation with GNU-only flags) kept the Rust symbol gate red on any Mac. None was visible to a machine that could not run these four steps.

## The other hand-offs

| What | The command | The evidence it should produce |
| --- | --- | --- |
| The iOS transfer experiment | `mobile/maestro/ios-transfer-experiment.md` — 5 states × 2 transports, 4 measurements | four JSON files the run writes under `receipts/experiments/ios-transfer/` (the path the `ios-transfer-experiment` device lane reads), and one line saying which decision row they land in |
| The Maestro flow | `maestro test mobile/maestro/flows` (one flow, `home.yaml`) with `MAESTRO_VERSION=2.6.1` — see [`maestro/README.md`](maestro/README.md) | a run ledger. **Add the `testTag`/`accessibilityIdentifier` values from `flows/selectors.md` first**, paired with the run that proves each selects exactly one thing |
| Android Macrobenchmark | `./gradlew -Pcentraid.android=true :androidApp:connectedBenchmarkAndroidTest` | the numbers that promote `tests/journeys.json`'s parked Android ceilings (R-1020-20: a named device, never an emulator) |
| Store enrolment | `docs/enrollment.md` + `.github/workflows/lane-release-mobile.yml` | an App Store Connect key and a Play service account, per `docs/release.md`'s per-lane secret rule |
| Swift snapshots | the step-4 command with `-only-testing:CentraidTests/Snapshot*`, after adding `swift-snapshot-testing` | committed reference images, one per screen per scheme |

## The ABI, in one paragraph

`dev.centraid.core.CentraidCore` is the only thing above `mobile/core` that knows the ABI exists. It opens, runs the handshake, checks the artifact identity, and hands up `CoreOutcome<Envelope>` — an answer or a typed refusal, never `null`. Every buffer the library allocates is copied into a Kotlin `ByteArray` and freed in the same `finally`, on every path including the timeout; `buffersHandedOver == buffersFreed` is asserted after two hundred calls. `call` is `suspend` and hops to the core dispatcher before it touches the ABI, and it asserts it is not on the UI thread **after** the hop — because the realistic bug is a shell that passed `Dispatchers.Main` as the core dispatcher, and that is the case the assertion has to catch. Read [`crates/core-ffi/CONTRACT.md`](../crates/core-ffi/CONTRACT.md) before touching any of it: ten clauses, each with a Rust test, and a shell's memory safety depends on claims that are not visible in the signatures.

`mobile/core` is the JVM binding spike (D-1020-D2-7) grown up. The spike's throwaway Gradle project was deleted in [#1047](https://github.com/srikanth235/centraid/issues/1047); the numbers that fixed the ABI's shape are in its receipt.

## Generated files — do not edit

| File | Generator | The drift check |
| --- | --- | --- |
| `shared/src/commonMain/kotlin/dev/centraid/design/Tokens.kt` | `contracts/tools/export-native-theme.ts` | `git diff --exit-code design copy mobile` |
| `shared/src/commonMain/kotlin/dev/centraid/design/Catalog.kt` | `contracts/tools/export-native-catalog.ts`, called by the above | the same |
| `iosApp/Design/{Theme,Catalog}.swift` | the same two | the same |
| `design/native-{theme,catalog}.json` | the same two | the same |
| `shared/src/commonMain/kotlin/dev/centraid/design/Copy.kt`, `copy/*.json` | **nothing — hand-maintained.** These files are the SOURCE, not an artifact; see the banner in `contracts/tools/export-native-theme.ts`. | none |
| `contracts/screens/**/*.bin` | `contracts/tools/build-screen-fixtures.ts` | `git diff --exit-code contracts/screens` |
| the Wire and SwiftProtobuf types | `crates/api-proto/proto` | `buf lint` / `buf breaking` |

One emitter, N committed artifacts, one lint that fails on drift. A hand-maintained Kotlin colour table would be a fourth lowering with no drift gate — and so would a hand-maintained app catalogue or icon set, which is why the emitter carries the catalogue and the silhouettes rather than eight app names and 139 silhouettes being typed into two languages.

## How `shared/commonMain` is laid out

One shell, many apps — the same shape as `crates/apps`, `copy` and `contracts/apps` (#1025 S5, D-1025-S5-1):

```
dev/centraid/shared/
├── shell/      Home, the springboard, first moves, the band, the vault roster,
│               the shelf and where this device's vaults live
├── screen/     THE CONTRACT, and nothing else: ScreenMachine + ScreenHost
├── kit/        the laws every app screen is built from — no app type in it
│   └── time/   civil-day arithmetic and words over the core's answers
├── apps/       agenda/ docs/ notes/ people/ photos/ tally/ tasks/ — each
│               app's machines, reads, writes and bridges
├── custody/    the 24 words, pairing and restore
├── nav/        the navigation model
├── sync/       the change stream, the page-read and app-query runtimes, the
│               drain and the shared failure mapping
└── platform/   the expect/actual seam, the device clock included
```

The copy is `dev/centraid/design/copy/<App>Copy.kt`, one file per app, each the hand-maintained twin of `copy/<app>.json`; `KitTimeMoneyCopySpec` fails when a twin drifts. `design/Copy.kt`'s `CentraidCopy` is a forwarding shim for the old spelling and goes once nothing reads it.

Two Konsist rules make the shape load-bearing rather than decorative (`PerAppLayoutSpec`):

1. **An `apps.<x>` package imports no other `apps.<y>`.** Two apps meet in the VAULT, as rows, and never in a reducer.
2. **Nothing outside `apps` imports from inside it.** The shell drives a screen through `ScreenMachine`/`ScreenHost`, which is what lets it host a screen it knows nothing else about; a `shell/` file naming `apps.tally.TallyListState` would be a shell that has to be edited to add an app. `kit` is outside `apps` too, so the kit names no app type.

A third assertion says `screen` holds exactly two files, because a screen that moved back into it is a screen rule 2 can no longer say anything about.

## The kit, the app queries, and adding an app screen

Every first-party app but Locker is on the phone: Agenda ([#1046](https://github.com/srikanth235/centraid/issues/1046)), Tasks, People, Docs, Notes and Tally ([#1047](https://github.com/srikanth235/centraid/issues/1047)), beside Photos. They are built from one kit on three layers, so a port supplies an app's content and copy and none of the plumbing. The rulings behind it are [R-1047-K1…K6](../docs/decisions.md#the-app-ports-and-the-shell-kit-1047).

### Reads: a page, or an app query

A screen reads one of two ways, and never joins tables itself:

- **A page read** (`ScreenReads`, `sync/ScreenRuntime.kt`) — one `PageRequest` over one table, for a screen that is one table (Photos' shelves, the kit's trash where an app has no trash query).
- **An app query** (`ScreenQueries`, `sync/ScreenQueries.kt`) — `Request::AppQuery` runs a registered query from the app's crate in the core and answers a typed message (`crates/api-proto/proto/centraid/core/v1/app_query.proto`, one `<app>.proto` per app). Everything that joins, expands a repeating series or folds a ledger goes here: Agenda's `upcoming`, the Tasks board, the People roster, the Docs drive, the Notes library, the Tally dashboard. `requests(state, now)` answers the queries for the state's destination, run in order; `arrived(answers, requests)` folds them into one event; one refused or denied query fails the whole read. `tables` is every table the queries read, and `AppReadsSpec` checks it against the machine's `rowsChanged` over the vault DDL. `HomeSession.attachQueries(host, queries, writes, left)` attaches one.

There is one query engine: no Kotlin or Swift code joins tables or expands an rrule. A read the phone needs and no arm answers is a new arm in the core, in its app's field range ([R-1047-Q1](../docs/decisions.md#the-app-ports-and-the-shell-kit-1047)).

### The device clock

`commonMain` has no calendar and no zone database. `platform/DeviceClock` answers `{zone, epochMillis}` — the IANA zone name and the wall clock — and `ScreenQueryRuntime` reads it at **every** read and hands it to `requests`, so a phone that crosses a border reads in the new zone on its next read. The core does all civil arithmetic in the request's `tz` and answers `today`, `now_local` and every `*_local` reading; a machine never derives "today" from `epochMillis`, which is for bounds only ([R-1046-2](../docs/decisions.md#agenda-on-the-phone-1046)). A blank zone is refused before the core is asked. `FakeDeviceClock` (jvmMain) is the specs' clock.

### The KMP kit (`kit/`)

| Piece | What it holds |
| --- | --- |
| `ReadContent` / `ContentLens` | the four read arms — loading, failed, denied, data — and a lens onto a screen's own `content` oneof |
| `PagedList` | page one replaces; a later page is appended only when its answered cursor matches the list's next cursor; no next page while a page-one re-read is out; `rowsChanged` re-reads |
| `BandLaw` | tapping the tab you are on does nothing |
| `SearchLaw` | closing search clears the term and its answer |
| `AutosaveLaw` | 900 ms after typing stops, flush on leave, one invoke key per edit, only changed fields, a vault change never overwrites typing ([R-1047-K3](../docs/decisions.md#the-app-ports-and-the-shell-kit-1047)) |
| `WriteLaw`, `InvokeKeys` | one write in flight per key; only `EXECUTED` counts as committed |
| `TrashSpec` → `TrashMachine` / `TrashReads` | one trash screen per app (`"<app>.trash"`); `purgeCommand = null` means the app has no destroy path and the screen offers restore only |
| `ScreenBridge` | the one bridge shape: `attach`, `observe`, `send` (Swift), `forward` (Compose), `current`, `departed`, `leave`, `close` |
| `MoneyFold`, `time/CivilDays`, `time/CivilWords` | money sums per currency, and day words over civil dates the core answered |

`departed()` is "the member left": the machine's `Left` runs (the autosave flush) and the bridge lives on. `leave()` also closes it. A write that fails after its screen was left is published on `HomeSession.strandedWrites`.

The proto half is the `// --- Kit ---` section of `screen.proto`: `Denied`, `EmptyState`, `SearchField`, `WriteState`, `WriteSettled`, `Autosave`, `Confirm`, `StatusChip`, `ListRow`, `SectionHead`, `TrashRow`, `TrashList*`.

### The native kit

| iOS (`iosApp/Sources/Kit/`) | Android (`androidApp/…/kit/`) | Room or part |
| --- | --- | --- |
| `ScreenContent`, `ReadStates` | `ReadState` | the four read arms, skeleton rows (never a spinner), failure with retry, empty state, the denied gate |
| `Rooms` | `Rooms` | `AppPlace`, `PushedPage`, `EditorRoom`, `SheetRoom` — the rooms of [DESIGN.md](../DESIGN.md) |
| `Rows` | `Rows` | `CentraidRow`, status chip, section header, show more |
| `Sheets` | `Sheets` | `ConfirmSheet`, `OptionSheet` / sheet rows |
| `CentraidSearchField` | `SearchField` | the one search field |
| `AutosaveStatus`, `TrashListView`, `Money` | `TrashListScreen`, `theme/Theme.kt` | the autosave line, the trash list, money rendering |
| — | `KitWords` | the kit's few fixed words no machine carries yet (retry, show more); they belong in `SharedCopy` |

Money renders natively from `{minor, currency, exponent}`; `contracts/screens/money-render.json` is the one fixture both shells are held to (`Tests/MoneyRenderTests.swift`, `androidApp/src/test/…/MoneyRenderTest.kt`).

### Adding an app screen

1. **Shared.** Append a `// --- <App> ---` section to `screen.proto` (messages prefixed with the app's name; state, data, event; every content oneof has loading, failure, the kit `Denied` and data). Write the machine, the reads (`ScreenQueries` or `ScreenReads`), the writes and a bridge in `apps/<app>/`; screen ids are `"<app>.<screen>"`. Append the app's block to `nav/Navigation.kt`, add the screen to `AppReadsSpec`, and put every word in `copy/<app>.json` and its `<App>Copy.kt` twin.
2. **iOS.** One file, `Sources/<App>/<App>Screens.swift`, conforming to `AppScreens`: `register(into:)` hands the shell a `ScreenPort.of(id, bridge)` per bridge and a `shell.route(id, open:, view:)` per screen, and `tileRoute` says where the Home tile leads. Then **one line** in `AppRegistry.apps` (`Kit/ScreenRegistry.swift`). A view pushes with `shell.path.append(.screen(id, parameterBytes))`; an editor passes `onDeparted: { shell.departed(id) }`. The destination switch in `CentraidApp.swift` sends `Opened` with `.task(id: route)`, so a swap in place re-opens (`NavigationAndMountSpec`).
3. **Android.** One file, `screens/<app>/<App>Routes.kt`, implementing `AppRoutes` (`handles`, `opens(moveId)`, `attach`, `back`, `Routes`), holding the app's bridges for the activity's life; `Routes` sends `Opened` from a `LaunchedEffect` keyed on the destination's parameters, collects `bridge.host.state` and passes `bridge::forward` as `onEvent`. Then **one line** in `MainActivity.routes`.
4. **Intents are the shell's.** A machine emits `EventPicked`, `NotePicked`, `SendToTasks` and the like and changes nothing; the view forwards the event, then pushes the destination (and opens the target bridge) or hands the OS its `tel:`, `mailto:`, map or share intent.

Views decide nothing: a label, sentence, chip, hue key, accessibility label, empty-state choice or enabled flag a view needs and the state does not carry is a gap in the machine, never a computation in Swift or Compose ([R-1047-K1](../docs/decisions.md#the-app-ports-and-the-shell-kit-1047)).

## Home, and the pattern the fan-out follows

Home is built (#1020). It is the hardest single screen — a graded springboard over eight unlike tile bodies — and its pattern is the one other screens follow. Four rules came out of it, and they are the ones a later screen should copy:

1. **THE VIEWS DECIDE NOTHING, including layout.** `earns_grid`, `springboard`, `things`, `every_tile_unreadable` AND `grid_rows` are all computed in `HomeMachine` and written onto the state. `grid_rows` is there because the first build let each renderer pack the grid and they disagreed immediately: Compose's `LazyVerticalGrid` honours a span and SwiftUI's `LazyVGrid` **silently ignores `.gridCellColumns`**, so one shell drew Photos full width and the other drew it at a half. Two packers for one grid was the defect; one packer in the machine is the fix.
2. **EVERY VALUE IS A TOKEN OR A STATED GEOMETRY.** No `.secondary`, no `.quaternary`, no SF Symbols, no Material icons. The first build of Home used all four and looked like a SwiftUI sample rather than the product; the token table and the emitted silhouettes are what make the two shells draw one thing.
3. **ONE ICON SET.** `Catalog.kt`/`Catalog.swift` carry the same 24×24 path data the web renderer draws. Compose reads it with `PathParser`; iOS has `Sources/Icon.swift`, a small path reader, and `Tests/IconSilhouetteTests.swift` asserts every emitted silhouette parses — written after a greedy number scan made the Settings gear vanish with nothing failing.
4. **THE FRAME IS PART OF THE SCREEN.** The vault lockup (which vault, and how that vault stands on this device — and the mark IS the switch), the title row and the floating band are the product's chrome, not decoration, and a Home without them is a grid rather than a shell. The second fact is the VAULT's and never a gateway's name ([D-1025-S7-9](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). `VaultLockup.State` has three cases — syncing, synced, offline — and since #1029 §1 the shell reaches only ONE of them: the phone is the vault, so a vault this device holds is a file that opened and there is no pass whose outcome the other two described. The enum lives in `crates/api-proto` and trimming it belongs to that crate's lane; `Shelf.Holding.state` says so where it answers.

### Seeing it with real data: make a vault

**The phone is the vault** (#1029 §1). Nothing is paired and nothing is placed: the shell founds its own vault, in the app's own data directory, and that file is the authority.

In the app: the gear → **Vault** → **Make a vault on this phone**, which opens `words.make` (below) rather than founding at the tap; **Restore my vaults** beside it opens `words.enter`. The empty switcher offers both, because a device holding zero vaults is an onboarding surface (R-SHELL-3).

**It works, and the door is `envelope.proto`'s rather than the command registry's** ([#1029](https://github.com/srikanth235/centraid/issues/1029) W5). `Core::open` with `create` lays the migrations down, and the `FoundRequest` arm makes those tables a VAULT: `VaultRoster.found` sends one envelope, `crates/core`'s `api::found` writes `core_vault` and the owner's `core_party` in one commit, and the response carries the new vault id. Nothing is read back off that response — the shelf calls `VaultRoster.identify` afterwards, because the name a member sees has to come out of the vault rather than out of the string the shell happened to send. There is deliberately no `vault.found` COMMAND: founding is the one act that happens before there is a vault to run a command against, so it is an envelope arm and not a `Registry::with_system_commands` entry. `FoundRefusal.NOT_FOUNDED` survives, and it is now the REFUSED case rather than the standing state of the build — a file that already holds a vault (`ERROR_CODE_VAULT_ALREADY_HELD`, which `api::found` raises rather than minting a second `core_vault` row in one file), or a core that answered and then could not name what it made. On that path `Shelf.found` still deletes the file it just made, because a `.sqlite3` that names no vault is one every later `Shelf.load` lists, `VaultRoster.identify` refuses, and the member who made it never sees. `FoundDoorSpec` is the claim.

**Pairing is with the member's own laptop, for its sealed backup** ([R-1047-E12](../docs/decisions.md#the-24-words-on-the-phone-1047-e1)). The laptop runs `centraid-gateway invite --data-dir <dir>`, which prints the invite and a `pair` ticket as text and a square; the phone's **Pair with your laptop** screen (`pair.laptop`, `PairLaptopBridge`) takes the scan or the pasted line, the core redeems the invite and claims the lease, and the screen shows the pairing's **safety number** — the 60 digits `centraid-gateway serve` prints once the invite is redeemed ([D-9](../docs/decisions.md#the-owners-rulings-of-2026-09-29-1047)). Only a keyed vault pairs; an unkeyed one gets **Enter your 24 words**, the re-key Locker's wall offers ([D-11](../docs/decisions.md#the-owners-rulings-of-2026-09-29-1047)). The seat-era recipe (`Shelf.admit`, `Replicas`, `Enrolments`, `PairOk`) stays deleted. `mobile/scripts/demo-vault.sh` still seeds two vault files, and **both shells read them**: it places `demo-vault.sqlite3` and `work-vault.sqlite3` as `<vault dir>/demo-vault/vault.db` and `<vault dir>/work-vault/vault.db` — one directory per vault, the layout every founded and restored vault has (`Shelf.VAULT_FILE`, #1047 Q-1047-17) — so the switcher lists them beside whatever the device founded itself, each with a backup home of its own.

#### The demo vault opens keyed

**Locker unlocks only on a KEYED core** ([D-6](../docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)): `K` is derived from the seed at `centraid_open`, so a core opened without the member's seed and the vault's derivation index refuses the unlock, and the wall says "Locker needs your 24 words" before any Face ID prompt. `Shelf` keys every open it can — launch, making a vault, a woken holding, a switch — by reading the seed out of `VaultSecrets` (the synchronised store) and the vault's index out of the device store (`vault-index.<vaultId>`) at the moment of the open, handing both to `centraid_open` in the `CoreConfiguration`, and keeping neither: a holding carries `keyed`, never the key. A vault with no index recorded opens unkeyed rather than at a guessed 0, because two vaults at one index are one identity and one `K`. Making a vault with a seed on the phone takes one past the highest index this phone ever recorded; with no seed it records none. `KeyedOpenSpec` is the claim.

#### The 24 words (#1047 E1)

The product puts the seed on the phone through shared screens ([R-1047-E1…E7](../docs/decisions.md#the-24-words-on-the-phone-1047-e1)), drawn by `Sources/WordsViews.swift` on iOS and `screens/words/` on Android.

- **`words.make`** (`VaultWordsBridge`, `VaultWordsMachine`) replaces the bare make-vault tap. A phone with no seed has the core mint 24 words (`PhraseRequest.mint`), shows them once with `secure` set, asks three positions back, then has the core derive the seed, stores and settles it in `VaultSecrets`, and only then founds the vault — keyed at the next index. A phone whose seed is settled founds at once with no words; one holding a seed that arrived by sync is sent to restore first (`PHASE_RESTORE_FIRST`).
- **`words.enter`** (`WordsEntryBridge`, `WordsEntryMachine`) is the 24-cell grid, judged by the core on every keystroke (`PhraseRequest.check`: list word or not, suggestions, count → unknown word → checksum). `PURPOSE_RESTORE` runs the core's `restore` over the shelf's vault-less custody core and holds each vault it lays down (`<dir>/<id prefix>/vault.db`) at its restored index with the restored device secret; `PURPOSE_REKEY` is Locker's "Enter your 24 words" (`LockerLockState.words_label`), which hands the words back and reopens every vault with a recorded index keyed.
- **The views' three duties** while `secure` is set — capture shielding, no clipboard, no autocorrect or keyboard learning on the cells — are written in `screen.proto`'s words section, because nothing in `commonMain` can perform them. **Android** sets `FLAG_SECURE` on the activity window **and** on the sheet's own dialog window (a `ModalBottomSheet` is a separate window, and the activity flag alone does not cover it); its word fields drop the text toolbar and the clipboard (`LocalTextToolbar`, `LocalClipboard`) and ask the keyboard for `IME_FLAG_NO_PERSONALIZED_LEARNING`, `NO_SUGGESTIONS` and `VISIBLE_PASSWORD` — Gboard ignores `NO_SUGGESTIONS` on plain text. **iOS** hosts the content in a secure text field's canvas and covers it while `UIScreen.isCaptured` or the scene is not active; `WordField` is a UIKit field with no edit menu, paste, drag or drop, and no autocorrection, spelling, prediction or content type. A simulator screenshot reads the framebuffer, so the iOS shield is verified only on a device ([SECURITY.md](../SECURITY.md#the-claim-register)). `NoAutofill` also keeps Android's autofill service off the Locker editor.
- **The device secret** is the core's, minted at pair or restore and passed back at every keyed open; `VaultSecrets` no longer mints one.
- **A refused restore says which refusal** ([R-1047-R4](../docs/decisions.md#a-restore-that-holds-1047-r3)). `CoreRestoreDoor` answers `RestoreResult`, and words.enter draws "could not reach your laptop" only for `PEER_UNREACHABLE`; a laptop that would not grant the lease and a backup that failed this phone's check each have their own sentence (`WordsCopy.RESTORE_NOT_TAKEN`, `RESTORE_DID_NOT_CHECK`). The words stay on screen for all three, and the core has moved no lease for the last one.
- **A vault that stayed with the old phone is named** ([R-1047-R5](../docs/decisions.md#a-restore-that-holds-1047-r3), #1047 F8). A restore whose later claim failed answers the claimed vaults and `RestoreResponse.unclaimed`; `CoreRestoreDoor` carries it as `RestoreAnswer.unclaimed` (index and id, never the core's support-log `reason`), and words.enter's DONE draws one `WordsEntryState.stayed` sentence per vault, numbered with the restored lines in one sequence by index, under "Some of your vaults are back". Its `retry_label` ("Try again", [R-1047-R6](../docs/decisions.md#a-restore-that-holds-1047-r3)) sends `Retry`: `Enrollment.restoreStayed` asks the core for those indices alone (`RestoreRequest.indices`) from the seed the restore stored, the vaults already here are never laid down again, and what comes back joins the list while a refusal leaves both lists standing with a sentence.

**Where the member finds words.show and pair.laptop.** Both open from the band's **More** sheet, after the app list: **Show my 24 words** (`WordsCopy.SHOW_AGAIN_ROW`, iOS `home-more-show-words`) and **Pair with your laptop** (`CustodyCopy.PAIR_TITLE`, `home-more-pair-laptop`). The More sheet closes first, then the screen opens (#1047 E5). **The scan is the shell's**: `PairLaptopBridge.open(camera:)` takes whether the device has a camera, and with `false` the machine draws no `scan_label`, so the screen is paste-only. iOS reads the square with AVFoundation (`AVCaptureMetadataOutput`, `.qr`) rather than VisionKit's `DataScannerViewController`, which needs an A12, and asks for camera access only when the scan is tapped; a refusal falls back to paste. **Android** reads it with CameraX (`camera-camera2`, `-lifecycle`, `-view`) feeding ZXing's `MultiFormatReader` (QR only, inverted codes too, for a light-on-dark terminal) in `screens/words/PairScanner.kt` — pure Java, no Google Play services and no model download ([R-1047-E14](../docs/decisions.md#the-24-words-on-the-phone-1047-e1)). The manifest declares `CAMERA` with `android.hardware.camera` and `camera.any` as `required=false`, and the grant is asked for only when Scan is tapped; a refusal leaves the paste field. **Declaring `CAMERA` changed Docs Scan**: the system capture intent throws without the grant once the manifest names the permission, so Docs' Scan now asks for it at the tap too and answers `scanRefused(PERMISSION_DENIED)` on a refusal (`screens/docs/DocsRoutes.kt`). No Bonjour and no local-network permission on either shell: the ticket carries the laptop's addresses, so nothing browses the local network, and iOS declares only `NSLocalNetworkUsageDescription` for the direct dial.

- **A synchronised seed restores without words** (#1047 E4, [R-1047-E9](../docs/decisions.md#the-24-words-on-the-phone-1047-e1)). words.make's `PHASE_RESTORE_FIRST` names `restore_purpose = PURPOSE_RESTORE_HELD`; words.enter in that purpose has no grid, only the laptop address, and restores from the held seed (`RestoreRequest.seed`).
- **Settings shows the words again** (`words.show`, `WordsShowBridge`, [R-1047-E10](../docs/decisions.md#the-24-words-on-the-phone-1047-e1)). The words are kept in the device-only store whenever they become this phone's key; the screen reads them only after the view's owner check sends `Verified`, and drops them on Done, dismissal or leaving the foreground.
- **The found's crash window is closed** ([R-1047-E11](../docs/decisions.md#the-24-words-on-the-phone-1047-e1)): the index is spent against the new file's path before the core founds, and the next launch finishes or gives back a found the process did not live to record.

The demo can also be keyed without walking the words, by a **debug-only** launch value:

1. Build and install the debug app, boot the simulator or emulator, and launch it once so its data directory exists.
2. `mobile/scripts/demo-vault.sh ios` (or `android`). It seeds both vaults under the demo words at index 0, places them, and relaunches the app with `CENTRAID_DEMO_SEED` — as `SIMCTL_CHILD_CENTRAID_DEV_SEED` on iOS (read under `#if DEBUG` in `ShellModel.devSeedHex`), as the `dev.centraid.DEV_SEED` extra on Android (read only when the app is debuggable). `Shelf.load` stores it where a real seed lives and records index 0 for every held vault that has none, so later plain launches stay keyed. Android's store is Block Store, which needs Google Play services on the emulator.
3. Home → Locker → **Unlock with your face** → Features → Enrolled Face → Matching Face in the simulator's menu. The five demo items reveal; `seed_demo_vault.rs` proves the same words reveal them and any others do not.

A release build compiles `nil` on iOS and never reads the Android extra, and neither shell holds the demo words or their seed in source. To drop the demo seed, delete the app.

**A vault's name lives inside the vault** ([D-1025-S7-12](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). It is `core_vault.display_name`, read off the file by `VaultRoster.identify`, and that is unchanged by the deletion — what went is the ticket that carried a gateway's `--vault-name` flag as a placeholder until a copy landed.

**A file name is not an identity.** Vault files used to be `centraid-replica-<vaultId>.sqlite3` so the shelf could find a vault's enrolment record BEFORE opening it, and so a just-paired copy could be filed under the id the gateway had named. Neither exists, so `Replicas.settle`'s rename is gone with them: `Shelf` lists every `<dir>/*/vault.db`, asks each one which vault it is, and founds a new one in `centraid-vault-<random>/vault.db` — one directory per vault, so each has its own backup home ([R-1047-E8](../docs/decisions.md#the-24-words-on-the-phone-1047-e1)). A loose `.sqlite3` is not a holding.

**The byte store travels with the file.** `vault.db` has `vault.bytes` beside it in the vault's directory — the core's `with_extension("bytes")`, the last extension REPLACED and not appended. A vault without its store is a library of rows pointing at nothing ([D-1025-S3-1](../docs/decisions.md#slice-s3--bytes-both-ways-one-store-1025)), and it renders as placeholders rather than as an error, which is how the first draft of the rename got it wrong.

Four things about the switcher are worth knowing before you touch it:

- **The directory IS the roster.** Every `<name>/vault.db` in the shell's own data directory is a vault; there is no manifest beside them, because a vault's name lives inside the vault and a manifest would be a second place it lives. See `Shelf`.
- **`Shelf` owns the set, and nothing else adds to it.** At launch `Shelf.load` opens every file the same way — a path and no role, `create` false — asks each one `VaultRoster.identify`, and leaves it open; when the phone holds the seed and an index for that vault it reopens the file keyed first, because which index to derive at is a fact about the vault and the file name is not one ([above](#the-demo-vault-opens-keyed)). The `GATEWAY`-role probe that opened and closed each file in turn is gone with the one-core-per-process reading of R-1020-24, and the per-vault enrolment record is gone with the gateway it named (#1029 §1). Afterwards only `Shelf.found` and `Shelf.forget` change the membership. A file that will not open, or that will not say which vault it is, is simply not a holding: a row that fails on tap is a door that does not open.
- **The roster is a STREAM, not a one-shot survey.** `Shelf.roster` republishes on every membership or state change, so the switcher's rows and the header's second line are one value rendered twice and cannot disagree. The `VaultRoster.survey` that read the three stores once at launch is gone with `HomeEvent.VaultsListed`; `HomeEvent.RosterChanged` carries the stream, and `VaultRoster` is now only `QUERY` and `identify`. A vault admitted after launch used to be invisible until the app was relaunched.
- **Every held vault's core is open, and a switch costs nothing** (#1025 S7-13, [D-1025-S7-18](../docs/decisions.md)). `SingleHandleGuard` is keyed on the VAULT FILE PATH: R-1020-24 is that app extensions never open the vault, whose hazard is two handles on one FILE, and a process-keyed guard also refused two handles on two different vaults, which share no file. So a switch is a pure rebind — `HomeSession` re-points its runtime and change reader and nothing is closed or reopened. "Open" means the FILE and nothing else now: there is no endpoint and no dial (#1029 §6). The only two things that close a background core are `Shelf.forget` and `Shelf.rest()`, the OS asking for memory back (iOS `didReceiveMemoryWarningNotification`, Android `onTrimMemory`); a rested holding reopens on the next touch. There is no cap and no idle timeout.
- **`Shelf.forget` DESTROYS the vault** (#1029 §1). It used to delete this device's COPY — the gateway kept the vault and kept the device enrolled, so a re-pair got it back. There is no copy anywhere else, so both shells' confirmations say what it now does, and the restore that makes the trade survivable is #1029 W5's.
- **A vault that MOVED is frozen, not wiped** (#1029 F1). `Shelf.freeze` refuses writes with one sentence, shows the unacked spool as "N changes since `<date>`", and keeps everything. Both phones hold the same seed, so this is cooperation and not enforcement: nothing takes the vault back on its own, and there is deliberately no `thaw`.
- **A reload carries what the shell TOLD Home and replaces what Home READ.** `HomeState.reloaded()` is the only caller of `firstLoad()`. That rule used to live at the three call sites and was wrong at every one of them in turn — the lockup, then the roster, then the roster again on the switch branch. If you add a shell-known field to `HomeState`, add it to `reloaded()` in the same commit or it will vanish on the next open.

### Thumbnails, and the two traps between a byte and a pixel

Home's mosaic draws real photographs (#1020, D-1020-DC1). The path is worth knowing because nothing about it is guessable from either end:

1. `HomeReads`' photos query selects `content_id` **for the door, not for the body** — a thumbnail is located by CONTENT and read as the ASSET, so the runtime needs both ids off one row.
2. `HomeRuntime.thumbnails` batches one `ContentUrlRequest` for the four cells the mosaic will draw, **before** the tile's event is sent. A cell that arrived blank and acquired its photograph a moment later would be two states for one row and a visible pop on every open.
3. The core answers a **path**, never bytes: the platform opens the file, so decoding and caching stay where they belong.
4. `ContentImage` opens it.

Two things will waste an afternoon if you do not know them:

- **`UIImage(contentsOfFile:)` leans on the path extension.** A content-addressed file is named by its digest and has none, so that initializer returns nil for every photograph in the store — silently. `UIImage(data:)` sniffs the bytes, and is the only thing that can be right when the name is a hash.
- **The Rust archive is linked by path** and nothing rebuilds it. See [docs/traps/stale-core-slice.md](../docs/traps/stale-core-slice.md) and step 0 above.

A cell stays a placeholder when the door says the bytes are not here, when it refuses to call them embeddable (`image/svg+xml` is executed by a renderer in the embedding page's origin), or when they are **not a still image** — a video's thumbnail is its poster derivative, and handing a mosaic an MP4 draws a blank that reads as a failed render.

### Android, end to end

```sh
mobile/scripts/android-core.sh                                   # the Rust core, first
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:installDebug
mobile/scripts/demo-vault.sh android                             # two seeded vaults — "Seeing it with real data" above
```

The app screens are covered on Android by `:androidApp:assembleDebug` and the JVM specs; the emulator is the hand-off for walking them, and `adb` hangs on some hosts — when it does, say so rather than claim a walk.

**JNA is one library in two packages and the package is the extension.** Same group, name and version — `net.java.dev.jna:jna` — published both as a jar and as an `.aar`. The jar bundles `libjnidispatch` for DESKTOP ABIs as ordinary resources; the aar carries the Android ones as real `lib/<abi>/libjnidispatch.so` entries, which is the only shape a packager installs and `System.loadLibrary` finds. Getting it wrong fails two ways and both were seen:

- **jar on Android** — the app builds, installs, runs, Home draws, and the first `centraid_open` dies with `dlopen failed: library "libjnidispatch.so" not found`. A `@aar`-less catalogue alias resolves to the jar, so an entry that merely _looks_ like the Android one does exactly this. `unzip -l` the APK: if you see `com/sun/jna/win32-x86-64/jnidispatch.dll` and no `lib/arm64-v8a/libjnidispatch.so`, this is what happened.
- **both** — `checkDebugDuplicateClasses` refuses out loud, because every `com.sun.jna` class is in each.

`mobile/core/build.gradle.kts` names the `@aar` extension explicitly and says why; the version still comes from the catalogue.
