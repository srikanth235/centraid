#!/usr/bin/env bash
# Lease one device from the cloud farm for the device rung (#927 W4), and hand
# it to the repo's own Maestro harness.
#
# THE HARNESS IS NOT REPLACED. `tests/agent-e2e-mobile/lib/harness.mjs`
# discovers its target through `adb devices` / `xcrun simctl`, and everything
# downstream — the run ledger, the failure classes, the digests — is built on
# that. A farm SDK that drove the flows itself would be a second device driver
# whose green says nothing about the first, so this script's whole job is to
# make the leased device appear where the harness already looks.
#
# ANDROID is a solved shape: the farm publishes an ADB endpoint and
# `adb connect` puts it in `adb devices`.
#
# iOS IS NOT, and this refuses rather than pretending. The harness enumerates
# SIMULATORS (`xcrun simctl list devices`); a physical iPhone is
# `xcrun devicectl list devices`, which nothing here reads yet. The first run of
# the iPhone cell has to close that, and a script that silently leased a device
# the harness could never find would spend an hour proving nothing.
set -euo pipefail

mode="${1:-}"

case "$mode" in
  android)
    : "${CENTRAID_DEVICE_FARM_TOKEN:?device farm token is unset}"
    : "${CENTRAID_DEVICE_FARM_PROJECT:?device farm project is unset}"
    endpoint="${CENTRAID_DEVICE_FARM_ANDROID_ENDPOINT:-}"
    if [ -z "$endpoint" ]; then
      echo "::error::CENTRAID_DEVICE_FARM_ANDROID_ENDPOINT is unset. The rung leases a device by ADB endpoint; set it to the farm session's host:port for the model named by CENTRAID_DEVICE_FARM_ANDROID_MODEL."
      exit 1
    fi
    echo "connecting to leased Android at ${endpoint%%:*}:<port>"
    adb connect "$endpoint" >/dev/null
    # `wait-for-device` returns as soon as adbd answers, which is before the
    # package manager is up; the property is the honest boot signal.
    adb -s "$endpoint" wait-for-device
    for _ in $(seq 1 60); do
      if [ "$(adb -s "$endpoint" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
        echo "CENTRAID_E2E_DEVICE=$endpoint" >> "${GITHUB_ENV:-/dev/null}"
        adb devices
        exit 0
      fi
      sleep 2
    done
    echo "::error::leased Android at $endpoint never reported sys.boot_completed"
    exit 1
    ;;
  ios)
    echo "::error::the iPhone cell cannot be leased yet: tests/agent-e2e-mobile/lib/harness.mjs enumerates simulators through \`xcrun simctl\`, and a farm-leased iPhone is only visible to \`xcrun devicectl list devices\`. Teach the harness that first; this cell stays parked until then (tests/quarantine.json#lanes.device-rung-ios)."
    exit 1
    ;;
  release)
    # Best effort: the farm reclaims the lease when the session ends, so the
    # property this keeps is only that a failed disconnect cannot red a lane
    # whose journeys already passed.
    adb disconnect >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: device-farm-lease.sh <android|ios|release>" >&2
    exit 2
    ;;
esac
