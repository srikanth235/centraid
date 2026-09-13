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

# 1. The Kotlin side. Cinterop needs an Apple toolchain, so klib
#    cross-compilation is OFF on Linux and back ON here.
cd mobile && ./gradlew -Pkotlin.native.enableKlibsCrossCompilation=true \
    :shared:linkDebugFrameworkIosSimulatorArm64

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

**What step 2 unblocks:** `mobile/iosApp/Sources/StateViews.swift` has one `unwired()` function that every decoder funnels through, and it is a `fatalError` rather than a default value because a screen that rendered an empty list there would be indistinguishable from an empty vault. Nineteen fixtures are waiting for it.

**What is deliberately unimplemented on iOS, and fails loudly:**

|  | Why, and what it needs |
| --- | --- |
| `IosSecureStore` | the Keychain needs a `Security.framework` cinterop. It **fails** rather than writing a vault credential to `NSUserDefaults`, which is a plist in the app container. The first thing a macOS session should write. |
| `IosMediaLibrary.page` | `PHAsset` enumeration plus a streamed SHA-256 over `PHAssetResource`. The largest single piece. Four v0 rules it must keep: exact SHA-256 is identity, dHash is a hint that never auto-merges, a Live Photo pair shares one `capture_group_id`, and motion photos / RAW / burst members get **no inferred grouping**. |
| `IosNetworkStatus` | `NWPathMonitor`. Until then it reports `platformRefused`, which is a **true** statement, and `WriteGate` treats an unknown answer as not-reachable so a guess cannot send a write into a void. |
| `ShellModel.send` | the bridge from SwiftUI to `CentraidShared`'s `ScreenHost`. A `fatalError`, so a half-wired build fails on the first tap instead of looking inert. |

**`.xcode-version` is `26.6`, confirmed by the first real iOS compile.** The
pin was `16.4` and had never been tested against anything; D-1020-E5a's rule was
that the first compile confirms or replaces it. Kotlin/Native 2.4.20 **accepted**
Xcode 26.6 — it refused nothing and named no other version — so 26.6 is what the
file now holds, and it is a measurement rather than the guess the `16.4` was.
`:shared:linkDebugFrameworkIosSimulatorArm64` links in **26 s** on an M-series
Mac. **Thirteen** defects stood between the committed tree and a green `swift test`,
and a fourteenth (a `nm` invocation with GNU-only flags) kept the Rust symbol gate
red on any Mac. None was visible to a machine that could not run these four steps.

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

## Home, and the pattern the fan-out follows

