#!/usr/bin/env bash
# Seed a throwaway vault and put it where each shell will find it (#1020, wave A).
#
#   mobile/scripts/demo-vault.sh            # seed + place on both, if running
#   mobile/scripts/demo-vault.sh android    # just the emulator
#   mobile/scripts/demo-vault.sh ios        # just the simulator
#
# WHY A SCRIPT AND NOT A COMMITTED FILE. The vault is 3.7 MB of SQLite whose
# rows move with the scenario's "now", so a committed copy would churn in every
# diff and be unreviewable in all of them. The generator is one command.
#
# WHY NOT OVER THE NETWORK. Because the DEVICE half of the network is not
# built. The GATEWAY half now is: `centraid gateway` serves an admitted seat
# real log pages off its own vault, and `crates/centraid/tests/seat_lane.rs`
# pairs with the shipped binary over QUIC and reads them back. What a phone
# still cannot do is dial it — `Handle::start_endpoint` is a stub and the C ABI
# answers `Request::Pair` with NotYetAvailable — so the vault is PLACED rather
# than synced, which is the same file a seat would have ended up holding, minus
# the download.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target="${1:-both}"
staging="${CENTRAID_DEMO_DIR:-/tmp/centraid-demo}"

# TWO VAULTS, AND DELIBERATELY UNALIKE.
#
# The switcher is only testable against two, and two vaults holding the same
# rows under the same name would prove nothing — a switch that quietly did not
# happen would look exactly like one that did. "Work" is seeded `--only` three
# apps, so the springboard visibly changes: People, Notes, Photos and Tally are
# genuinely empty over there, which is a state the grid already knows how to
# say and does not have to invent.
echo "==> seeding $staging"
(cd "$root" && cargo run -q -p centraid --bin seed-demo-vault -- "$staging")
(cd "$root" && cargo run -q -p centraid --bin seed-demo-vault -- "$staging" \
  --file work-vault.db --name "Work" --only docs,tasks,agenda)
vaults=("$staging/demo-vault.db" "$staging/work-vault.db")

place_android() {
  local adb="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/platform-tools/adb"
  if ! "$adb" get-state >/dev/null 2>&1; then
    echo "==> no android device; skipping"
    return
  fi
  mkdir -p "$root/mobile/androidApp/src/main/assets"
  for vault in "${vaults[@]}"; do
    local name; name="$(basename "$vault")"
    echo "==> android: $name -> assets + running app's files dir"
    cp "$vault" "$root/mobile/androidApp/src/main/assets/$name"
    # Also push it into a live install, so a re-seed does not need a rebuild.
    # `run-as` is the only door into an app's private storage on a debug build.
    "$adb" push "$vault" "/data/local/tmp/$name" >/dev/null
    "$adb" shell "run-as dev.centraid sh -c 'cat /data/local/tmp/$name > files/$name'" \
      2>/dev/null || echo "   (the app is not installed yet; the asset copy will seed it on first run)"
    # THE BYTES TRAVEL WITH THE ROWS. `<vault>.blobs/` holds every photograph;
    # a vault copied without it is a library of rows pointing at nothing.
    # Android assets are flat files, so the CAS goes over adb only — a fresh
    # install gets its rows from the asset and its bytes on the next re-seed.
    if [ -d "$vault.blobs" ]; then
      "$adb" push "$vault.blobs" "/data/local/tmp/$name.blobs" >/dev/null 2>&1 || true
      "$adb" shell "run-as dev.centraid sh -c 'mkdir -p files/$name.blobs && cp /data/local/tmp/$name.blobs/* files/$name.blobs/'" \
        2>/dev/null || true
    fi
  done
}

place_ios() {
  local udid="${CENTRAID_SIMULATOR:-booted}"
  local container
  if ! container="$(xcrun simctl get_app_container "$udid" dev.centraid.Centraid data 2>/dev/null)"; then
    echo "==> no booted simulator with the app installed; skipping"
    return
  fi
  mkdir -p "$container/Documents"
  for vault in "${vaults[@]}"; do
    local name; name="$(basename "$vault")"
    echo "==> ios: $name -> $container/Documents"
    cp "$vault" "$container/Documents/$name"
    # The WAL and the shared-memory file belong to the copy, not to this one.
    rm -f "$container/Documents/$name-wal" "$container/Documents/$name-shm"
    # THE BYTES TRAVEL WITH THE ROWS. `<vault>.blobs/` holds every photograph
    # (`Vault::blobs_root_for`); a vault copied without it is a library of rows
    # pointing at bytes the device does not have.
    rm -rf "$container/Documents/$name.blobs"
    if [ -d "$vault.blobs" ]; then
      cp -R "$vault.blobs" "$container/Documents/$name.blobs"
    fi
  done
}

case "$target" in
  android) place_android ;;
  ios) place_ios ;;
  both) place_android; place_ios ;;
  *) echo "usage: demo-vault.sh [android|ios|both]" >&2; exit 2 ;;
esac
echo "==> done"
