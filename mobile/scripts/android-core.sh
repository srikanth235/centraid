#!/usr/bin/env bash
# Cross-compile the Rust core for Android and place it in jniLibs (#1020, wave A).
#
#   mobile/scripts/android-core.sh              # arm64 (an emulator on Apple silicon, and every modern phone)
#   mobile/scripts/android-core.sh x86_64       # an emulator on an Intel host
#
# WHY THIS EXISTS. `mobile/core` reaches the ABI over JNA, and JNA loads a
# `.so` by name — so the Compose shell needs `libcentraid_core_ffi.so` for the
# device's own ABI inside the APK. Nothing built one: the app compiled, ran,
# drew Home and failed the first `centraid_open`, which is a failure nothing
# before a wired read could have reached.
#
# It also needs JNA's OWN native bridge, which comes from the Android AAR rather
# than the desktop jar — `mobile/core/build.gradle.kts` names the `@aar`
# extension explicitly and says why.
#
# RE-RUN THIS EVERY TIME `crates/core` CHANGES. The `.so` below is a COPIED
# file, so nothing in the Gradle build knows it is stale and nothing will tell
# you: the app builds, installs, runs, and answers with the core from whenever
# this script last ran. See `docs/traps/stale-core-slice.md`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
abi="${1:-arm64-v8a}"
api="${CENTRAID_ANDROID_API:-35}"
ndk_version="${CENTRAID_NDK:-27.0.12077973}"
sdk="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
toolchain="$sdk/ndk/$ndk_version/toolchains/llvm/prebuilt/darwin-x86_64/bin"

case "$abi" in
  arm64-v8a) triple=aarch64-linux-android; cc_prefix=aarch64-linux-android ;;
  x86_64)    triple=x86_64-linux-android;  cc_prefix=x86_64-linux-android ;;
  *) echo "unknown abi '$abi' (arm64-v8a | x86_64)" >&2; exit 2 ;;
esac

if [ ! -d "$toolchain" ]; then
  echo "no NDK at $toolchain — install it with:" >&2
  echo "  sdkmanager --sdk_root=\"$sdk\" \"ndk;$ndk_version\"" >&2
  exit 1
fi

echo "==> building $triple"
upper="$(echo "$triple" | tr 'a-z-' 'A-Z_')"
export "CARGO_TARGET_${upper}_LINKER=$toolchain/${cc_prefix}${api}-clang"
export "CC_${triple//-/_}=$toolchain/${cc_prefix}${api}-clang"
export "AR_${triple//-/_}=$toolchain/llvm-ar"
(cd "$root" && cargo build -p centraid-core-ffi --target "$triple")

out="$root/mobile/androidApp/src/main/jniLibs/$abi"
mkdir -p "$out"
cp "$root/target/$triple/debug/libcentraid_core_ffi.so" "$out/"
echo "==> $out/libcentraid_core_ffi.so"
