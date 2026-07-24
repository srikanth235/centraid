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

## iroh bindings (official artifacts, not vendored into git)

The module links the first-party iroh-ffi bindings — currently **1.1.0 on
both platforms** (keep the podspec's `iroh_tag` and build.gradle's
`iroh-android` version in lockstep). Only our hand-written adapters + the
gradle/podspec config are committed; the native artifacts come from official
upstream channels at build time (iOS: GitHub release download, git-ignored;
Android: an ordinary Maven dependency). The desktop-node side
(`packages/tunnel`, npm `@number0/iroh`) is on 1.1.0 to match; the desktop
Rust data-plane (`iroh` crate 1.0.2) and web (`iroh-wasm`) trail on 1.0.x and
can be aligned in a later crate bump — iroh keeps wire compat within 1.x.

### iOS binding — official SwiftPM release artifact via the podspec

`ios/CentraidTunnel.podspec` has a `prepare_command` that downloads the
**official** `IrohLib.xcframework.zip` from the iroh-ffi release matching the
podspec's `iroh_tag` (currently
[v1.1.0](https://github.com/n0-computer/iroh-ffi/releases/tag/v1.1.0);
SHA-256 pinned to upstream `Package.swift`'s `releaseChecksum`, and a
`.iroh-version` marker forces a refetch when the tag is bumped) plus the
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

### Android binding — official `iroh-android` AAR from Maven Central

[`computer.iroh:iroh-android`](https://central.sonatype.com/artifact/computer.iroh/iroh-android)
(first published 2026-07-17, starting at 1.1.0) is the Android AAR variant of
the binding: it bundles `libiroh_ffi.so` for **all four ABIs** (`arm64-v8a`,
`armeabi-v7a`, `x86`, `x86_64`) plus the `IrohAndroid` JNI initializer, and
transitively provides the uniffi Kotlin API (`computer.iroh:iroh`, with its
desktop-JVM JNA jar swapped for `jna@aar`). `android/build.gradle` declares
it like any dependency — **no Rust toolchain, cargo-ndk, or NDK step**, and
the x86_64 natives are what let the KVM-accelerated CI emulator load the
tunnel.

History: before that artifact existed, this module vendored a cargo-ndk
cross-compile of `libiroh_ffi.so` (arm64-v8a only) plus uniffi-generated
Kotlin under git-ignored paths (issue #278). If your checkout still carries
that tree (`android/src/main/jniLibs/`, `android/src/main/java/computer/iroh/`),
**delete it** — it duplicates the AAR's classes and natives, and the gradle
build fails fast with exactly this instruction if the dirs exist.

`IrohAndroid.installAndroidContext` is still required (iroh's Android DNS
resolver reads `LinkProperties` via JNI); it is called once from
`CentraidTunnelModule` `OnCreate`.

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
