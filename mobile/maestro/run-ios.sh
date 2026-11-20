#!/usr/bin/env bash
# Run the flows on an iOS simulator (#1202). The flows name the iOS bundle id, so unlike
# run-android.sh nothing is staged.
#
#   mobile/maestro/run-ios.sh                 # the made-vault flows, in order
#   mobile/maestro/run-ios.sh --demo          # the demo-vault flows, after `demo-vault.sh ios`
#   mobile/maestro/run-ios.sh --health        # health-seed (HealthSeeder installed), then health-connect
#   mobile/maestro/run-ios.sh home-search     # named flows (no .yaml)
#   DEVICE=<udid> MAESTRO=~/.maestro/bin/maestro mobile/maestro/run-ios.sh home
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
device="${DEVICE:-booted}"
maestro="${MAESTRO:-$HOME/.maestro/bin/maestro}"
if [ "$device" = booted ]; then
  device="$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-F-]\{36\}\)) (Booted).*/\1/p' | head -1)"
fi

# The made-vault phase in this order: first-launch and onboarding throw away whatever the app
# holds, home wants day zero (straight after onboarding), then the flows that add their own rows.
if [ "${1:-}" = "--demo" ]; then
  shift
  set -- agenda-day search-photos "$@"
elif [ "${1:-}" = "--health" ]; then
  shift
  set -- health-seed health-connect "$@"
elif [ "$#" -eq 0 ]; then
  # The assistant flows (chat, search-chat, search-ask-apps) need a model and are not run here.
  set -- first-launch onboarding home home-search agenda-todo agenda-task-from-search \
    app-root-edge-swipe search-containers search-correction
fi

status=0
for flow in "$@"; do
  if "$maestro" --device "$device" test "$here/flows/$flow.yaml"; then
    echo "PASS $flow"
  else
    echo "FAIL $flow"
    status=1
  fi
done
exit "$status"
