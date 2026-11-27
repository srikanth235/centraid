#!/usr/bin/env bash
# Run the flows on an iOS simulator (#1202). The flows name the iOS bundle id, so unlike
# run-android.sh nothing is staged.
#
#   mobile/maestro/run-ios.sh                 # the made-vault flows, in order
#   mobile/maestro/run-ios.sh --demo          # the demo-vault flows (see the order below)
#   mobile/maestro/run-ios.sh --health        # health-connect
#   mobile/maestro/run-ios.sh home-search     # named flows (no .yaml)
#   DEVICE=<udid> MAESTRO=~/.maestro/bin/maestro mobile/maestro/run-ios.sh home
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
device="${DEVICE:-booted}"
maestro="${MAESTRO:-$HOME/.maestro/bin/maestro}"
if [ "$device" = booted ]; then
  device="$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-F-]\{36\}\)) (Booted).*/\1/p' | head -1)"
fi

# THE ORDER ON ONE SIMULATOR, because each phase needs a different vault:
#   1. a FRESH install (`simctl uninstall`, `install`, launch once), then `CENTRAID_SIMULATOR=<udid>
#      mobile/scripts/demo-vault.sh ios`, then `--demo`. A made vault beside the demo ones is the one
#      the app opens (and it imports the phone's photos), so the demo flows would read the wrong vault.
#   2. the default (made-vault) phase: first-launch and onboarding throw the app's state away.
#   3. `--health`, last: health-connect wants a vault whose Health is not followed, so it follows
#      onboarding.
# The made-vault phase in this order: first-launch and onboarding throw away whatever the app
# holds, home wants day zero (straight after onboarding), then the flows that add their own rows.
if [ "${1:-}" = "--demo" ]; then
  shift
  set -- agenda-day search-photos "$@"
elif [ "${1:-}" = "--health" ]; then
  shift
  set -- health-connect "$@"
elif [ "$#" -eq 0 ]; then
  # The assistant flows (chat, search-chat, search-ask-apps) need a model and are not run here.
  set -- first-launch onboarding home home-search agenda-todo agenda-task-from-search \
    app-root-edge-swipe search-containers search-correction
fi

# THE KEYCHAIN OUTLIVES AN UNINSTALL ON THE SIMULATOR, and a vault key, a connected Health (a keychain
# habit, `crates/screens/src/health/follow.rs`) and the demo seed would all carry into the made-vault
# phase; reset it first, as onboarding.yaml says.
if [ "$#" -ge 2 ] && [ "$1" = first-launch ]; then
  xcrun simctl keychain "$device" reset
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
