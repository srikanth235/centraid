# iroh vendored artifacts (not committed)

The `centraid-tunnel` module links iroh-ffi **1.0.0**. Only our hand-written
adapters + gradle/podspec config are committed. The iroh artifacts — large
uniffi-generated code and compiled binaries (some exceed the repo's 5 MB /
500-line hygiene caps and carry upstream TODOs) — are **git-ignored** and
reconstructed before a mobile build:

| Artifact | Path (git-ignored) | Source |
| --- | --- | --- |
| `iroh_ffi.kt` (uniffi Kotlin) | `android/src/main/java/computer/iroh/` | uniffi-bindgen |
| `IrohAndroid.kt` (JNI shim) | `android/src/main/java/computer/iroh/` | iroh-ffi @ v1.0.0 |
| `libiroh_ffi.so` (arm64-v8a) | `android/src/main/jniLibs/arm64-v8a/` | cargo-ndk |
| `Iroh.xcframework/` | `ios/` | v1.0.0 release zip |
| `IrohLib.swift` (uniffi Swift) | `ios/` | iroh-ffi @ v1.0.0 |

## Quick start

```bash
# from this directory (apps/mobile/modules/centraid-tunnel)
./scripts/fetch-iroh-binaries.sh          # ios (download) + android (build), if toolchains present
./scripts/fetch-iroh-binaries.sh ios      # iOS only  — no toolchain needed
./scripts/fetch-iroh-binaries.sh android  # Android only — needs Rust + cargo-ndk + NDK
```

## iOS (deterministic download)

Downloads `IrohLib.xcframework.zip` from the
[iroh-ffi v1.0.0 release](https://github.com/n0-computer/iroh-ffi/releases/tag/v1.0.0),
verifies SHA-256 `514b147f7965fe17acaece9a1157cf9421463b6c9282224983e871ea868b86ef`
(the pin in upstream `Package.swift`), unpacks the full `Iroh.xcframework`, and
fetches the generated `IrohLib.swift`. Run before `pod install`. Needs no Rust.

## Android (build)

Requires the Rust toolchain, `cargo-ndk`, and an Android NDK (`ANDROID_NDK_HOME`):

```bash
rustup target add aarch64-linux-android
cargo install cargo-ndk
```

The script clones iroh-ffi at the tag, cross-compiles `libiroh_ffi.so` for
`arm64-v8a` (release), runs `uniffi-bindgen` to generate `iroh_ffi.kt`, and
copies the upstream `IrohAndroid.kt` shim. Other ABIs (`x86_64` emulator,
`armeabi-v7a`) are not wired yet — add the rust target + a `-t <abi>` build and
drop the resulting `.so` under the matching `jniLibs/`.