Home is built (#1020, wave A). It is the hardest single screen — a graded springboard over eight unlike tile bodies — and it was built alone so its pattern is settled before the other screens fan out. Four rules came out of it, and they are the ones a later screen should copy:

1. **THE VIEWS DECIDE NOTHING, including layout.** `earns_grid`, `springboard`, `things`, `every_tile_unreadable` AND `grid_rows` are all computed in `HomeMachine` and written onto the state. `grid_rows` is there because the first build let each renderer pack the grid and they disagreed immediately: Compose's `LazyVerticalGrid` honours a span and SwiftUI's `LazyVGrid` **silently ignores `.gridCellColumns`**, so one shell drew Photos full width and the other drew it at a half. Two packers for one grid was the defect; one packer in the machine is the fix.
2. **EVERY VALUE IS A TOKEN OR A STATED GEOMETRY.** No `.secondary`, no `.quaternary`, no SF Symbols, no Material icons. The first build of Home used all four and looked like a SwiftUI sample rather than the product; the token table and the emitted silhouettes are what make the two shells draw one thing.
3. **ONE ICON SET.** `Catalog.kt`/`Catalog.swift` carry the same 24×24 path data the web renderer draws. Compose reads it with `PathParser`; iOS has `Sources/Icon.swift`, a small path reader, and `Tests/IconSilhouetteTests.swift` asserts every emitted silhouette parses — written after a greedy number scan made the Settings gear vanish with nothing failing.
4. **THE FRAME IS PART OF THE SCREEN.** The vault lockup (which vault, which gateway — and the mark IS the switch), the title row and the floating band are v0's chrome, not decoration, and a Home without them is a grid rather than a shell.

### Seeing it with real data, and switching between two vaults

```sh
mobile/scripts/demo-vault.sh ios      # or android, or nothing for both
```

That seeds **two** vaults — "Demo vault" with every app, and "Work" with only
Docs, Tasks and Agenda — and places both on the device. Two, and deliberately
unalike: the switcher is only testable against two, and two vaults holding the
same rows under the same name would prove nothing, because a switch that quietly
did not happen would look exactly like one that did.

**The vault is PLACED, not paired.** The network is not built — `Handle::
start_endpoint` is a stub, the C ABI answers `Request::Pair` with
`NotYetAvailable`, and `centraid gateway` admits an enrolled seat and then closes
the connection. What lands on the device is the same file a seat would hold after
a download, minus the download. `<vault>.blobs/` travels with it: that is where
every photograph's bytes are (`Vault::blobs_root_for`), and a vault copied
without it is a library of rows pointing at nothing.

Three things about the switcher are worth knowing before you touch it:

- **The directory IS the roster.** Every `.db` in the shell's own data directory
  is a vault; there is no manifest beside them, because a vault's name lives
  inside the vault and a manifest would be a second place it lives.
- **The survey runs before the active core opens.** `SingleHandleGuard` allows
  one core per process (R-1020-24), so `VaultRoster.survey` opens each file in
  turn and closes it before the next. A roster read afterwards is refused on
  every file, including the one already open.
- **A reload carries what the shell TOLD Home and replaces what Home READ.**
  `HomeState.reloaded()` is the only caller of `firstLoad()`. That rule used to
  live at the three call sites and was wrong at every one of them in turn — the
  lockup, then the roster, then the roster again on the switch branch. If you
  add a shell-known field to `HomeState`, add it to `reloaded()` in the same
  commit or it will vanish on the next open.

### Thumbnails, and the two traps between a byte and a pixel

Home's mosaic draws real photographs (#1020, D-1020-DC1). The path is worth
knowing because nothing about it is guessable from either end:

1. `HomeReads`' photos query selects `content_id` **for the door, not for the
   body** — a thumbnail is located by CONTENT and read as the ASSET, so the
   runtime needs both ids off one row.
2. `HomeRuntime.thumbnails` batches one `ContentUrlRequest` for the four cells
   the mosaic will draw, **before** the tile's event is sent. A cell that
   arrived blank and acquired its photograph a moment later would be two states
   for one row and a visible pop on every open.
3. The core answers a **path**, never bytes: the platform opens the file, so
   decoding and caching stay where they belong.
4. `ContentImage` opens it.

Two things will waste an afternoon if you do not know them:

- **`UIImage(contentsOfFile:)` leans on the path extension.** A
  content-addressed file is named by its digest and has none, so that
  initializer returns nil for every photograph in the store — silently.
  `UIImage(data:)` sniffs the bytes, and is the only thing that can be right
  when the name is a hash.
- **The Rust archive is linked by path** and nothing rebuilds it. See
  [docs/traps/stale-core-slice.md](../docs/traps/stale-core-slice.md) and step 0
  above.

A cell stays a placeholder when the door says the bytes are not here, when it
refuses to call them embeddable (`image/svg+xml` is executed by a renderer in
the embedding page's origin), or when they are **not a still image** — a video's
thumbnail is its poster derivative, and handing a mosaic an MP4 draws a blank
that reads as a failed render.

### Android, end to end

```sh
mobile/scripts/android-core.sh                                   # the Rust core, first
cd mobile && ./gradlew -Pcentraid.android=true :androidApp:installDebug
mobile/scripts/demo-vault.sh android                             # seed and place both vaults
```

**JNA is one library in two packages and the package is the extension.** Same
group, name and version — `net.java.dev.jna:jna` — published both as a jar and
as an `.aar`. The jar bundles `libjnidispatch` for DESKTOP ABIs as ordinary
resources; the aar carries the Android ones as real `lib/<abi>/libjnidispatch.so`
entries, which is the only shape a packager installs and `System.loadLibrary`
finds. Getting it wrong fails two ways and both were seen:

- **jar on Android** — the app builds, installs, runs, Home draws, and the first
  `centraid_open` dies with `dlopen failed: library "libjnidispatch.so" not
  found`. A `@aar`-less catalogue alias resolves to the jar, so an entry that
  merely *looks* like the Android one does exactly this. `unzip -l` the APK: if
  you see `com/sun/jna/win32-x86-64/jnidispatch.dll` and no
  `lib/arm64-v8a/libjnidispatch.so`, this is what happened.
- **both** — `checkDebugDuplicateClasses` refuses out loud, because every
  `com.sun.jna` class is in each.

`mobile/core/build.gradle.kts` names the `@aar` extension explicitly and says
why; the version still comes from the catalogue.
