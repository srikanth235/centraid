#!/usr/bin/env bash
# Uses the checked-out revision's x86_64 core packaged into the debug APK.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdk="${ANDROID_HOME:?}"
artifacts="${CENTRAID_VISUAL_ARTIFACTS:-$root/target/android-visual}"
mkdir -p "$artifacts"
export PATH="$sdk/platform-tools:$sdk/emulator:$PATH"
test -r /dev/kvm
printf 'no\n' | avdmanager create avd --force --name CentraidVisual --package 'system-images;android-35;google_apis;x86_64' --device pixel_7
emulator -avd CentraidVisual -port 5554 -no-window -no-audio -no-boot-anim \
  -no-snapshot -gpu swiftshader_indirect -accel on -camera-back none -camera-front none \
  > "$artifacts/emulator.log" 2>&1 &
emulator_pid=$!
trap 'kill "$emulator_pid" 2>/dev/null || true' EXIT
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
adb shell input keyevent 82
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb install -r "$root/mobile/androidApp/build/outputs/apk/debug/androidApp-debug.apk"
adb logcat -c
set +e
bash "$root/mobile/scripts/visual-capture.sh" android "$ANDROID_SERIAL" "$artifacts"
result=$?
set -e
adb logcat -d > "$artifacts/logcat.log"
exit "$result"
