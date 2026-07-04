#!/usr/bin/env bash
# Reconstruct the iroh-ffi 1.0.0 vendored/generated artifacts the
# centraid-tunnel module links but does not commit (large generated or
# third-party files). See ../BINARIES.md. Usage: fetch-iroh-binaries.sh [ios|android|all]
#
# Produces (all git-ignored):
#   iOS      ios/Iroh.xcframework/           (full framework: FFI headers + binaries)
#            ios/IrohLib.swift               (uniffi-generated Swift wrapper)
#   Android  android/src/main/java/computer/iroh/iroh_ffi.kt   (uniffi-generated)
#            android/src/main/java/computer/iroh/IrohAndroid.kt (upstream JNI shim)
#            android/src/main/jniLibs/arm64-v8a/libiroh_ffi.so  (cargo-ndk build)
set -euo pipefail

MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IROH_VERSION="v1.0.0"
RAW="https://raw.githubusercontent.com/n0-computer/iroh-ffi/${IROH_VERSION}"
XCF_URL="https://github.com/n0-computer/iroh-ffi/releases/download/${IROH_VERSION}/IrohLib.xcframework.zip"
XCF_SHA256="514b147f7965fe17acaece9a1157cf9421463b6c9282224983e871ea868b86ef"

target="${1:-all}"

fetch_ios() {
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  echo "iOS: downloading IrohLib.xcframework.zip ($IROH_VERSION)…"
  curl -sSL -o "$tmp/iroh.zip" "$XCF_URL"
  local got; got="$(shasum -a 256 "$tmp/iroh.zip" | awk '{print $1}')"
  [[ "$got" == "$XCF_SHA256" ]] || { echo "error: checksum mismatch (want $XCF_SHA256, got $got)" >&2; exit 1; }
  unzip -q "$tmp/iroh.zip" -d "$tmp/x"
  rm -rf "$MODULE_DIR/ios/Iroh.xcframework"
  cp -R "$(find "$tmp/x" -maxdepth 1 -name '*.xcframework' | head -1)" "$MODULE_DIR/ios/Iroh.xcframework"
  echo "iOS: fetching generated IrohLib.swift…"
  curl -sSL -o "$MODULE_DIR/ios/IrohLib.swift" "$RAW/IrohLib/Sources/IrohLib/IrohLib.swift"
  echo "iOS: done. Run 'pod install' next."
}

build_android() {
  command -v cargo-ndk >/dev/null 2>&1 || {
    echo "Android: cargo-ndk not found — install: rustup target add aarch64-linux-android && cargo install cargo-ndk" >&2; exit 1; }
  : "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME, e.g. ~/Library/Android/sdk/ndk/<version>}"
  local pkg="$MODULE_DIR/android/src/main/java/computer/iroh"
  local jni="$MODULE_DIR/android/src/main/jniLibs/arm64-v8a"
  mkdir -p "$pkg" "$jni"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  echo "Android: cloning iroh-ffi $IROH_VERSION + building arm64-v8a (release)…"
  git clone --depth 1 --branch "$IROH_VERSION" https://github.com/n0-computer/iroh-ffi "$tmp/iroh-ffi"
  ( cd "$tmp/iroh-ffi" && cargo ndk -t arm64-v8a build --lib --release )
  local so="$tmp/iroh-ffi/target/aarch64-linux-android/release/libiroh_ffi.so"
  cp "$so" "$jni/libiroh_ffi.so"
  echo "Android: generating Kotlin bindings…"
  ( cd "$tmp/iroh-ffi" && cargo run --quiet --bin uniffi-bindgen generate \
      --language kotlin --out-dir "$tmp/gen" --config uniffi.toml --library "$so" )
  cp "$tmp/gen/computer/iroh/iroh_ffi.kt" "$pkg/iroh_ffi.kt"
  cp "$tmp/iroh-ffi/kotlin/lib/src/main/kotlin/computer/iroh/IrohAndroid.kt" "$pkg/IrohAndroid.kt"
  echo "Android: placed libiroh_ffi.so + iroh_ffi.kt + IrohAndroid.kt."
}

case "$target" in
  ios) fetch_ios ;;
  android) build_android ;;
  all) fetch_ios; build_android ;;
  *) echo "usage: $0 [ios|android|all]" >&2; exit 2 ;;
esac
