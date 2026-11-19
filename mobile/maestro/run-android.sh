#!/usr/bin/env bash
# Run the flows on an Android device or emulator (#1202).
#
# THE FLOWS NAME THE iOS BUNDLE ID. Each flow's `appId` is `dev.centraid.Centraid`,
# which is what Maestro launches on iOS; the Android applicationId is
# `dev.centraid` (changing it would change the app's identity on every installed
# phone). Maestro takes no override for `appId`, so this stages a copy of the
# flows with the id swapped and runs that. The flows themselves stay one file
# for both platforms.
#
#   mobile/maestro/run-android.sh                 # every flow that has an Android run
#   mobile/maestro/run-android.sh home onboarding # named flows (no .yaml)
#   DEVICE=emulator-5554 MAESTRO=~/.maestro/bin/maestro mobile/maestro/run-android.sh home
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
device="${DEVICE:-emulator-5554}"
maestro="${MAESTRO:-$HOME/.maestro/bin/maestro}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp "$here"/flows/*.yaml "$stage"/
sed -i.bak 's/^appId: dev\.centraid\.Centraid$/appId: dev.centraid/' "$stage"/*.yaml
rm -f "$stage"/*.bak

if [ "$#" -eq 0 ]; then
  # The assistant flows and the iOS-only ones (HealthKit's seeder and sheet,
  # the Chat tab Android does not have) have no Android run.
  set -- first-launch onboarding home home-search agenda-day agenda-todo \
    agenda-task-from-search app-root-edge-swipe search-containers \
    search-correction search-photos
fi

status=0
for flow in "$@"; do
  if "$maestro" --device "$device" test "$stage/$flow.yaml"; then
    echo "PASS $flow"
  else
    echo "FAIL $flow"
    status=1
  fi
done
exit "$status"
