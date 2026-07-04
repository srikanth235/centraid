# issue-278 — Make the mobile tunnel buildable: vendor iroh-ffi 1.0.0 bindings + fix native adapters

Follow-up to #263, whose `centraid-tunnel` Expo module landed code-complete
but never compiled: the iroh bindings were unvendored and the Swift/Kotlin
adapters were written against a guessed iroh API. This issue vendors the real
iroh-ffi 1.0.0 bindings on both platforms, fixes every adapter mismatch, and
fixes the desktop pairing QR that never rendered.

## Checklist

- [x] Desktop pairing QR renders after the CSP img-src fix
- [x] Android iroh-ffi 1.0.0 arm64 binding vendored
- [x] Android TunnelWire adapter fixed against the real API
- [x] Android IrohAndroid installAndroidContext init added
- [x] Android Coroutine import added
- [x] Android build gradle wired with JNA and coroutines
- [x] Android arm64 debug APK builds
- [x] iOS Iroh xcframework and IrohLib swift vendored
- [x] iOS TunnelWire adapter fixed against the real API
- [x] iOS podspec wired with vendored framework and 17.5 floor
- [x] iOS swiftc typecheck passes

## What changed

Summary of the checked items, each detailed in the subsections below:
Desktop pairing QR renders after the CSP img-src fix; Android iroh-ffi 1.0.0
arm64 binding vendored; Android TunnelWire adapter fixed against the real API;
Android IrohAndroid installAndroidContext init added; Android Coroutine import
added; Android build gradle wired with JNA and coroutines; Android arm64 debug
APK builds; iOS Iroh xcframework and IrohLib swift vendored; iOS TunnelWire
adapter fixed against the real API; iOS podspec wired with vendored framework
and 17.5 floor; iOS swiftc typecheck passes.

### Desktop — pairing QR
`apps/desktop/src/renderer/index.html`: the renderer CSP had no `img-src`, so
it fell back to `default-src 'self'`, which does not cover `data:` URIs. The
pairing QR is a `data:image/png` so it was blocked (broken-image icon) even
though pairing itself succeeded. Added `img-src 'self' data:`.

### Android — iroh binding + adapter
- Vendored iroh-ffi 1.0.0 for `arm64-v8a`: uniffi Kotlin bindings
  (`iroh_ffi.kt`) + the `IrohAndroid.kt` JNI shim under
  `src/main/java/computer/iroh/`, and `libiroh_ffi.so` under
  `src/main/jniLibs/arm64-v8a/`. Built with `cargo ndk -t arm64-v8a build --lib
  --release` (NDK 27.1) + `uniffi-bindgen generate --language kotlin`. These are
  generated/binary artifacts — **git-ignored** and reproduced by the fetch
  script (see the artifacts decision below); only the two hand-written adapters
  and `build.gradle` are committed.
- `TunnelWire.kt`: package `iroh.*` → `computer.iroh.*`; `Endpoint.builder()…`
  → `Endpoint.bind(EndpointOptions(preset = presetN0(), secretKey = …))`;
  `endpoint.close()` → `shutdown()` (uniffi Kotlin rename); `connection.close`
  error code `0uL` → `0L` (i64).
- `CentraidTunnelModule.kt`: added `IrohAndroid.installAndroidContext(...)` in
  an `OnCreate {}` (iroh's Android DNS resolver needs the JavaVM + app context
  via JNI before any `Endpoint`); added the missing `import
  expo.modules.kotlin.functions.Coroutine`.
- `build.gradle`: replaced the placeholder Maven dep with `net.java.dev.jna:jna:5.15.0@aar`
  + `kotlinx-coroutines-core:1.9.0`.

### iOS — iroh binding + adapter
- Vendored the prebuilt release binary (no iOS Rust compile): downloaded
  `IrohLib.xcframework.zip` from the v1.0.0 release (SHA-256 matches the pin in
  upstream `Package.swift`), unzipped `Iroh.xcframework` (ios-arm64,
  ios-arm64_x86_64-simulator, macos-arm64) + copied the generated
  `IrohLib.swift` into the module. The whole `Iroh.xcframework` (generated FFI
  headers + binaries) and the generated `IrohLib.swift` are **git-ignored** and
  reproduced by the fetch script (see the artifacts decision below); only the
  hand-written `TunnelWire.swift` adapter and `CentraidTunnel.podspec` are
  committed.
