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
cd mobile && ./gradlew -Pkotlin.native.enableKlibsCrossCompilation=true \
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

**`swift test` IS NOT THE COMMAND, AND HAS NOT BEEN SINCE #1020.** This file said it was for a long time, with a green count beside it. `Package.swift` still argues for it at length — a macOS floor, a commented-out `binaryTarget`, Kotlin-touching declarations behind `#if canImport(CentraidShared)` — and every one of those pieces is real. What defeats it is simpler and newer: `Sources/` imports **UIKit**, which is not a macOS framework and cannot be guarded into existence. `ShellModel.swift` took the first one in `a4dd49d0d` and `ContentImage.swift` the second in `b3832bb6e`, both #1020 waves, and the host build has failed at dependency scanning ever since — so the three files under `Tests/` were not merely unrun, they were **uncompiled**, and the counts this file carried were from before those commits.

The simulator bundle is the route now, and it is the better one regardless: `FontRegistrationTests` asserts `UIFont(name:)` resolves, that `UIAppFonts` names every emitted file, and that the 400 register resolves to the derived 470 face rather than a plain 400 static — none of which means anything without a real app bundle, since the last one reads `familyName` and the CoreText weight trait back out of the registered bytes. It needed two fixes to exist at all — `GENERATE_INFOPLIST_FILE` on the test target, which had no `Info.plist` and so was refused before compiling, and `PRODUCT_MODULE_NAME: CentraidApp` on the app target, because `Tests/` says `@testable import CentraidApp` and XcodeGen names a module after its target. **26 tests, 0 failures.**

