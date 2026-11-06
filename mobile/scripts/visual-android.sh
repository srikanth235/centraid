#!/usr/bin/env bash
# Uses the checked-out revision's x86_64 core packaged into the debug APK.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdk="${ANDROID_HOME:?}"
artifacts="${CENTRAID_VISUAL_ARTIFACTS:-$root/target/android-visual}"
mkdir -p "$artifacts"
export PATH="$sdk/platform-tools:$sdk/emulator:$PATH"
# New command-line tools and the emulator can choose different default AVD homes.
# Give both the same explicit directory outside the uploaded visual artifacts.
export ANDROID_USER_HOME="${RUNNER_TEMP:-$root/target}/centraid-visual-android"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
unset ANDROID_PREFS_ROOT
mkdir -p "$ANDROID_AVD_HOME"
test -r /dev/kvm
printf 'no\n' | avdmanager create avd --force --name CentraidVisual --path "$ANDROID_AVD_HOME/CentraidVisual.avd" --package 'system-images;android-35;google_apis;x86_64' --device pixel_7
emulator -list-avds > "$artifacts/avds.log"
if ! grep -Fxq CentraidVisual "$artifacts/avds.log"; then
  echo "The emulator cannot see the AVD in $ANDROID_AVD_HOME" >&2
  cat "$artifacts/avds.log"
  exit 1
fi
emulator -avd CentraidVisual -port 5554 -no-window -no-audio -no-boot-anim \
  -no-snapshot -gpu swiftshader_indirect -accel on -camera-back none -camera-front none \
  > "$artifacts/emulator.log" 2>&1 &
emulator_pid=$!
logcat_pid=
cleanup() {
  if [ -n "$logcat_pid" ]; then
    kill "$logcat_pid" 2>/dev/null || true
    wait "$logcat_pid" 2>/dev/null || true
  fi
  kill "$emulator_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export ANDROID_SERIAL=emulator-5554
# Infrastructure readiness, not a product performance assertion.
booted=0
for attempt in $(seq 1 180); do
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then
    booted=1
    break
  fi
  kill -0 "$emulator_pid" 2>/dev/null || { cat "$artifacts/emulator.log"; exit 1; }
  sleep 2
done
[ "$booted" = 1 ] || { echo 'Android emulator did not boot' >&2; exit 1; }
# Stream before the app can start, so a crash remains inspectable even if CI
# cancels the capture matrix before it returns to this script.
adb logcat -c
# ADB can briefly disconnect while the test driver starts. Resume the stream
# without clearing the device buffer so later crashes still reach the artifact.
stream_logcat() {
  stream_pid=
  trap 'if [ -n "$stream_pid" ]; then kill "$stream_pid" 2>/dev/null || true; wait "$stream_pid" 2>/dev/null || true; fi; exit 0' INT TERM
  while kill -0 "$emulator_pid" 2>/dev/null; do
    adb logcat -v threadtime &
    stream_pid=$!
    wait "$stream_pid" || true
    stream_pid=
    sleep 1
  done
}
stream_logcat > "$artifacts/logcat.log" 2>&1 &
logcat_pid=$!
adb shell input keyevent 82
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb install -r "$root/mobile/androidApp/build/outputs/apk/debug/androidApp-debug.apk"
set +e
bash "$root/mobile/scripts/visual-capture.sh" android "$ANDROID_SERIAL" "$artifacts"
result=$?
set -e
exit "$result"
