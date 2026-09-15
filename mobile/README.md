# `mobile/` — the KMP shared module and the two native shells

One Kotlin Multiplatform shared module over the five-function C ABI, with a Compose shell and a SwiftUI shell that render finished state messages and own nothing ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3 lane E).

```
mobile/
├── core/        the C ABI binding — JNA on JVM and Android, cinterop on iOS
├── shared/      the shell, the apps, the screen contract, navigation, sync
├── androidApp/  Compose. Gated on -Pcentraid.android=true + ANDROID_HOME
├── iosApp/      SwiftUI + XcodeGen + SPM. Needs a macOS host
└── maestro/     device flows, and the iOS transfer experiment's protocol
```

## What runs here, and what is a hand-off

This is the most important table in this file. **Nothing in the right-hand column reads green in CI**: there is no Android SDK, no Xcode, no simulator and no device on the machines that run `cargo xtask gate`, and every claim that needs one is an owner hand-off with a command below.

**WAVE A CASHED SEVERAL OF THEM, AND BOTH SHELLS HAVE NOW BEEN SEEN.** On an owner's Mac with Xcode 26.6 the iOS shell compiles, links the XCFramework, runs `swift test` green, and runs on a simulator drawing Home from the real `HomeMachine` over the real Rust core. **Android now does the same** on an `sdk_gphone64_arm64` emulator: same seeded vault, same tiles, same thumbnails, same vault switcher. The rows below say so where it is true.

| Provable on this machine (JVM) | An owner hand-off |
| --- | --- |
| the screen state machines, the navigation model, the mount rules, the sync scheduler, the write gate — Kotest + Turbine on `jvmTest` | the Compose screens rendering — **seen**: Home on an emulator, reading a seeded vault through JNA and the real core |
| the **real ABI round trip**: `open → call → next_event → free → close` from Kotlin over JNA against `libcentraid_core_ffi.so`, on a vault the Rust fixture binary founded | the same round trip through cinterop on iOS |
| the UI-thread assertion, the buffer accounting, the poison handling, the bounded-queue behaviour | a panic injected by the real library (it has no fault-injection point — see `contracts/handoff/E/proposed-patches.md`) |
| 26 `contracts/screens` fixtures decoded by Wire, with the screen laws asserted | the same 26 decoded by SwiftProtobuf — **run: 17 tests, green**, `cd mobile/iosApp && swift test` |
| the emitted app catalogue, identity marks and band places (`CatalogSpec`) | every emitted silhouette PARSING in the Swift path reader (`IconSilhouetteTests`) — **run: 3 tests, green** |
| `commonMain` is platform-free (Konsist), icon-only controls carry labels (a source scan over both surfaces) | Roborazzi and swift-snapshot-testing snapshots |
| the emitted token table matches `packages/design` in both schemes, in Kotlin, in Swift and in JSON | the iOS framework linking, and the XCFramework — **both done** |
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
#    committed (mobile/.gitignore), which is the rule v0 broke. Re-run it after
#    ADDING a source file: the target globs a directory, and a new
#    `Sources/**.swift` is invisible until the project is regenerated.
brew install xcodegen
cd mobile/iosApp && export CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)
xcodegen generate

