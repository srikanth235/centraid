#!/usr/bin/env bash
# Build sqlite-vec into `node_modules/expo-sqlite/ios/vec.xcframework` (#996).
#
# WHY THIS FILE EXISTS. expo-sqlite 57.0.2 pre-bundles the sqlite-vec extension
# for ANDROID ONLY: the tarball ships `android/vec/<abi>/vec.so` for four ABIs
# and no `vec.xcframework`. Its podspec already knows what to do with one —
# `ios/ExpoSQLite.podspec` adds `vec.xcframework` to `vendored_frameworks` and
# compiles Swift with `-DWITH_SQLITE_VEC` when
# `expo.sqlite.withSQLiteVecExtension` is true — so the only thing missing on
# iOS is the artifact. This builds it, from the same upstream tag Expo built the
# Android `.so` from, so the two platforms carry the same extension version.
# `scripts/sqlite-vec-version.test.mjs` pins TAG below to the version string
# inside that `.so`, which is what stops the platforms drifting apart.
#
# The binary is NEVER COMMITTED. It is a build output of a pinned upstream
# source, reproduced by this script wherever an iOS build happens: the
# `mobile-ios-lock` workflow before `pod install`, and EAS iOS workers through
# the `eas-build-pre-install` hook in apps/mobile/package.json.
#
# LAYOUT IS LOAD-BEARING. `ios/SQLiteModule.swift` resolves the extension with
# `Bundle(identifier: "sqlite-vec")?.path(forResource: "vec", ofType: "")`, so
# the framework must be named `vec.framework`, carry its binary as `vec` at the
# bundle root (the flat iOS framework layout), and declare CFBundleIdentifier
# `sqlite-vec`. It must also be a DYNAMIC library: the extension is loaded at
# runtime through `sqlite3_load_extension`, which dlopens the path above.
#
# TWO THINGS THE TAG DOES NOT SHIP, both learned from run 34092275488 failing
# in one second on `vendored no sqlite3ext.h`:
#
#   * `sqlite-vec.h` is GENERATED from `sqlite-vec.h.tmpl` by upstream's
#     Makefile through `envsubst`, which macOS runners do not have. Six
#     substitutions, done with sed here.
#   * there is no `vendor/` in the repository at all — upstream's
#     `scripts/vendor.sh` downloads a SQLite amalgamation into it at build time,
#     and `--recurse-submodules` cannot clone a directory that is not a
#     submodule. The extension needs `sqlite3ext.h`, so this resolves it: the
#     platform SDK's own copy when the SDK has one (no network, and the exact
#     headers the phone's dynamic linker will meet), else the same pinned
#     amalgamation upstream uses.
#
# `node_modules/expo-sqlite/vendor/*/sqlite3.h` is deliberately NOT that source,
# even though it sits right there: Expo renames the whole public API to
# `exsqlite3_*` in it, so stock extension source does not compile against it.
# The rename is a link-time detail the extension never sees — a loadable
# extension reaches SQLite through the `sqlite3_api_routines` pointer it is
# handed, not by linking symbols — so stock headers are both correct and the
# only ones that work.
#
#   bash apps/mobile/scripts/build-sqlite-vec-ios.sh          # build if stale
#   SQLITE_VEC_FORCE=1 bash apps/mobile/scripts/build-sqlite-vec-ios.sh
set -euo pipefail

# The version Expo bundles for Android in expo-sqlite 57.0.2. Change this and
# scripts/sqlite-vec-version.test.mjs goes red until the two agree again.
TAG="v0.1.7-alpha.2"
REPO="https://github.com/asg017/sqlite-vec.git"
# The same amalgamation upstream's scripts/vendor.sh pins, used only when the
# platform SDKs carry no sqlite3ext.h of their own.
AMALGAMATION="https://www.sqlite.org/2024/sqlite-amalgamation-3450300.zip"

mobile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$mobile_root/../.." && pwd)"
module_ios="$repo_root/node_modules/expo-sqlite/ios"
dest="$module_ios/vec.xcframework"
stamp="$dest/.centraid-sqlite-vec-tag"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-sqlite-vec-ios: macOS only — xcodebuild builds the iOS slices" >&2
  exit 1
fi
if [ ! -d "$module_ios" ]; then
  echo "build-sqlite-vec-ios: no $module_ios — run bun install first" >&2
  exit 1
fi
for tool in git clang lipo xcrun xcodebuild curl unzip; do
  command -v "$tool" >/dev/null || {
    echo "build-sqlite-vec-ios: $tool is not on PATH" >&2
    exit 1
  }
done

# Idempotent: a framework already built from this tag is left alone, so the EAS
# hook and a re-dispatched workflow do not pay for it twice.
if [ -z "${SQLITE_VEC_FORCE:-}" ] && [ -f "$stamp" ] &&
  [ "$(cat "$stamp")" = "$TAG" ]; then
  echo "build-sqlite-vec-ios: vec.xcframework is already built from $TAG"
  exit 0
fi

