#!/usr/bin/env bash
# Run after ios-core.sh for this Mac's simulator architecture. Saves diagnostic artifacts.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifacts="${CENTRAID_IOS_ARTIFACTS:-$root/target/ios-verification}"
mkdir -p "$artifacts"
CENTRAID_IOS_DEPLOYMENT_TARGET="$(cat "$root/mobile/ios-deployment-target")"
export CENTRAID_IOS_DEPLOYMENT_TARGET
cd "$root/mobile/iosApp"
xcodegen generate
xcodegen generate --spec HealthSeeder/project.yml
# Select a runtime supported by the selected SDK, rather than relying on the
# runner's default simulator or a device name left over from a different Xcode.
sdk_version="$(xcrun --sdk iphonesimulator --show-sdk-version)"
runtime="$(xcrun simctl list runtimes available -j | python3 -c '
import json, sys
sdk = tuple(map(int, sys.argv[1].split(".")))
runtimes = [r for r in json.load(sys.stdin)["runtimes"]
            if r["identifier"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-")
            and r.get("isAvailable") and tuple(map(int, r["version"].split("."))) <= sdk]
if not runtimes:
    sys.exit("No available iOS simulator runtime supported by selected Xcode")
print(max(runtimes, key=lambda r: tuple(map(int, r["version"].split("."))))["identifier"])
' "$sdk_version")"
simulator="$(xcrun simctl create CentraidCI com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro "$runtime")"
trap 'xcrun simctl delete "$simulator"' EXIT
destination="platform=iOS Simulator,id=$simulator"
xcodebuild -project HealthSeeder/HealthSeeder.xcodeproj -scheme HealthSeeder \
  -destination "$destination" -derivedDataPath "$artifacts/seeder-derived-data" \
  -resultBundlePath "$artifacts/HealthSeeder.xcresult" build \
  2>&1 | tee "$artifacts/health-seeder.log"
xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination "$destination" -derivedDataPath "$artifacts/app-derived-data" \
  -resultBundlePath "$artifacts/CentraidTests.xcresult" test \
  2>&1 | tee "$artifacts/centraid-tests.log"
if [ "${CENTRAID_VISUAL:-0}" = 1 ]; then
  xcrun simctl bootstatus "$simulator" -b
  # XCTest's host can persist preferences or vaults. This disposable simulator
  # must begin the Welcome captures with fresh app data as well as a new keychain.
  if xcrun simctl get_app_container "$simulator" dev.centraid.Centraid data >/dev/null 2>&1; then
    xcrun simctl uninstall "$simulator" dev.centraid.Centraid
  fi
  xcrun simctl install "$simulator" "$artifacts/app-derived-data/Build/Products/Debug-iphonesimulator/Centraid.app"
  xcrun simctl install "$simulator" "$artifacts/seeder-derived-data/Build/Products/Debug-iphonesimulator/HealthSeeder.app"
  CENTRAID_SIMULATOR="$simulator" CENTRAID_VISUAL_ARTIFACTS="$artifacts/visual" \
    bash "$root/mobile/scripts/visual-ios.sh"
fi
