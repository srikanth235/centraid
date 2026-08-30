#!/usr/bin/env bash
# D2 spike (#890): can a paired mobile client's state be restored into a fresh
# boot, or must every CI suite pay its own ~4-minute pairing?
#
# This ships as a RUNNABLE script rather than a paragraph in the decisions doc
# because a spike nobody can run is a wish. It needs a Mac with a booted
# simulator, an installed Centraid build, and a running test gateway — which is
# exactly why it is not wired into any lane. Run it by hand; paste its verdict
# line into the receipt.
#
# WHAT THE SOURCE ALREADY SETTLED (do not re-derive it here):
#   The device identity is NOT hardware-bound. It is 32 CSPRNG bytes the app
#   generates itself and stores through `secure-storage.ts` with no
#   SecureStoreOptions at all — no THIS_DEVICE_ONLY, no requireAuthentication —
#   and the gateway's `devices` row binds only the derived iroh EndpointId. No
#   UDID, install id, or vendor id is recorded or checked anywhere. So whoever
#   holds those bytes IS the paired device, cryptographically.
#
# WHAT IS ACTUALLY IN QUESTION — the unit of restore, not the key material:
#   `tests/onboarding-scenarios.md` G2 records that `phoneLink.secretKey` and
#   `phoneLink.ticket` survive app DELETION on iOS and are cleared only by
#   `simctl erase` — they live in the simulator DEVICE's keychain, outside the
#   app container. So the obvious cheap move (copy the app container back) is
#   the one move that provably cannot work, and step 1 below costs seconds and
#   says so out loud before the expensive part runs.
#
# THE GATEWAY MUST BE RESTORED IN LOCKSTEP, AT THE SAME ABSOLUTE PATH.
#   `key-store.ts` derives the external credential filename from
#   `path.resolve(keysDir)`, so a gateway data dir restored to a different path
#   cannot find its wrapping key; and the enrollment store refuses a rewound
#   client outright ("replica checkpoint must advance monotonically"). This
#   script therefore does NOT touch the gateway: keep the same process, on the
#   same data dir, alive across the whole run. If you cannot, the spike measures
#   the gateway's refusal rather than the keychain's survival, which is a
#   different question.
#
# Usage:
#   MAESTRO_GATEWAY_URL=http://127.0.0.1:18789 \
#     bash tests/agent-e2e-mobile/spike-paired-state-restore.sh
set -euo pipefail

APP_ID="dev.centraid.mobile"
FLOWS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/flows"
SNAPSHOT="${SPIKE_SNAPSHOT_DIR:-/tmp/centraid-paired-snapshot}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "::error::this spike is iOS-Simulator-only; the Android half is K7 in tests/onboarding-scenarios.md"
  exit 1
fi
: "${MAESTRO_GATEWAY_URL:?set MAESTRO_GATEWAY_URL to a live test gateway and keep that process alive for the whole run}"

udid="$(xcrun simctl list devices booted --json | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const booted = Object.values(JSON.parse(input).devices).flat()
      .find((device) => device.state === "Booted");
    if (!booted) process.exit(1);
    process.stdout.write(booted.udid);
  });
')"
echo "spike: simulator $udid"

# ---------------------------------------------------------------- step 0
# Pair once, normally. Any flow that calls ctx.configureGateway() will do; the
# Docs journey is the one the home-apps suite already uses as its fresh pairer.
echo "spike: step 0 — pairing fresh"
node "$FLOWS_DIR/docs-drive.mjs"

# ---------------------------------------------------------------- step 1
# The cheap answer first. If the identity IS inside the app container, a
# container-only snapshot would be enough and the rest of this script is
# unnecessary. The source says it is not; this proves it on the machine.
app_data="$(xcrun simctl get_app_container "$udid" "$APP_ID" data)"
if grep -rqs "phoneLink.secretKey" "$app_data"; then
  echo "spike: VERDICT container-sufficient — the identity key is inside $app_data;"
  echo "spike: a container-only snapshot is enough and D2 is cheaper than assumed."
  exit 0
fi
echo "spike: identity is NOT in the app container (as the source predicted);"
echo "spike: continuing with the whole-DEVICE snapshot, the only shape that could work."

# ---------------------------------------------------------------- step 2
# Snapshot the whole simulator device. Shut down first so the keychain database
# is flushed to disk — snapshotting a live device copies a keychain mid-write,
# and a spike that measures a torn file has measured nothing.
device_dir="$HOME/Library/Developer/CoreSimulator/Devices/$udid"
xcrun simctl shutdown "$udid"
rm -rf "$SNAPSHOT"
cp -Rp "$device_dir" "$SNAPSHOT"
echo "spike: banked $(du -sh "$SNAPSHOT" | cut -f1) to $SNAPSHOT"

# ---------------------------------------------------------------- step 3
# Destroy the state the way a fresh CI boot does. `erase` (not app delete) is
# the only thing that clears the keychain — that is G2's whole point.
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b
xcrun simctl erase "$udid"
xcrun simctl shutdown "$udid"

# ---------------------------------------------------------------- step 4
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b
rm -rf "$device_dir"
cp -Rp "$SNAPSHOT" "$device_dir"
xcrun simctl boot "$udid" || true
xcrun simctl bootstatus "$udid" -b

# ---------------------------------------------------------------- step 5
# THE MEASUREMENT. `MAESTRO_REUSE_PAIRED_STATE=1` makes configureGateway() a
# plain relaunch that waits for the Home band, so this flow passes only if the
# restored device is still paired. It fails on "Connect your gateway." — the
# ticket-onboarding screen — if the keychain did not survive the round trip.
echo "spike: step 5 — does the restored device land on Home?"
if MAESTRO_REUSE_PAIRED_STATE=1 node "$FLOWS_DIR/agenda-week.mjs"; then
  echo "spike: VERDICT restorable — a whole-device snapshot survives an erase."
  echo "spike: D2 resolves toward pair-once; record the numbers and re-cost the suite."
  exit 0
fi
echo "spike: VERDICT not-restorable — the restored device is back at onboarding."
echo "spike: pairing stays per-suite; record this and stop re-asking."
exit 1
