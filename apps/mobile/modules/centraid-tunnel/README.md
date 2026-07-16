# centraid-tunnel (Expo local module)

Phone side of the issue #263 mobile↔desktop bridge: an iroh p2p QUIC
endpoint plus a localhost HTTP proxy, exposed to JS as the `CentraidTunnel`
native module (Swift + Kotlin, expo-modules-core).

## What it does

- Owns the device's iroh endpoint. The identity is an ed25519 secret key
  generated via `generateSecretKey()` and stored by the app — no bearer
  token ever reaches the phone; the desktop authorizes the device by its
  EndpointId.
- `pairWithDesktop()` dials the ticket from the desktop's "Connect phone"
  QR on `centraid/pair/1` and presents the one-time code; the desktop adds
  this device to its allowlist.
- `startTunnel()` binds a proxy on `127.0.0.1:<ephemeral>` (loopback only,
  never 0.0.0.0). Every HTTP request the WebView sends there is forwarded
  over `centraid/tunnel/1`, one bi-stream per request, and the response
  streams back chunk-by-chunk — SSE (`_changes`) stays live. The QUIC
  connection is dialed lazily and redialed when dead (desktop restarted);
  while the desktop is unreachable or the device is revoked, proxied
  requests answer 502.

## Protocol

`packages/tunnel/README.md` and `packages/tunnel/src/protocol.ts` are the
reference; the Swift and Kotlin implementations here must stay byte-for-byte
in lockstep (u32 big-endian length + UTF-8 JSON header frames, raw body
bytes until stream FIN, EOF = empty read, hop-by-hop headers stripped both
ways). `packages/tunnel/src/client.ts` is the executable Node twin of the
proxy logic.

## iroh bindings (official 1.0.0, not vendored into git)

The module links the first-party iroh-ffi 1.0.0 bindings. Only our
hand-written adapters + the gradle/podspec config are committed; the large
generated/native artifacts are git-ignored (see `.gitignore`) and sourced
from upstream at build time.

### iOS binding — official SwiftPM release artifact via the podspec

`ios/CentraidTunnel.podspec` has a `prepare_command` that downloads the
**official** `IrohLib.xcframework.zip` from the
[iroh-ffi v1.0.0 release](https://github.com/n0-computer/iroh-ffi/releases/tag/v1.0.0)
(SHA-256 pinned to upstream `Package.swift`'s `releaseChecksum`) plus the
generated `IrohLib.swift`. This is the same prebuilt binary the upstream
SwiftPM package (product `IrohLib`) resolves — we pull it through CocoaPods
because Expo integrates local modules as `:path` pods. No bytes in git, no
bespoke fetch script.

> CocoaPods runs `prepare_command` when a pod is *downloaded*; for a `:path`
> development pod some CocoaPods versions skip it. If `pod install` (run by
> `expo prebuild` / `expo run:ios`) leaves `ios/Iroh.xcframework` missing,
> run the two commands from the podspec's `prepare_command` once from `ios/`,
> then re-run `pod install`. Alternative (fully "official") path if that ever
> proves brittle: add the `IrohLib` Swift package
> ([Swift Package Index](https://swiftpackageindex.com/n0-computer/iroh-ffi))
> to the app's Xcode project via an Expo config plugin and `import IrohLib`
> in `TunnelWire.swift`.

The CocoaPods `IrohLib` pod is intentionally **not** used: upstream's
`IrohLib.podspec` is stale at 0.35.0.

### Android binding — cargo-ndk (Maven artifact is desktop-JVM only)

The official Maven artifact
[`computer.iroh:iroh`](https://central.sonatype.com/artifact/computer.iroh/iroh)
is a **desktop-JVM** jar: it bundles native libraries for darwin/linux/win32
only (as JNA resources) and has **no Android ABI variant and no `.so` under
`jni/`**. A plain `implementation("computer.iroh:iroh:1.0.0")` therefore does
not deliver a loadable Android native library. Until upstream ships an
Android AAR (with `arm64-v8a` + `x86_64` jniLibs — which would also restore
x86_64-emulator support and 16 KB page-size compliance for free), Android
must keep cross-compiling the native lib.

Requires the Rust toolchain, `cargo-ndk`, and an Android NDK
(`ANDROID_NDK_HOME`). From a checkout of
[iroh-ffi @ v1.0.0](https://github.com/n0-computer/iroh-ffi):

```sh
rustup target add aarch64-linux-android
cargo install cargo-ndk
# in the iroh-ffi checkout:
cargo ndk -t arm64-v8a build --lib --release
cargo run --bin uniffi-bindgen generate --language kotlin \
  --config uniffi.toml --library target/aarch64-linux-android/release/libiroh_ffi.so
```

Then place the outputs (git-ignored) under this module:

- `target/aarch64-linux-android/release/libiroh_ffi.so`
  → `android/src/main/jniLibs/arm64-v8a/libiroh_ffi.so`
- generated `computer/iroh/iroh_ffi.kt`
  + upstream `kotlin/lib/src/main/kotlin/computer/iroh/IrohAndroid.kt`
  → `android/src/main/java/computer/iroh/`

Add other ABIs (`x86_64`, `armeabi-v7a`) by repeating with the matching
`rustup target` + `-t <abi>` and dropping the `.so` under the matching
`jniLibs/<abi>/`. `IrohAndroid.installAndroidContext` is still required in
1.0.0 (iroh's Android DNS resolver reads `LinkProperties` via JNI); it is
called once from `CentraidTunnelModule` `OnCreate`.

All binding touchpoints are isolated in the `IrohAdapter` sections of
`ios/TunnelWire.swift` and `android/.../TunnelWire.kt`.

## Build notes

- Requires a dev build: `bunx expo prebuild` then `expo run:ios` /
  `expo run:android` (CocoaPods installs during prebuild/run). Not available
  in Expo Go — `index.ts` degrades to `isTunnelAvailable() === false` and
  the async functions reject.

## Wire conformance tests

`TunnelWire`'s framing is verified against the shared golden fixture
`packages/tunnel/fixtures/wire-golden.json` (source of truth:
`packages/tunnel/src/wire-conformance.test.ts`). The Swift and Kotlin
conformance tests read the identical fixture so the implementations cannot
drift silently. Neither constructs an iroh endpoint, so neither loads native
code — they exercise the pure `frame` / `decodeFrameLength` / `encodeHeaderFrame`
functions.

- **Kotlin** — `android/src/test/java/.../TunnelWireConformanceTest.kt`, plain
  JVM JUnit (no device/emulator): `./gradlew test` (the module's
  `testDebugUnitTest`). Needs the `testImplementation` deps in
  `android/build.gradle` (JUnit4 + real `org.json`).
- **Swift** — `ios/Tests/TunnelWireConformanceTests.swift`, XCTest. Not wired
  into this repo's CI (needs an Xcode/SwiftPM toolchain and links the iroh
  xcframework through the `CentraidTunnel` module). Add it to a unit-test
  target that `@testable import`s `CentraidTunnel` in the Expo prebuild Xcode
  project, then `xcodebuild test -scheme <app> -destination '<simulator>'`.

To regenerate the fixture after an intentional vector change:
`UPDATE_GOLDEN=1 bun run --cwd packages/tunnel test wire-conformance`.