**What step 2 unblocked:** `mobile/iosApp/Sources/StateViews.swift` used to funnel every decoder through one `unwired()` `fatalError`. The SwiftProtobuf types are generated (`Sources/Generated`) and every decoder in that file is real (#1025 S5, lane L5): the three-state read law is a Swift `enum` with three cases per screen, and a decode that fails renders the screen's LOADING state rather than an empty one, because an empty `.data` case would be a screen claiming an empty vault before it had read one.

**What was deliberately unimplemented on iOS, and what became of each** (#1025 S5):

|  | Where it stands |
| --- | --- |
| `IosSecureStore` | **Implemented** over `kSecClassGenericPassword` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a background task can read while locked and a credential cannot ride an iCloud or encrypted-backup restore onto another device. This row used to say the Keychain "needs a `Security.framework` cinterop that no machine in this repository's CI can build" — **that claim was never checked and is false**: `platform.Security` ships as a DEFAULT Kotlin/Native platform library, and the same compiler that was already compiling the file compiled `SecItemAdd` on the first try. It held the per-vault ENDPOINT KEY until #1029 §1 deleted the enrolment plane; what is in it now is `Shelf.FOREGROUND_KEY` and the member's transfer rule, and it is where W5's restore credentials land. |
| `IosNetworkStatus` | **Implemented** over `NWPathMonitor` (`platform.Network`, also a default platform library). `platformRefused` is now reserved for the monitor failing to answer within 2 s; a satisfied path is online and an unsatisfied one is offline, which are facts rather than refusals. While this row stood, it hard-coded `platformRefused = true` and `WriteGate` treats unknown as not-reachable — so **every write on iOS was refused, always**. `UIDevice.isBatteryMonitoringEnabled` is set at construction, without which `charging` read false for ever. |
| `IosMediaLibrary.page` | **Implemented** (#1025 S6, D-1025-S7-70/71/72). `PHAsset` enumeration keyset on `creationDate` with the `localIdentifier` as the tiebreak — `NSPredicate` over `PHAsset` cannot express `localIdentifier`, so the predicate is `>=` and the overlap is dropped in Kotlin — plus a **streamed `PHAssetResource` byte door** (`MediaLibrary.open`) that feeds `Staging`, so THE CORE hashes and the phone never names its own bytes. `requestPermission` now actually asks, at `PHAccessLevelReadWrite`; it used to return the current status, so the "Allow photo access" button could be pressed for ever without the system prompt appearing. A Live Photo is two assets sharing one `capture_group_id`; burst members and RAW get **no inferred grouping**; `phash` is derived at commit from bytes the vault holds rather than by the phone, which would be a second opinion about a value that merges nothing. The whole pass — enumerate, stage, commit `media.add_asset` — is `dev.centraid.shared.shell.CameraRoll`. The `needs` declaration a GATEWAY pulled bytes on went with the gateway (#1029 §1), and so did `Request::Intent`: the bytes are staged into this vault's own store and the command commits the row beside them. |
| `ShellModel.send` | **Wired for all four screens** (#1025 S5, lane L5). Home goes through `HomeBridge`; Tally, Photos and Notes go through `TallyBridge`, `PhotosBridge` and `NotesBridge`, which live in the app's own package because a bridge names its screen's types and `PerAppLayoutSpec` keeps that inside `apps`. Each attaches to the ONE `HomeSession` — one session, whatever the number of open cores — through `HomeSession.attachScreen`, which both serves the screen's `ReadPage` (`sync/ScreenRuntime.kt`) and routes it onto the change stream. The row used to say their machines had no read runtime at all, and that was the larger half of the defect: `ScreenEffect.ReadPage` reached nothing, so all three drew their seeded `LOADING` state for ever. The `fatalError` is gone — an unknown screen name is dropped, because in a build where every screen is wired it would only turn a typo into a crash on a member's phone. |

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

`crates/core-ffi/spike/jna` is a throwaway measurement of the same binding (D-1020-D2-7). **`mobile/core` supersedes it**; the spike stays where it is as the record of the numbers that fixed the ABI's shape.

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
├── apps/       tally/ photos/ notes/ — each app's machine and its reads
├── nav/        the navigation model
├── sync/       the change stream, the per-screen read runtime and the shared
│               failure mapping
└── platform/   the expect/actual seam
```

Two Konsist rules make the shape load-bearing rather than decorative (`PerAppLayoutSpec`):

1. **An `apps.<x>` package imports no other `apps.<y>`.** Two apps meet in the VAULT, as rows, and never in a reducer.
2. **Nothing outside `apps` imports from inside it.** The shell drives a screen through `ScreenMachine`/`ScreenHost`, which is what lets it host a screen it knows nothing else about; a `shell/` file naming `apps.tally.TallyListState` would be a shell that has to be edited to add an app.

A third assertion says `screen` holds exactly two files, because a screen that moved back into it is a screen rule 2 can no longer say anything about.

## Home, and the pattern the fan-out follows

Home is built (#1020). It is the hardest single screen — a graded springboard over eight unlike tile bodies — and its pattern is the one other screens follow. Four rules came out of it, and they are the ones a later screen should copy:

1. **THE VIEWS DECIDE NOTHING, including layout.** `earns_grid`, `springboard`, `things`, `every_tile_unreadable` AND `grid_rows` are all computed in `HomeMachine` and written onto the state. `grid_rows` is there because the first build let each renderer pack the grid and they disagreed immediately: Compose's `LazyVerticalGrid` honours a span and SwiftUI's `LazyVGrid` **silently ignores `.gridCellColumns`**, so one shell drew Photos full width and the other drew it at a half. Two packers for one grid was the defect; one packer in the machine is the fix.
2. **EVERY VALUE IS A TOKEN OR A STATED GEOMETRY.** No `.secondary`, no `.quaternary`, no SF Symbols, no Material icons. The first build of Home used all four and looked like a SwiftUI sample rather than the product; the token table and the emitted silhouettes are what make the two shells draw one thing.
3. **ONE ICON SET.** `Catalog.kt`/`Catalog.swift` carry the same 24×24 path data the web renderer draws. Compose reads it with `PathParser`; iOS has `Sources/Icon.swift`, a small path reader, and `Tests/IconSilhouetteTests.swift` asserts every emitted silhouette parses — written after a greedy number scan made the Settings gear vanish with nothing failing.
4. **THE FRAME IS PART OF THE SCREEN.** The vault lockup (which vault, and how that vault stands on this device — and the mark IS the switch), the title row and the floating band are the product's chrome, not decoration, and a Home without them is a grid rather than a shell. The second fact is the VAULT's and never a gateway's name ([D-1025-S7-9](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). `VaultLockup.State` has three cases — syncing, synced, offline — and since #1029 §1 the shell reaches only ONE of them: the phone is the vault, so a vault this device holds is a file that opened and there is no pass whose outcome the other two described. The enum lives in `crates/api-proto` and trimming it belongs to that crate's lane; `Shelf.Holding.state` says so where it answers.

### Seeing it with real data: make a vault

**The phone is the vault** (#1029 §1). Nothing is paired and nothing is placed: the shell founds its own vault, in the app's own data directory, and that file is the authority.

In the app: the gear → **Vault** → **Make a vault on this phone**. The empty switcher offers the same act, because a device holding zero vaults is an onboarding surface (R-SHELL-3).

**It works, and the door is `envelope.proto`'s rather than the command registry's** ([#1029](https://github.com/srikanth235/centraid/issues/1029) W5). `Core::open` with `create` lays the migrations down, and the `FoundRequest` arm makes those tables a VAULT: `VaultRoster.found` sends one envelope, `crates/core`'s `api::found` writes `core_vault` and the owner's `core_party` in one commit, and the response carries the new vault id. Nothing is read back off that response — the shelf calls `VaultRoster.identify` afterwards, because the name a member sees has to come out of the vault rather than out of the string the shell happened to send. There is deliberately no `vault.found` COMMAND: founding is the one act that happens before there is a vault to run a command against, so it is an envelope arm and not a `Registry::with_system_commands` entry. `FoundRefusal.NOT_FOUNDED` survives, and it is now the REFUSED case rather than the standing state of the build — a file that already holds a vault (`ERROR_CODE_VAULT_ALREADY_HELD`, which `api::found` raises rather than minting a second `core_vault` row in one file), or a core that answered and then could not name what it made. On that path `Shelf.found` still deletes the file it just made, because a `.sqlite3` that names no vault is one every later `Shelf.load` lists, `VaultRoster.identify` refuses, and the member who made it never sees. `FoundDoorSpec` is the claim.

**The pairing recipe that stood here is gone with the gateway** (#1029 §6). It ran `centraid gateway --print-qr`, seeded a vault with `seed-demo-vault`, and had you paste a `ticket …` line into the Gateway sheet. There is no gateway binary lane, no ticket to redeem, no `Request::Pair` and no bootstrap: `Shelf.admit`, `Replicas`, `Enrolments` and `PairOk` are all deleted. `mobile/scripts/demo-vault.sh` still seeds two vault files, and **both shells read them again**: it writes `demo-vault.sqlite3` and `work-vault.sqlite3` into the vault directory, which is the roster, so the switcher lists them beside whatever the device founded itself. It wrote `.db` for three waves — a suffix `Shelf.SUFFIX` does not take — so the files were placed and then ignored, and a re-seed changed nothing on screen; the same spelling was in Android's asset filter. There is one spelling of that suffix now and it is `Shelf.SUFFIX`.

**A vault's name lives inside the vault** ([D-1025-S7-12](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). It is `core_vault.display_name`, read off the file by `VaultRoster.identify`, and that is unchanged by the deletion — what went is the ticket that carried a gateway's `--vault-name` flag as a placeholder until a copy landed.

**A file name is not an identity.** Vault files used to be `centraid-replica-<vaultId>.sqlite3` so the shelf could find a vault's enrolment record BEFORE opening it, and so a just-paired copy could be filed under the id the gateway had named. Neither exists, so `Replicas.settle`'s rename is gone with them: `Shelf` lists every `.sqlite3` in the directory, asks each one which vault it is, and names a new one `centraid-vault-<random>.sqlite3`. Files written under the old spelling still open, because nothing matches a prefix.

**The byte store travels with the file.** `<stem>.sqlite3` has `<stem>.bytes` beside it — the last extension REPLACED and not appended. A vault without its store is a library of rows pointing at nothing ([D-1025-S3-1](../docs/decisions.md#slice-s3--bytes-both-ways-one-store-1025)), and it renders as placeholders rather than as an error, which is how the first draft of the rename got it wrong.

Four things about the switcher are worth knowing before you touch it:

- **The directory IS the roster.** Every `.sqlite3` in the shell's own data directory is a vault; there is no manifest beside them, because a vault's name lives inside the vault and a manifest would be a second place it lives. See `Shelf`.
- **`Shelf` owns the set, and nothing else adds to it.** At launch `Shelf.load` opens every file the same way — a path and no role, `create` false — asks each one `VaultRoster.identify`, and leaves it open. The `GATEWAY`-role probe that opened and closed each file in turn is gone with the one-core-per-process reading of R-1020-24, and the per-vault enrolment record is gone with the gateway it named (#1029 §1). Afterwards only `Shelf.found` and `Shelf.forget` change the membership. A file that will not open, or that will not say which vault it is, is simply not a holding: a row that fails on tap is a door that does not open.
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
# then pair it with a seeded gateway — "Seeing it with real data" above
```

**JNA is one library in two packages and the package is the extension.** Same group, name and version — `net.java.dev.jna:jna` — published both as a jar and as an `.aar`. The jar bundles `libjnidispatch` for DESKTOP ABIs as ordinary resources; the aar carries the Android ones as real `lib/<abi>/libjnidispatch.so` entries, which is the only shape a packager installs and `System.loadLibrary` finds. Getting it wrong fails two ways and both were seen:

- **jar on Android** — the app builds, installs, runs, Home draws, and the first `centraid_open` dies with `dlopen failed: library "libjnidispatch.so" not found`. A `@aar`-less catalogue alias resolves to the jar, so an entry that merely _looks_ like the Android one does exactly this. `unzip -l` the APK: if you see `com/sun/jna/win32-x86-64/jnidispatch.dll` and no `lib/arm64-v8a/libjnidispatch.so`, this is what happened.
- **both** — `checkDebugDuplicateClasses` refuses out loud, because every `com.sun.jna` class is in each.

`mobile/core/build.gradle.kts` names the `@aar` extension explicitly and says why; the version still comes from the catalogue.
