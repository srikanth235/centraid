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
#   mobile/maestro/run-android.sh                 # the made-vault flows, in order
#   mobile/maestro/run-android.sh --demo          # the demo-vault flows, after demo-vault.sh
#   mobile/maestro/run-android.sh home-search     # named flows (no .yaml)
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

# THE FLOWS READ TWO KINDS OF VAULT, and onboarding.yaml and first-launch.yaml throw away whatever the
# app holds, so the default is the made-vault phase in this order, and `--demo` is the second phase:
#   made vault (default): first-launch, onboarding (makes the vault), home (day zero, so straight
#     after onboarding), then the flows that add their own rows.
#   --demo: agenda-day and search-photos read the seeded "Demo vault"; seed it first with
#     `mobile/scripts/demo-vault.sh android`.
if [ "${1:-}" = "--demo" ]; then
  shift
  set -- agenda-day search-photos "$@"
elif [ "$#" -eq 0 ]; then
  # The assistant flows and the iOS-only ones (HealthKit's seeder and sheet, the Chat tab Android
  # does not have) have no Android run.
  set -- first-launch onboarding home home-search agenda-todo agenda-task-from-search \
    app-root-edge-swipe search-containers search-correction
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