# The deployment target the pods are built against; a framework built for a
# newer one links but warns, and an older one is a silently different binary.
min_ios="$(sed -n 's/.*"ios.deploymentTarget"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$mobile_root/ios/Podfile.properties.json" | head -1)"
test -n "$min_ios" || {
  echo "build-sqlite-vec-ios: ios/Podfile.properties.json has no ios.deploymentTarget" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "build-sqlite-vec-ios: cloning sqlite-vec $TAG"
git clone --quiet --depth 1 --branch "$TAG" --recurse-submodules \
  --shallow-submodules "$REPO" "$work/src"
src="$work/src"
test -f "$src/sqlite-vec.c" || {
  echo "build-sqlite-vec-ios: $TAG has no sqlite-vec.c — the upstream layout moved" >&2
  exit 1
}
test -f "$src/sqlite-vec.h.tmpl" || {
  echo "build-sqlite-vec-ios: $TAG has no sqlite-vec.h.tmpl — the upstream layout moved" >&2
  exit 1
}

# The header upstream's Makefile builds with envsubst. VERSION is the tag's own
# file; DATE and SOURCE identify the commit, so the same tag always produces the
# same header.
version="$(cat "$src/VERSION")"
source_sha="$(git -C "$src" rev-parse HEAD)"
source_date="$(git -C "$src" log -1 --format=%cI)"
sed \
  -e "s|\${VERSION_MAJOR}|$(echo "$version" | cut -d. -f1)|g" \
  -e "s|\${VERSION_MINOR}|$(echo "$version" | cut -d. -f2)|g" \
  -e "s|\${VERSION_PATCH}|$(echo "$version" | cut -d. -f3 | cut -d- -f1)|g" \
  -e "s|\${VERSION}|$version|g" \
  -e "s|\${DATE}|$source_date|g" \
  -e "s|\${SOURCE}|$source_sha|g" \
  "$src/sqlite-vec.h.tmpl" >"$src/sqlite-vec.h"
grep -q "SQLITE_VEC_VERSION \"v$version\"" "$src/sqlite-vec.h" || {
  echo "build-sqlite-vec-ios: generated sqlite-vec.h does not carry v$version" >&2
  exit 1
}

# `sqlite3ext.h`, from the SDK when it has one and from upstream's own pinned
# amalgamation when it does not. `header_flags` is empty in the first case: a
# header inside the sysroot is already on the quoted-include search path.
header_flags=()
sdk_headers=1
for sdk in iphoneos iphonesimulator; do
  sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  [ -f "$sysroot/usr/include/sqlite3ext.h" ] || sdk_headers=0
done
if [ "$sdk_headers" = "1" ]; then
  echo "build-sqlite-vec-ios: using the SDK's own sqlite3ext.h"
else
  echo "build-sqlite-vec-ios: no sqlite3ext.h in the SDKs; vendoring $AMALGAMATION"
  curl --fail --silent --show-error --location \
    -o "$work/amalgamation.zip" "$AMALGAMATION"
  unzip -q -o "$work/amalgamation.zip" -d "$work/amalgamation"
  vendor="$(dirname "$(find "$work/amalgamation" -name sqlite3ext.h | head -1)")"
  test -n "$vendor" -a -f "$vendor/sqlite3.h" || {
    echo "build-sqlite-vec-ios: the amalgamation carried no sqlite3ext.h/sqlite3.h" >&2
    exit 1
  }
  grep -q "SQLITE_EXTENSION_INIT1" "$vendor/sqlite3ext.h" || {
    echo "build-sqlite-vec-ios: $vendor/sqlite3ext.h is not the extension header" >&2
    exit 1
  }
  header_flags=(-I"$vendor")
fi

# One flat framework per platform, each a lipo of that platform's slices, at
# the deterministic path `$work/<sdk>/vec.framework`. Deliberately NOT called in
# a command substitution: a failing subshell would only exit the subshell, which
# is how a broken slice becomes a silently half-built xcframework.
# `-install_name @rpath/vec.framework/vec` is what lets the app embed it.
build_framework() {
  sdk="$1"
  min_flag="$2"
  out="$work/$sdk/vec.framework"
  shift 2
  mkdir -p "$out"
  sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  slices=()
  for arch in "$@"; do
    slice="$work/$sdk-$arch.dylib"
    clang \
      -arch "$arch" \
      -isysroot "$sysroot" \
      "$min_flag=$min_ios" \
      -dynamiclib \
      -fPIC \
      -O2 \
      "${header_flags[@]+"${header_flags[@]}"}" \
      -I"$src" \
      -install_name "@rpath/vec.framework/vec" \
      -o "$slice" \
      "$src/sqlite-vec.c"
    slices+=("$slice")
  done
  lipo -create "${slices[@]}" -output "$out/vec"
  cat >"$out/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>vec</string>
  <key>CFBundleIdentifier</key><string>sqlite-vec</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>vec</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>${TAG#v}</string>
  <key>CFBundleVersion</key><string>${TAG#v}</string>
  <key>MinimumOSVersion</key><string>$min_ios</string>
</dict>
</plist>
PLIST
  # The one symbol the module asks sqlite for. If the build ever stops
  # exporting it, the failure otherwise arrives as a runtime "no entrypoint".
  nm -gU "$out/vec" | grep -q "_sqlite3_vec_init" || {
    echo "build-sqlite-vec-ios: $sdk slice does not export sqlite3_vec_init" >&2
    exit 1
  }
}

build_framework iphoneos -mios-version-min arm64
build_framework iphonesimulator -mios-simulator-version-min arm64 x86_64
device="$work/iphoneos/vec.framework"
simulator="$work/iphonesimulator/vec.framework"

rm -rf "$dest"
xcodebuild -create-xcframework \
  -framework "$device" \
  -framework "$simulator" \
  -output "$dest" >/dev/null
test -f "$dest/Info.plist" || {
  echo "build-sqlite-vec-ios: xcodebuild produced no $dest" >&2
  exit 1
}
printf '%s\n' "$TAG" >"$stamp"
echo "build-sqlite-vec-ios: built vec.xcframework from sqlite-vec $TAG (min iOS $min_ios)"
