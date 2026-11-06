#!/usr/bin/env bash
# Invoked by verify-ios.sh while its freshly built simulator still exists.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
simulator="${CENTRAID_SIMULATOR:?Pass the simulator built by verify-ios.sh}"
artifacts="${CENTRAID_VISUAL_ARTIFACTS:-$root/target/ios-verification/visual}"
mkdir -p "$artifacts"
xcrun simctl bootstatus "$simulator" -b
# This simulator is disposable. XCTest may have exercised key storage; Welcome
# must start from a genuinely fresh secure store as well as fresh app data.
xcrun simctl keychain "$simulator" reset
xcrun simctl status_bar "$simulator" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
export CENTRAID_SIMULATOR="$simulator"
bash "$root/mobile/scripts/visual-capture.sh" ios "$simulator" "$artifacts"
