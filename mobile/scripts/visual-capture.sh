#!/usr/bin/env bash
# Every case launches the installed app and asserts real content before capture.
# Continue independent cases/profiles for evidence, then fail if any case failed.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
platform="${1:?ios or android}"
device="${2:?device id}"
artifacts="${3:?artifact directory}"
mkdir -p "$artifacts"
artifacts="$(cd "$artifacts" && pwd)"
case "$platform" in
  ios) app_id=dev.centraid.Centraid; export CENTRAID_SIMULATOR="$device" ;;
  android) app_id=dev.centraid ;;
  *) echo 'platform must be ios or android' >&2; exit 2 ;;
esac
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
outcomes="$artifacts/outcomes.tsv"
: > "$outcomes"
result=0
profile=light-default
driver_ready=0
last_capture_passed=0
trap 'node "$root/mobile/scripts/visual-report.mjs" "$platform" "$artifacts"' EXIT

configure() {
  profile="$1"
  local appearance="${profile%%-*}"
  if [ "$platform" = ios ]; then
    xcrun simctl ui "$device" appearance "$appearance"
    if [[ "$profile" == *largest ]]; then
      xcrun simctl ui "$device" content_size accessibility-extra-extra-extra-large
    else
      xcrun simctl ui "$device" content_size large
    fi
  else
    if [ "$appearance" = dark ]; then adb shell cmd uimode night yes; else adb shell cmd uimode night no; fi
    if [[ "$profile" == *largest ]]; then adb shell settings put system font_scale 2.0; else adb shell settings put system font_scale 1.0; fi
  fi
}

capture() {
  local name="$1" flow="$2" widget="${3:-}" content="${4:-}"
  local output="$artifacts/$profile/$name"
  printf 'Visual capture %s / %s: starting\n' "$profile" "$name"
  mkdir -p "$output/screenshots" "$output/debug"
  local passed=1
  # Reuse this run's pinned driver only after real assertions and a capture pass.
  # Maestro still installs a missing driver when reinstallation is disabled.
  local driver_option=--reinstall-driver
  if [ "$driver_ready" = 1 ]; then driver_option=--no-reinstall-driver; fi
  if ! maestro test "$driver_option" --device "$device" --format junit --output "$output/results.xml" \
    --flatten-debug-output --debug-output "$output/debug" --test-output-dir "$output/screenshots" \
    -e "APP_ID=$app_id" -e "WIDGET=$widget" -e "CONTENT=$content" \
    "$root/mobile/maestro/visual/$flow.yaml" > "$output/maestro.log" 2>&1; then
    passed=0
  fi
  if [ -z "$(find "$output/screenshots" -name '*.png' -type f -print -quit)" ]; then passed=0; fi
  if [ "$passed" = 0 ]; then
    result=1
    cat "$output/maestro.log"
    if [ "$platform" = ios ]; then
      xcrun simctl io "$device" screenshot "$output/failure.png" || true
    else
      adb exec-out screencap -p > "$output/failure.png" || true
    fi
  fi
  printf '%s\t%s\t%s\n' "$profile" "$name" "$passed" >> "$outcomes"
  last_capture_passed="$passed"
  if [ "$passed" = 1 ]; then
    driver_ready=1
    printf 'Visual capture %s / %s: PASS\n' "$profile" "$name"
  else
    printf 'Visual capture %s / %s: FAIL\n' "$profile" "$name"
  fi
}

# No vault exists for these captures. Never create a key or dismiss a failure
# to get a screenshot; the flow must see Welcome and both real entry controls.
for variant in light-default dark-default light-largest dark-largest; do
  configure "$variant"
  capture welcome welcome
done

# The existing scenario generator creates real SQLite rows and content bytes.
# Seed once, after Welcome; every subsequent launch uses the same public fixture.
configure light-default
if [ "$platform" = ios ]; then
  xcrun simctl terminate "$device" "$app_id" || true
else
  adb shell am force-stop "$app_id"
fi
printf 'Seeding the public demo vault for %s; details are in seed.log\n' "$platform"
bash "$root/mobile/scripts/demo-vault.sh" "$platform" > "$artifacts/seed.log" 2>&1
if [ "$platform" = ios ]; then
  container="$(xcrun simctl get_app_container "$device" "$app_id" data)"
  test -s "$container/Documents/demo-vault/vault.db"
else
  adb shell run-as "$app_id" test -s files/demo-vault/vault.db
fi
printf 'Public demo vault ready for %s\n' "$platform"

# Every seeded case depends on the real Home opening. Keep this first Home
# capture in the matrix count, and stop with its evidence if bootstrap fails.
capture home home
if [ "$last_capture_passed" != 1 ]; then
  echo 'Seeded Home bootstrap failed; stopping dependent captures.' >&2
  exit 1
fi

for variant in light-default dark-default light-largest dark-largest; do
  configure "$variant"
  if [ "$variant" != light-default ]; then capture home home; fi
  capture calendar widget agenda 'agenda-calendar-day-.*'
  capture reminders widget reminders 'agenda-task-row-.*'
  capture reminder-draft reminder-draft
  capture photos widget photos 'photos[.]cell[.].*'
  capture notes widget notes 'notes-row-.*'
  capture docs widget docs 'docs-row-.*'
  capture people widget people 'people-row-.*'
  capture money widget money 'money-row-.*'
  capture health-connect widget health 'health-connect-open'
  capture locker-locked widget locker 'locker-wall'
  capture backup backup
  capture chat chat
done
configure light-default
capture quick-add-return quick-add-return
if [ "$platform" = ios ]; then
  # Health data goes through the separate seeder's HealthKit write entitlement,
  # then Centraid's real read-only Connect flow. Run after the unchanged-vault
  # captures: granting access changes the actual vault through native reads.
  capture health-native-connect health-native-connect
  for variant in light-default dark-default light-largest dark-largest; do
    configure "$variant"
    capture health-summary widget health 'health-metric-steps'
    capture health-chart health-chart
  done
fi
exit "$result"