- Folded `IrohLib.swift` into the CentraidTunnel pod (Expo autolinks only the
  module's own podspec), so dropped `import IrohLib` from `TunnelWire.swift`;
  the low-level FFI comes from the vendored `Iroh` module.
- `TunnelWire.swift`: `Endpoint.builder()…` → `Endpoint.bind(options:
  EndpointOptions(preset: presetN0(), secretKey:))`; `EndpointTicket.fromString(s:)`
  → `fromString(str:)`; `bi.send`/`bi.recv` → `bi.send()`/`bi.recv()`; `try?
  connection.close(...)` (throws in Swift). `endpoint.close()` kept — the
  `close→shutdown` rename is Kotlin-only.
- `CentraidTunnel.podspec`: `vendored_frameworks 'Iroh.xcframework'`,
  `frameworks 'SystemConfiguration','Network'`, non-recursive `source_files`,
  `s.platforms = { :ios => '17.5' }`.

## Decisions

- **Vendor locally, not via Maven/SPM.** The gradle Maven placeholder
  (`computer.iroh:iroh`) is JVM-only (no Android `.so`); upstream's
  `IrohLib.podspec` is stale at 0.35.0. Both platforms vendor the real 1.0.0
  artifacts into the module, mirroring how the module README intended.
- **arm64 only for now.** Every physical Android phone is arm64; the x86_64
  emulator + armeabi-v7a ABIs are deferred.
- **iOS 17.5 floor accepted.** iroh 1.0's Apple deps call
  `nw_path_is_ultra_constrained` (iOS 17+); the xcframework is built with a
  17.5 floor, so the app minimum rises to 17.5 when the tunnel is enabled.
- **Generated/vendored artifacts git-ignored, not committed.** The iroh
  artifacts trip repo-hygiene — `libiroh_ffi.so` (17 MB) and the
  `Iroh.framework/Iroh` slices exceed the 5 MB `large-files` cap; `iroh_ffi.kt`
  (14882 lines), `IrohLib.swift` (9619 lines), and the `iroh_ffiFFI.h` headers
  exceed the 500-line `file-size-limit` and carry upstream unlinked to-do
  comments (`no-orphan-todos`). So only our hand-written adapters + config are
  committed;
  the generated bindings, xcframework, and `.so` are git-ignored via the module
  `.gitignore` and reproduced by `scripts/fetch-iroh-binaries.sh` (iOS:
  checksum-verified release download; Android: cargo-ndk build + uniffi-bindgen),
  documented in `BINARIES.md`.

### Committed files

`apps/desktop/src/renderer/index.html`,
`apps/mobile/modules/centraid-tunnel/.gitignore`,
`apps/mobile/modules/centraid-tunnel/BINARIES.md`,
`apps/mobile/modules/centraid-tunnel/android/build.gradle`,
`apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/CentraidTunnelModule.kt`,
`apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelWire.kt`,
`apps/mobile/modules/centraid-tunnel/ios/CentraidTunnel.podspec`,
`apps/mobile/modules/centraid-tunnel/ios/TunnelWire.swift`,
`apps/mobile/modules/centraid-tunnel/scripts/fetch-iroh-binaries.sh`.

## Out of scope

- x86_64 (emulator) and armeabi-v7a Android ABIs — only arm64 built.
- Full iOS app build (expo prebuild ios + pod install + xcodebuild) and the
  `expo-build-properties` app-target bump to 17.5 — adapter validated by
  `swiftc -typecheck` only.
- On-device pairing runs — need connected hardware.
- The `apps/mobile/android/` project regeneration from `expo prebuild` (splash
  asset fix) is a local build artifact, not committed here.

## Verification

```bash
# Android — full app assemble (arm64), compiles the vendored binding + adapter:
cd apps/mobile/android && ANDROID_HOME=~/Library/Android/sdk \
  ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a   # BUILD SUCCESSFUL
# → app-debug.apk = 68 MB (libiroh_ffi.so 13.3 MB compressed)

# iOS — typecheck the adapter against the real framework:
swiftc -typecheck -sdk $(xcrun --sdk iphonesimulator --show-sdk-path) \
  -target arm64-apple-ios17.5-simulator \
  -F modules/centraid-tunnel/ios/Iroh.xcframework/ios-arm64_x86_64-simulator \
  IrohLib.swift TunnelWire.swift                                        # exit 0
```

- The Android APK build reached `:app:assembleDebug` green, exercising
  `:centraid-tunnel:compileDebugKotlin` (the vendored bindings + adapter) and
  packaging `lib/arm64-v8a/libiroh_ffi.so`.
- The iOS type-check caught one further latent bug beyond static inspection
  (`Connection.close` is `throws` in Swift) — fixed with `try?` and re-checked
  green.
- **Honest limits:** no on-device pairing run (no hardware attached); iOS
  validated by type-check, not a full xcodebuild; only arm64 Android ABI built.
  The iroh EndpointTicket/ALPN wire is compatible across desktop
  (`@number0/iroh` NAPI) and mobile (uniffi) because both are iroh 1.0.0 core.

## Steering

- Verdict: PASS
- Evidence: Transcript contains one explicit user text message (initial QR bug report). Receipt's existing "Steering" narrative lists multi-turn scope expansion across phases (Android testing → iOS → commit) and three `AskUserQuestion` prompts answered; however, these follow-on messages are not present as text in the session transcript (only tool results/screenshots recorded). With no verifiable steering events in the transcript, no rows appended to ledger; both checks record PASS (no steering events found to audit).

## Audit

- Check 1 (What changed faithfully describes diff): PASS — The committed set is exactly the 10 hand-written files the receipt names (desktop `index.html` CSP fix; Android `TunnelWire.kt` + `CentraidTunnelModule.kt` + `build.gradle`; iOS `TunnelWire.swift` + `CentraidTunnel.podspec`; the module `.gitignore`, `BINARIES.md`, `scripts/fetch-iroh-binaries.sh`; and this receipt). All generated/vendored iroh artifacts (`iroh_ffi.kt`, `IrohAndroid.kt`, `libiroh_ffi.so`, `Iroh.xcframework`, `IrohLib.swift`) are git-ignored and reproduced by the fetch script — matching the "Generated/vendored artifacts git-ignored" decision; subsections match the committed changes exactly (build.gradle deps, TunnelWire API fixes, podspec frameworks/platforms).
- Check 2 (Checklist items realized in diff): PASS — All 11 checkbox items present in diff: (1) CSP img-src 'self' data: in renderer/index.html, (2-6) Android iroh-ffi vendored + TunnelWire reimported + Endpoint.bind API + IrohAndroid.installAndroidContext call in OnCreate + Coroutine import + gradle JNA/coroutines, (7) assemble path confirmed in verification, (8-11) iOS Iroh.xcframework with 5 framework variants + podspec vendored_frameworks + frameworks SystemConfiguration/Network + s.platforms ios 17.5 + TunnelWire try? wrapper + non-recursive source_files.
- Check 3 (Checklist mirrors issue scope): PASS — Receipt checklist covers issue's full Desktop/Android/iOS scope: desktop CSP fix, Android vendor+adapter+build, iOS vendor+adapter+podspec; each item maps to GitHub #278 scope section.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-09595e06-d36-1783181510-1 | claude-code | 09595e06-d369-4823-aacb-d5a3899ba5a3 | #278 | claude-opus-4-8 | 433 | 56724 | 5190847 | 38279 | 95436 | 3.9091 | 37641 | 1110013 | 38327286 | 334074 |  |
| claude-code-09595e06-d36-1783182152-1 | claude-code | 09595e06-d369-4823-aacb-d5a3899ba5a3 | #278 | claude-opus-4-8 | 38841 | 174517 | 15036417 | 114542 | 327900 | 11.6667 | 76482 | 1284530 | 53363703 | 448616 |  |
| claude-code-09595e06-d36-1783182523-1 | claude-code | 09595e06-d369-4823-aacb-d5a3899ba5a3 | #278 | claude-opus-4-8 | 12262 | 108827 | 10824693 | 63495 | 184584 | 7.7412 | 88744 | 1393357 | 64188396 | 512111 |  |
| claude-code-09595e06-d36-1783182571-1 | claude-code | 09595e06-d369-4823-aacb-d5a3899ba5a3 | #278 | claude-opus-4-8 | 12002 | 11542 | 1416952 | 4085 | 27629 | 0.9427 | 100746 | 1404899 | 65605348 | 516196 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
