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

## Build notes

- Requires a dev build: `bunx expo prebuild` then `expo run:ios` /
  `expo run:android` (CocoaPods installs during prebuild/run). Not available
  in Expo Go — `index.ts` degrades to `isTunnelAvailable() === false` and
  the async functions reject.
- The iroh bindings must be vendored before this module compiles:
  - **iOS**: the `IrohLib` Swift package from
    [n0-computer/iroh-ffi](https://github.com/n0-computer/iroh-ffi) (1.0),
    added via SPM to the generated Xcode project, or wrapped in a local
    podspec (see the commented dependency in `ios/CentraidTunnel.podspec`).
  - **Android**: the `computer.iroh:iroh` Maven artifact (see the commented
    dependency in `android/build.gradle`).
- All binding touchpoints are isolated in the adapter sections of
  `ios/TunnelWire.swift` and `android/.../TunnelWire.kt`. If the vendored
  binding's uniffi surface differs slightly from the Node surface declared
  in `packages/tunnel/src/iroh.ts` (argument labels, byte-buffer types,
  method vs property accessors), each touchpoint is a one-line adjustment.