# 4. The fixture test — the other half of "one fixture, two languages".
cd mobile/iosApp && swift test
```

**What step 2 unblocked:** `mobile/iosApp/Sources/StateViews.swift` used to funnel every decoder through one `unwired()` `fatalError`. The SwiftProtobuf types are generated (`Sources/Generated`) and every decoder in that file is real (#1025 S5, lane L5): the three-state read law is a Swift `enum` with three cases per screen, and a decode that fails renders the screen's LOADING state rather than an empty one, because an empty `.data` case would be a screen claiming an empty vault before it had read one.

**What was deliberately unimplemented on iOS, and what became of each** (#1025 S5):

|  | Where it stands |
| --- | --- |
| `IosSecureStore` | **Implemented** over `kSecClassGenericPassword` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a background pass can read while locked and a vault credential cannot ride an iCloud or encrypted-backup restore onto a device the seat ledger never enrolled. This row used to say the Keychain "needs a `Security.framework` cinterop that no machine in this repository's CI can build" — **that claim was never checked and is false**: `platform.Security` ships as a DEFAULT Kotlin/Native platform library, and the same compiler that was already compiling the file compiled `SecItemAdd` on the first try. It is what the per-vault endpoint key is kept in. |
| `IosNetworkStatus` | **Implemented** over `NWPathMonitor` (`platform.Network`, also a default platform library). `platformRefused` is now reserved for the monitor failing to answer within 2 s; a satisfied path is online and an unsatisfied one is offline, which are facts rather than refusals. While this row stood, it hard-coded `platformRefused = true` and `WriteGate` treats unknown as not-reachable — so **every write on iOS was refused, always**. `UIDevice.isBatteryMonitoringEnabled` is set at construction, without which `charging` read false for ever. |
| `IosMediaLibrary.page` | **Implemented** (#1025 S6, D-1025-S7-70/71/72). `PHAsset` enumeration keyset on `creationDate` with the `localIdentifier` as the tiebreak — `NSPredicate` over `PHAsset` cannot express `localIdentifier`, so the predicate is `>=` and the overlap is dropped in Kotlin — plus a **streamed `PHAssetResource` byte door** (`MediaLibrary.open`) that feeds `Staging`, so THE CORE hashes and the phone never names its own bytes. `requestPermission` now actually asks, at `PHAccessLevelReadWrite`; it used to return the current status, so the "Allow photo access" button could be pressed for ever without the system prompt appearing. A Live Photo is two assets sharing one `capture_group_id`; burst members and RAW get **no inferred grouping**; `phash` is left to the gateway, which derives one at commit from bytes it holds. The whole pass — enumerate, stage, queue `media.add_asset` with `needs` — is `dev.centraid.shared.shell.CameraRoll`. |
| `ShellModel.send` | **Wired for all four screens** (#1025 S5, lane L5). Home goes through `HomeBridge`; Tally, Photos and Notes go through `TallyBridge`, `PhotosBridge` and `NotesBridge`, which live in the app's own package because a bridge names its screen's types and `PerAppLayoutSpec` keeps that inside `apps`. Each attaches to the ONE `HomeSession` — one session, whatever the number of open cores — through `HomeSession.attachScreen`, which both serves the screen's `ReadPage` (`sync/ScreenRuntime.kt`) and routes it onto the change stream. The row used to say their machines had no read runtime at all, and that was the larger half of the defect: `ScreenEffect.ReadPage` reached nothing, so all three drew their seeded `LOADING` state for ever. The `fatalError` is gone — an unknown screen name is dropped, because in a build where every screen is wired it would only turn a typo into a crash on a member's phone. |

**`.xcode-version` is `26.6`, confirmed by the first real iOS compile.** The pin was `16.4` and had never been tested against anything; D-1020-E5a's rule was that the first compile confirms or replaces it. Kotlin/Native 2.4.20 **accepted** Xcode 26.6 — it refused nothing and named no other version — so 26.6 is what the file now holds, and it is a measurement rather than the guess the `16.4` was. `:shared:linkDebugFrameworkIosSimulatorArm64` links in **26 s** on an M-series Mac. **Thirteen** defects stood between the committed tree and a green `swift test`, and a fourteenth (a `nm` invocation with GNU-only flags) kept the Rust symbol gate red on any Mac. None was visible to a machine that could not run these four steps.

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
| `shared/src/commonMain/kotlin/dev/centraid/design/Tokens.kt` | `contracts/tools/export-native-theme.ts` | `git diff --exit-code design copy mobile` |
| `shared/src/commonMain/kotlin/dev/centraid/design/Catalog.kt` | `contracts/tools/export-native-catalog.ts`, called by the above | the same |
| `iosApp/Design/{Theme,Catalog}.swift` | the same two | the same |
| `design/native-{theme,catalog}.json` | the same two | the same |
| `shared/src/commonMain/kotlin/dev/centraid/design/Copy.kt`, `copy/*.json` | **nothing — its generator retired with the v0 tree.** See the banner in `contracts/tools/export-native-theme.ts`: `export-copy.ts` read `packages/blueprints/apps/*/…-copy.ts` and wave 6 deleted them. These files are now the SOURCE, not an artifact. | none |
| `contracts/screens/**/*.bin` | `contracts/tools/build-screen-fixtures.ts` | `git diff --exit-code contracts/screens` |
| the Wire and SwiftProtobuf types | `crates/api-proto/proto` | `buf lint` / `buf breaking` |

One emitter, N committed artifacts, one lint that fails on drift. A hand-maintained Kotlin colour table would be a fourth lowering with no drift gate — and so would a hand-maintained app catalogue or icon set, which is why wave A extended the emitter rather than typing eight app names and 139 silhouettes into two languages.

## How `shared/commonMain` is laid out

One shell, many apps — the same shape as `crates/apps`, `copy` and
`contracts/apps` (#1025 S5, D-1025-S5-1):

```
dev/centraid/shared/
├── shell/      Home, the springboard, first moves, the band, the vault roster,
│               the gateway link, the mount and where replicas live
├── screen/     THE CONTRACT, and nothing else: ScreenMachine + ScreenHost
├── apps/       tally/ photos/ notes/ — each app's machine and its reads
├── nav/        the navigation model
├── sync/       the scheduler, the write gate, the change stream, the window,
│               the per-screen read runtime and the shared failure mapping
└── platform/   the expect/actual seam
```

Two Konsist rules make the shape load-bearing rather than decorative
(`PerAppLayoutSpec`):

1. **An `apps.<x>` package imports no other `apps.<y>`.** Two apps meet in the
   VAULT, as rows, and never in a reducer.
2. **Nothing outside `apps` imports from inside it.** The shell drives a screen
   through `ScreenMachine`/`ScreenHost`, which is what lets it host a screen it
   knows nothing else about; a `shell/` file naming `apps.tally.TallyListState`
   would be a shell that has to be edited to add an app.

A third assertion says `screen` holds exactly two files, because a screen that
moved back into it is a screen rule 2 can no longer say anything about.

## Home, and the pattern the fan-out follows

Home is built (#1020, wave A). It is the hardest single screen — a graded springboard over eight unlike tile bodies — and it was built alone so its pattern is settled before the other screens fan out. Four rules came out of it, and they are the ones a later screen should copy:

1. **THE VIEWS DECIDE NOTHING, including layout.** `earns_grid`, `springboard`, `things`, `every_tile_unreadable` AND `grid_rows` are all computed in `HomeMachine` and written onto the state. `grid_rows` is there because the first build let each renderer pack the grid and they disagreed immediately: Compose's `LazyVerticalGrid` honours a span and SwiftUI's `LazyVGrid` **silently ignores `.gridCellColumns`**, so one shell drew Photos full width and the other drew it at a half. Two packers for one grid was the defect; one packer in the machine is the fix.
2. **EVERY VALUE IS A TOKEN OR A STATED GEOMETRY.** No `.secondary`, no `.quaternary`, no SF Symbols, no Material icons. The first build of Home used all four and looked like a SwiftUI sample rather than the product; the token table and the emitted silhouettes are what make the two shells draw one thing.
3. **ONE ICON SET.** `Catalog.kt`/`Catalog.swift` carry the same 24×24 path data the web renderer draws. Compose reads it with `PathParser`; iOS has `Sources/Icon.swift`, a small path reader, and `Tests/IconSilhouetteTests.swift` asserts every emitted silhouette parses — written after a greedy number scan made the Settings gear vanish with nothing failing.
4. **THE FRAME IS PART OF THE SCREEN.** The vault lockup (which vault, and how that vault stands on this device — and the mark IS the switch), the title row and the floating band are v0's chrome, not decoration, and a Home without them is a grid rather than a shell. The second fact is the VAULT's and never a gateway's name: `VaultLockup.State` has three cases — syncing, synced, offline — every one of them derived from the last pass's outcome and whether a pass is in flight, and none of them a state a gateway is probed for ([D-1025-S7-9](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)).

### Seeing it with real data: pair with a gateway

A device makes its own replica now. Nothing is placed on it.

```sh
# 1. A gateway, with tickets to spend. `--no-relay` keeps it on the LAN, which
#    is where a simulator can reach it.
cargo run -p centraid -- gateway --data-dir /tmp/gw --print-qr 3 --no-relay

