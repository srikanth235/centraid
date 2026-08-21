#!/usr/bin/env bash
# Boot the first available iPhone simulator and export its UDID for the
# current GitHub Actions job. Each iOS matrix cell runs this on a fresh runner,
# so no suite shares simulator state or an XCTest accessibility window.
set -euo pipefail

udid="$(xcrun simctl list devices available --json | node -e '
  let input="";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const devices = Object.values(JSON.parse(input).devices).flat();
    const phone = devices.find(device => device.isAvailable && /iPhone/.test(device.name));
    if (!phone) process.exit(1);
    process.stdout.write(phone.udid);
  });
')"

echo "SIMULATOR_UDID=$udid" >> "$GITHUB_ENV"
xcrun simctl boot "$udid" || true
xcrun simctl bootstatus "$udid" -b
