#!/usr/bin/env bash
# Build the Rust core's static library for the iOS targets (#1135, lane C2).
#
#   mobile/scripts/ios-core.sh                 # all three slices
#   mobile/scripts/ios-core.sh aarch64-apple-ios-sim   # one triple
#
# The same cargo command `.github/workflows/lane-prebuilt-core.yml` runs for
# the XCFramework (`--features llama`, the engine a phone's library carries),
# in the dev profile, writing where `mobile/shared/build.gradle.kts` and the
# Xcode project read: `target/<triple>/debug/libcentraid_core_ffi.a`. The header
# is the committed `crates/core-ffi/include/centraid.h`; `iosApp/CoreBridge` maps
# it to the Swift module `CentraidCoreC`.
#
# RE-RUN THIS EVERY TIME `crates/core` CHANGES: the archive is a built file and
# nothing in Xcode knows it is stale (docs/traps/stale-core-slice.md).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$#" -gt 0 ]; then triples=("$@"); else
  triples=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)
fi

for triple in "${triples[@]}"; do
  echo "==> building $triple"
  (cd "$root" && cargo build -p centraid-core-ffi --features llama --target "$triple")
done