# 2. Rows worth looking at, written through the REAL command plane into the
#    vault the gateway just founded. A second connection to a live file is what
#    WAL is for.
cargo run -p centraid --bin seed-demo-vault -- /tmp/gw/vault/<id> --file vault.db --name Tahoe

# 3. In the app: the gear -> Gateway -> paste a `ticket ...` line -> Pair this
#    device -> Sync now.
```

**The vault is PAIRED, not placed** (#1025 S1, S5). `Shelf.admit` opens a FRESH
core at `Replicas.PAIRING_FILE` (`centraid-pairing.sqlite3`) and redeems the
ticket there — `Core::open` on a missing seat path answers a handle whose reads
are refused `Unpaired`, which is a screen a member can read, and `Request::Pair`
takes the first copy into that file. **Every vault already held keeps its core
open through this**; the only handle closed is the one on the pairing file
itself, which is the file about to be paired into. The shell then settles TWO
things under the vault id the gateway named — the replica (`Replicas.settle`) and
the one `Enrolments` record — because before that moment there was no id to name
either after. It was three settles until #1025 S7-13, and three renames with no
transaction over them is three chances to settle by halves
([D-1025-S7-14](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)).

**A device proves who it is at open** ([D-1025-S7-15](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)).
`PairOk` carries the public key the gateway enrolled, derived there from the
connection iroh's TLS proved; it goes into the enrolment record beside the
secret, and every later open compares the endpoint that came up against it. A
mismatch refuses the open with `ERROR_CODE_IDENTITY_MISMATCH` and dials nothing:
a seat whose Keychain item is gone would otherwise present a fresh key, be closed
by its own gateway as an unenrolled peer, and render "this app and that gateway
are too far apart in version to talk" over a lost credential.

**A pairing never rides the live core** ([D-1025-S7-10](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)).
`Handle::pair` bootstraps its first copy into whatever file the handle is open
on, so redeeming a ticket down the core holding vault A wrote vault B over vault
A — a member who had a vault a second earlier read "No vault yet". The first
vault and the Nth take the identical path, with no branch on "does this device
already hold one", and the core refuses to bootstrap into a replica that already
holds a vault with `ERROR_CODE_VAULT_ALREADY_HELD`, checked BEFORE the ticket is
redeemed so a refusal burns nothing ([D-1025-S7-11](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)).
One ticket admits one vault, the one `PairOk.vault_id` names.

**A name off a ticket is a placeholder** ([D-1025-S7-12](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)).
The gateway answers `PairOk.vault_name` from the vault's own
`core_vault.display_name`, and the shell still re-reads it from the replica
(`VaultRoster.identify`) the moment there is a file to ask: a vault's name lives
inside the vault, which is why the seeded fixture above is "Tahoe" in the roster
and not whatever the gateway's `--vault-name` flag last said.

`mobile/scripts/demo-vault.sh` is the old way and its seat path is dead. What it
places is a GATEWAY-role artifact: a vault with every private table and the
device's own authority over rows it is supposed to be a copy of.

**The byte store travels with the replica.** `centraid-replica-<vaultId>.sqlite3` has
`centraid-replica-<vaultId>.bytes` beside it — `replica.with_extension("bytes")` in
`crates/seat-link`, the last extension REPLACED and not appended. A replica
without its store is a library of rows pointing at nothing
([D-1025-S3-1](../docs/decisions.md#slice-s3--bytes-both-ways-one-store-1025)),
and it renders as placeholders rather than as an error — which is how the first
draft of `Replicas.settle` got it wrong and why `ReplicasSpec` pins the name.

Four things about the switcher are worth knowing before you touch it:

- **The directory IS the roster.** Every `centraid-replica-*.sqlite3` in the shell's own data directory is a vault; there is no manifest beside them, because a vault's name lives inside the vault and a manifest would be a second place it lives. See `Replicas`.
- **`Shelf` owns the set, and nothing else adds to it.** At launch `Shelf.load` opens every replica as the seat it is, on its own `Enrolments` record — ONE entry per vault carrying the endpoint secret, the gateway address, the relay statement and the key the gateway said it enrolled ([D-1025-S7-14](../docs/decisions.md)) — asks each one `VaultRoster.identify`, and leaves it open. The `GATEWAY`-role probe that opened and closed each file in turn is gone with the one-core-per-process reading of R-1020-24. Afterwards only `Shelf.admit` and `Shelf.forget` change the membership ([D-1025-S7-10](../docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). A file that will not open is simply not a holding: a row that fails on tap is a door that does not open.
- **The roster is a STREAM, not a one-shot survey.** `Shelf.roster` republishes on every membership or state change, so the switcher's rows and the header's second line are one value rendered twice and cannot disagree. The `VaultRoster.survey` that read the three stores once at launch is gone with `HomeEvent.VaultsListed`; `HomeEvent.RosterChanged` carries the stream, and `VaultRoster` is now only `QUERY` and `identify`. A vault admitted after launch used to be invisible until the app was relaunched.
- **Every held vault's core is open, and a switch costs nothing** (#1025 S7-13, [D-1025-S7-18](../docs/decisions.md)). `SingleHandleGuard` is keyed on the REPLICA PATH: R-1020-24 is that app extensions never open the vault, whose hazard is two handles on one FILE, and a process-keyed guard also refused two handles on two different vaults, which share no file, no outbox and no endpoint. So a switch is a pure rebind — `HomeSession` re-points its runtime and change reader and nothing is closed, reopened or re-identified. "Open" means the file and the endpoint and **not** an active dial; dialling stays the sync round's decision, foreground first, with the metered rule unchanged. The only two things that close a background core are `Shelf.forget` and `Shelf.rest()`, the OS asking for memory back (iOS `didReceiveMemoryWarningNotification`, Android `onTrimMemory`); a rested holding reopens on the next touch or sync round. There is no cap and no idle timeout.
- **One tokio runtime for the process, N endpoints on it** ([D-1025-S7-19](../docs/decisions.md)). Each `SeatLink` used to build its own; with every held vault's core open that is one runtime per vault. `SeatLink::Drop` closes the endpoint and flushes the byte store, which the dropped runtime used to do by killing everything on it.
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
mobile/scripts/demo-vault.sh android                             # seed and place both vaults
```

**JNA is one library in two packages and the package is the extension.** Same group, name and version — `net.java.dev.jna:jna` — published both as a jar and as an `.aar`. The jar bundles `libjnidispatch` for DESKTOP ABIs as ordinary resources; the aar carries the Android ones as real `lib/<abi>/libjnidispatch.so` entries, which is the only shape a packager installs and `System.loadLibrary` finds. Getting it wrong fails two ways and both were seen:

- **jar on Android** — the app builds, installs, runs, Home draws, and the first `centraid_open` dies with `dlopen failed: library "libjnidispatch.so" not found`. A `@aar`-less catalogue alias resolves to the jar, so an entry that merely _looks_ like the Android one does exactly this. `unzip -l` the APK: if you see `com/sun/jna/win32-x86-64/jnidispatch.dll` and no `lib/arm64-v8a/libjnidispatch.so`, this is what happened.
- **both** — `checkDebugDuplicateClasses` refuses out loud, because every `com.sun.jna` class is in each.

`mobile/core/build.gradle.kts` names the `@aar` extension explicitly and says why; the version still comes from the catalogue.
