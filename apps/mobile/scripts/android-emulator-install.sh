#!/usr/bin/env bash
# Shared preamble for every Android device lane: build-or-restore the apk,
# install it, prove the right package landed, and silence the emulator's ANR
# dialogs. SOURCED (not executed) by its two callers:
#
#   android-emulator-pr-gate.sh   ci.yml `mobile-device-gate` — the critical five
#   android-emulator-roster.sh    mobile-canary.yml and e2e.yml — the full roster
#
# WHY TWO CALLERS RATHER THAN ONE SCRIPT WITH A SUITE SWITCH (#890 W4). The
# earlier shape was one script branching on `CENTRAID_MOBILE_SUITE`, which reads
# fine and is wrong for one specific reason: `scripts/lint-e2e-wiring.mjs`
# derives what each lane schedules by reading the lane's job block and the
# committed script it hands off to. A script containing every branch makes every
# lane look like it runs every journey, so the linter could no longer tell a
# blocking lane from a nightly one — and its `promoting` and `exploratory` rules
# are exactly the rules that depend on that distinction. One script per lane
# shape keeps the shipped wiring readable by the thing that checks it.
#
# #890 W1 — THESE LANES DRIVE THE RELEASE ARTIFACT, NOT THE DEV CLIENT.
# This used to build `assembleDebug`, install `dev.centraid.mobile.debug`, and
# serve its JS live from Metro over `adb reverse`. Every assertion — including
# every perf probe — was therefore made against a `__DEV__` Hermes build fetching
# a bundle over a socket, which is not the thing a member installs. Half the
# harness's caveats (the dev-launcher URL wiped by clearState, the developer-menu
# explainer sheet, the 300s bundle prewarm, the ~43s cold-bundle launch) were
# infrastructure for testing the dev harness. A release build with an embedded
# Hermes bundle has none of them.
#
# Contract for both callers:
#   - CWD is the repo root (the emulator action's default working directory).
#   - ANDROID_CACHE_HIT is "true" when the fingerprinted apk cache was restored.
#   - CENTRAID_MOBILE_BUILD selects `release` (default) or `debug`. `debug` is
#     kept only for a local operator reproducing a dev-client-specific problem;
#     no lane sets it, and it still needs Metro, which this does not start.
#   - GITHUB_OUTPUT receives `built=true` only when this run actually compiled a
#     fresh apk, so the cache-save step knows there is something new to bank (a
#     cache-hit run must not re-save what it just restored).

build_type="${CENTRAID_MOBILE_BUILD:-release}"

case "$build_type" in
  release)
    gradle_task=":app:assembleRelease"
    apk_glob='*/outputs/apk/release/*.apk'
    cached_apk="$HOME/.cache/centraid-mobile-e2e-android/app-release.apk"
    expected_package="dev.centraid.mobile"
    ;;
  debug)
    gradle_task=":app:assembleDebug"
    apk_glob='*/outputs/apk/debug/*.apk'
    cached_apk="$HOME/.cache/centraid-mobile-e2e-android/app-debug.apk"
    expected_package="dev.centraid.mobile.debug"
    ;;
  *)
    echo "::error::CENTRAID_MOBILE_BUILD must be release or debug, got '$build_type'"
    exit 1
    ;;
esac

if [ "${ANDROID_CACHE_HIT:-}" = "true" ] && [ -f "$cached_apk" ]; then
  # Warm path: skip gradle entirely and install the banked apk.
  echo "Android cache hit - installing $cached_apk (skipping gradle)"
  adb install -r "$cached_apk"
else
  # Cold path: build with gradle directly, then install — the SAME handoff the
  # warm path uses, so both paths end with the apk installed and Maestro driving
  # the launch.
  #
  # We deliberately do NOT use `expo run:android`. After a successful build it
  # runs a launch check for the base applicationId, which a debug build does not
  # satisfy (it installs as `dev.centraid.mobile.debug`, applicationIdSuffix in
  # android/app/build.gradle — J1/#501), aborting the job with "No development
  # build ... is installed" even though the apk built and installed fine (#535).
  # Maestro launches the real package itself, so expo's launch step is both
  # broken for this build and unnecessary. android/ is a committed native
  # project, so `assemble*` needs no prebuild.
  #
  # The release variant is DEBUG-SIGNED here on purpose: android/app/build.gradle
  # falls back to the debug signing config when CENTRAID_UPLOAD_STORE_FILE is
  # unset and CENTRAID_REQUIRE_RELEASE_SIGNING is not "1". A test lane must never
  # hold the Play upload key (J1), and the signature is not what these journeys
  # assert — the embedded bundle, the R8/Hermes configuration and the absence of
  # __DEV__ are. The store lanes set CENTRAID_REQUIRE_RELEASE_SIGNING=1 and get
  # the real key; this one deliberately does not.
  # #890 W1 — the perf-flavored release. `scroll-frames` and `cold-start` were
  # measuring a __DEV__ Hermes build because the frame sampler only existed under
  # __DEV__ at all, so the probes could not have run against the artifact even in
  # principle. Metro inlines EXPO_PUBLIC_* at export time and gradle's
  # `createBundleReleaseJsAndAssets` task is where that export happens, so the
  # flag has to be on THIS process, not on the Maestro run below. A store build
  # never sets it, so the probe stays absent from what members install.
  ( cd apps/mobile/android \
    && EXPO_PUBLIC_CENTRAID_FRAME_PROBE=1 ./gradlew "$gradle_task" --console=plain --max-workers=1 )
  # Bank the apk under the content-addressed cache path. Fail hard if it is
  # missing rather than caching nothing (a later hit would install nothing and
  # fail obscurely at flow time).
  apk="$(find apps/mobile/android -type f -path "$apk_glob" -print -quit 2>/dev/null || true)"
  test -n "$apk" || { echo "::error::built $build_type apk not found under $apk_glob"; exit 1; }
  adb install -r "$apk"
  mkdir -p "$(dirname "$cached_apk")"
  cp "$apk" "$cached_apk"
  echo 'built=true' >> "$GITHUB_OUTPUT"
fi

# Prove the package the flows will drive is actually installed, by the id the
# harness resolves for this build type. A silent id mismatch is how #535 turned a
# working build into an obscure flow-time failure; assert it where the cause is
# obvious instead.
adb shell pm list packages "$expected_package" | grep -q "package:$expected_package" || {
  echo "::error::$expected_package is not installed after the $build_type install step"
  adb shell pm list packages dev.centraid || true
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
adb shell settings put global hide_error_dialogs 1 || true

node scripts/test-report/prepare.mjs

export MAESTRO_PLATFORM=android
# Read by lib/harness.mjs: it selects the installed applicationId for this build
# type and, on `release`, skips the Metro reachability wait and bundle prewarm
# entirely — a release artifact carries its own bundle and never talks to Metro.
export CENTRAID_MOBILE_BUILD="$build_type"
