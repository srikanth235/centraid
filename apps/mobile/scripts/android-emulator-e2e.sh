#!/usr/bin/env bash
# Runs INSIDE the reactivecircus/android-emulator-runner action, once the
# emulator has booted. Kept as a committed file (not an inline `script:` block)
# because the action executes inline scripts via dash, which choked on the
# multi-line if/else and non-ASCII characters — see issue #535. Invoked as
# `bash apps/mobile/scripts/android-emulator-e2e.sh` from the repo root.
#
# Contract:
#   - CWD is the repo root (the action's default working directory).
#   - ANDROID_CACHE_HIT is "true" when the fingerprinted apk cache was restored.
#   - GITHUB_OUTPUT receives `built=true` only when this run actually compiled a
#     fresh apk, so the cache-save step downstream knows there is something new
#     to bank (a cache-hit run must not re-save what it just restored).
set -euo pipefail

cached_apk="$HOME/.cache/centraid-mobile-e2e-android/app-debug.apk"

if [ "${ANDROID_CACHE_HIT:-}" = "true" ] && [ -f "$cached_apk" ]; then
  # Warm path: skip gradle, install the banked dev-client apk, and set up the
  # Metro reverse tunnel that `expo run:android` would normally create so the
  # app on the emulator can reach the host bundler on 8081.
  echo "Android cache hit - installing $cached_apk (skipping gradle)"
  adb install -r "$cached_apk"
  adb reverse tcp:8081 tcp:8081
else
  # Cold path: build the dev-client apk with gradle directly, then install it
  # and set up the Metro reverse — the SAME handoff the warm path uses, so both
  # paths end with the apk installed and Maestro driving the launch.
  #
  # We deliberately do NOT use `expo run:android` here. After a successful build
  # it runs a launch check for the base applicationId `dev.centraid.mobile`, but
  # debug builds install as `dev.centraid.mobile.debug` (applicationIdSuffix in
  # android/app/build.gradle, kept so a debug build and a Play-release build can
  # coexist — J1/#501). That mismatch aborts the job with "No development build
  # (dev.centraid.mobile) ... is installed" even though the apk built and
  # installed fine (see #535). Maestro launches the real `.debug` package itself
  # (the harness resolves the id per platform), so expo's launch step is both
  # broken for this build and unnecessary. android/ is a committed native
  # project, so `assembleDebug` needs no prebuild.
  ( cd apps/mobile/android && ./gradlew :app:assembleDebug --console=plain )
  # Bank the debug apk under the content-addressed cache path. Fail hard if it
  # is missing rather than caching nothing (a later hit would install nothing
  # and fail obscurely at flow time).
  apk="$(find apps/mobile/android -type f -path '*/outputs/apk/debug/*.apk' -print -quit 2>/dev/null || true)"
  test -n "$apk" || { echo "::error::built debug apk not found"; exit 1; }
  adb install -r "$apk"
  adb reverse tcp:8081 tcp:8081
  mkdir -p "$(dirname "$cached_apk")"
  cp "$apk" "$cached_apk"
  echo 'built=true' >> "$GITHUB_OUTPUT"
fi

# Suppress Android's "isn't responding" (ANR) / "has stopped" system dialogs.
# Under the emulator's software GPU the Pixel Launcher intermittently ANRs while
# our app is foregrounded, and Android pops a system dialog OVER it. Maestro then
# queries that system window (which has no app content) and every `visible`/tap
# against the app fails — a flaky non-repro that blocked the onboarding "Skip"
# even though the app had rendered it (#535; screenshot: launcher ANR over the
# Welcome screen). `hide_error_dialogs 1` lets the launcher ANR silently in the
# background instead of stealing the window.
adb shell settings put global hide_error_dialogs 1 || true

node scripts/test-report/prepare.mjs
# Non-short-circuit: every flow writes evidence even when an earlier journey
# fails. template-gate covers the five WebView blueprints; native-v0-resilience
# covers Photos, Docs, and Agenda, matching the iOS eight-app gate.
#
# The order below mirrors the iOS job's "Run all committed mobile journeys" step
# (.github/workflows/e2e.yml) exactly, including the three experience probes
# volume-proof / cold-start / scroll-frames. Those three ran only on iOS while
# tests/experience-budgets/mobile.json already claimed both jobs as their probe
# host, so the Android lane produced no cold-start or frame-drop evidence at all
# — the gap #781 closes. Nothing here is iOS-specific: the harness resolves the
# device and the `.debug` applicationId per platform (tests/agent-e2e-mobile/lib/
# harness.mjs), the frame probe is a plain deep link into a __DEV__-only RN
# component (apps/mobile/src/kit/perf/FrameProbe.tsx; the `centraid` scheme is in
# android/app/src/main/AndroidManifest.xml), and the report is recovered from the
# per-platform Maestro debug output the runs/ artifact already uploads.
set +e
ec=0
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/home-loads.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/template-gate.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/native-v0-resilience.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/volume-proof.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/cold-start.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/scroll-frames.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/run-photos-suite.mjs || ec=$?
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/places-seat.mjs || ec=$?
set -e
exit "$ec"
