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
# `CENTRAID_IOS_SIMULATOR` (a name or UDID) runs on a simulator that already
# exists and leaves it standing; otherwise a throwaway one is made and deleted.
if [ -n "${CENTRAID_IOS_SIMULATOR:-}" ]; then
  simulator="$(xcrun simctl list devices -j | python3 -c '
import json, sys
want = sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for d in devices:
        if want in (d["udid"], d["name"]):
            print(d["udid"]); sys.exit(0)
sys.exit("no simulator named " + want)
' "$CENTRAID_IOS_SIMULATOR")"
else
  simulator="$(xcrun simctl create CentraidCI com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro "$runtime")"
fi
destination="platform=iOS Simulator,id=$simulator"
# WHAT THE APP LEFT IN ITS DOCUMENTS, for the log: the vaults the shelf adopted or founded.
documents_listing() {
  local container
  if container="$(xcrun simctl get_app_container "$simulator" dev.centraid.Centraid data 2>/dev/null)"; then
    echo "==> documents of dev.centraid.Centraid"
    find "$container/Documents" -maxdepth 3 -not -name '*.sqlite3-*' | sed "s|$container/||" | head -60
  fi
}
if [ -z "${CENTRAID_IOS_SIMULATOR:-}" ]; then
  trap 'documents_listing; xcrun simctl delete "$simulator"' EXIT
else
  trap documents_listing EXIT
fi
# THE UNIT TESTS FIRST, ON AN APP WITH NO VAULT, THEN THE ACCESSIBILITY AUDIT
# ON THE DEMO VAULT (#1202, S4). `UITests/` drives the real app through
# `performAccessibilityAudit()`, and an audit of a Home with nothing on it proves
# nothing, so the vault is seeded between the two runs.
xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination "$destination" -derivedDataPath "$artifacts/app-derived-data" \
  -resultBundlePath "$artifacts/CentraidTests.xcresult" \
  -skip-testing:CentraidUITests test \
  2>&1 | tee "$artifacts/centraid-tests.log"
# A CLEAN INSTALL FIRST: the unit tests launched the app, and whichever vault it
# opened is the one it would open again, so the demo vault would be placed beside
# a foreground vault that is not it.
# The unit-test run can leave a standing simulator shutting down: wait it out, then boot it.
while xcrun simctl list devices | grep "$simulator" | grep -q 'Shutting Down'; do sleep 2; done
xcrun simctl boot "$simulator" 2>/dev/null || true
xcrun simctl bootstatus "$simulator" -b >/dev/null
xcrun simctl terminate "$simulator" dev.centraid.Centraid || true
xcrun simctl uninstall "$simulator" dev.centraid.Centraid || true
xcrun simctl install "$simulator" "$artifacts/app-derived-data/Build/Products/Debug-iphonesimulator/Centraid.app"
# `demo-vault.sh ios` seeds the throwaway vaults, places them in the app's data
# container on this simulator, and prints the demo seed the Locker opens under;
# the UI test hands that seed to the app itself (`TEST_RUNNER_` is stripped).
seed_log="$artifacts/demo-vault.log"
# The seeder refuses to overwrite a vault, so a re-run starts from nothing.
rm -rf "$artifacts/demo-vault"
CENTRAID_SIMULATOR="$simulator" CENTRAID_DEMO_DIR="$artifacts/demo-vault" \
  bash "$root/mobile/scripts/demo-vault.sh" ios 2>&1 | tee "$seed_log"
CENTRAID_DEV_SEED="$(sed -n 's/^CENTRAID_DEMO_SEED=//p' "$seed_log")"
test -n "$CENTRAID_DEV_SEED"
xcrun simctl terminate "$simulator" dev.centraid.Centraid || true
documents_listing
TEST_RUNNER_CENTRAID_DEV_SEED="$CENTRAID_DEV_SEED" \
  xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination "$destination" -derivedDataPath "$artifacts/app-derived-data" \
  -resultBundlePath "$artifacts/CentraidUITests.xcresult" \
  -only-testing:CentraidUITests test \
  2>&1 | tee "$artifacts/centraid-ui-tests.log"
# REDUCE MOTION HAS NO LAUNCH ARGUMENT (#1202, S4), nor does Bold Text: they are the
# system's own settings, so they are written into this simulator's accessibility
# preferences and it is restarted, and the one UI test that wants them says so by
# environment. They are put back whatever the run did, since the simulator may be a
# long-lived one (`CENTRAID_IOS_SIMULATOR`).
restore_accessibility() {
  xcrun simctl spawn "$simulator" defaults delete com.apple.Accessibility BoldTextEnabled 2>/dev/null || true
  xcrun simctl spawn "$simulator" defaults delete com.apple.Accessibility ReduceMotionEnabled 2>/dev/null || true
}
# Bold Text is written too, but UIKit does not report it on in a simulator, so
# nothing here proves it (`testRootsUnderReducedMotion`).
xcrun simctl spawn "$simulator" defaults write com.apple.Accessibility BoldTextEnabled -bool true
xcrun simctl spawn "$simulator" defaults write com.apple.Accessibility ReduceMotionEnabled -bool true
xcrun simctl shutdown "$simulator" || true
xcrun simctl boot "$simulator"
xcrun simctl bootstatus "$simulator" -b >/dev/null
status=0
TEST_RUNNER_CENTRAID_DEV_SEED="$CENTRAID_DEV_SEED" \
TEST_RUNNER_CENTRAID_UI_SYSTEM_SETTINGS=reduce-motion \
  xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination "$destination" -derivedDataPath "$artifacts/app-derived-data" \
  -resultBundlePath "$artifacts/CentraidSystemSettings.xcresult" \
  -only-testing:CentraidUITests/AccessibilityAuditTests/testRootsUnderReducedMotion test \
  2>&1 | tee "$artifacts/centraid-system-settings-tests.log" || status=$?
restore_accessibility
exit "$status"
