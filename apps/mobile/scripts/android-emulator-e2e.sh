#!/usr/bin/env bash
# Runs INSIDE the reactivecircus/android-emulator-runner action, once the
# emulator has booted. Kept as a committed file (not an inline `script:` block)
# because the action executes inline scripts via dash, which choked on the
# multi-line if/else and non-ASCII characters — see issue #535. Invoked as
# `bash apps/mobile/scripts/android-emulator-e2e.sh` from the repo root.
#
# Contract:
#   - CWD is the repo root (the action's default working directory).
#   - ANDROID_E2E_APK points to the immutable release artifact downloaded before
#     the emulator starts.
set -euo pipefail

cached_apk="${ANDROID_E2E_APK:-$RUNNER_TEMP/centraid-mobile-e2e-android/app-release.apk}"
ANDROID_SERIAL="${ANDROID_SERIAL:-$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')}"
test -n "$ANDROID_SERIAL" || { echo "::error::no online Android device"; exit 1; }
export ANDROID_SERIAL
export MAESTRO_DEVICE_UDID="$ANDROID_SERIAL"

test -s "$cached_apk" || {
  echo "::error::embedded Android E2E APK is missing: $cached_apk"
  exit 1
}
echo "Installing self-contained Android E2E artifact: $cached_apk"
adb -s "$ANDROID_SERIAL" install -r "$cached_apk"

unzip -l "$cached_apk" 'assets/index.android.bundle' >/dev/null || {
  echo "::error::Android E2E APK has no embedded JS bundle"
  exit 1
}
adb -s "$ANDROID_SERIAL" shell pm path dev.centraid.mobile >/dev/null || {
  echo "::error::release package dev.centraid.mobile is not installed"
  exit 1
}

# Suppress Android's "isn't responding" (ANR) / "has stopped" system dialogs.
# Under the emulator's software GPU the Pixel Launcher intermittently ANRs while
# our app is foregrounded, and Android pops a system dialog OVER it. Maestro then
# queries that system window (which has no app content) and every `visible`/tap
# against the app fails — a flaky non-repro that blocked the onboarding "Skip"
# even though the app had rendered it (#535; screenshot: launcher ANR over the
# Welcome screen). `hide_error_dialogs 1` lets the launcher ANR silently in the
# background instead of stealing the window.
adb -s "$ANDROID_SERIAL" shell settings put global hide_error_dialogs 1 || true

node scripts/test-report/prepare.mjs
# Non-short-circuit: every flow writes evidence even when an earlier journey
# fails. This roster is the Android counterpart of the isolated iOS shards.
set +e
ec=0
export MOBILE_E2E_EMBEDDED=1
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/home-loads.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/native-v0-resilience.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/volume-proof.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/cold-start.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/scroll-frames.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/run-photos-suite.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/places-seat.mjs || ec=$?
# #839 G8 — the five home-app journeys that are not Photos (see
# flows/home-apps-budget.md; Tally is held under #831).
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/run-home-apps-suite.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/sharing-invite.mjs || ec=$?
set -e
exit "$ec"
