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
# THIS SEEDS A GATEWAY-ROLE VAULT, AND THAT IS ALL IT IS FOR (#1025 S1/S2).
#
# A seat no longer needs it. Pairing creates the replica: the gateway keeps a
# content-addressed snapshot of the replicated tables, the phone fetches it as a
# blob and tails from the seq it stands at, and falling under the floor is the
# same path again. Nothing about a seat is placed by hand any more, and the
# paragraph that used to stand here — "a seat REPLICA has no creation path
# through the core yet" — described the gap that #1025 S1 closed.
#
# What is left is a vault this device is the AUTHORITY for: the local-first case
# a phone is in when it holds its own vault rather than a copy of someone
# else's, and the case the springboard and the switcher are developed against
# without a gateway running. To exercise a SEAT, run `centraid gateway
# --data-dir <dir> --print-qr` and scan the code from the Settings sheet.
#
# RE-SEED AFTER PULLING. `content_uri` is `blob:blake3-…` since D-1020-B2 and it
# is the ONE form this build addresses (#1025 S3, D-1025-S3-3); the bytes live in
# `<stem>.bytes`, iroh's store, which is also the one form (D-1025-S3-1). A vault
# seeded before either reads as a grid of cells with no file behind them. The
# generator is the fix; there is no migration, by design.
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
  --file work-vault.sqlite3 --name "Work" --only docs,tasks,agenda)
# `.sqlite3` AND NOT `.db`. `Shelf.SUFFIX` takes every `*.sqlite3` in the vault
# directory as a vault and ignores everything else, so the `.db` files this
# script used to place were invisible to both shells: the switcher said "this
# device holds one vault", and a re-seed changed nothing a member could see.
vaults=("$staging/demo-vault.sqlite3" "$staging/work-vault.sqlite3")

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
    # THE BYTES TRAVEL WITH THE ROWS. `<stem>.bytes/` is the vault's one content
    # store (#1025 S3); a vault copied without it is a library of rows pointing
    # at nothing. Android assets are flat files, so the store goes over adb only
    # — a fresh install gets its rows from the asset and its bytes on the next
    # re-seed. Copied RECURSIVELY: it is iroh's store, an index and a `data/`
    # directory, not the one-file-per-hash CAS it replaced.
    local bytes="${vault%.*}.bytes"
    local bytes_name="${name%.*}.bytes"
    if [ -d "$bytes" ]; then
      "$adb" push "$bytes" "/data/local/tmp/$bytes_name" >/dev/null 2>&1 || true
      "$adb" shell "run-as dev.centraid sh -c 'rm -rf files/$bytes_name && cp -R /data/local/tmp/$bytes_name files/$bytes_name'" \
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
    # THE BYTES TRAVEL WITH THE ROWS. `<stem>.bytes/` is the vault's one content
    # store (#1025 S3, D-1025-S3-1) — the same directory `SeatLink` opens and
    # the byte plane fetches into; a vault copied without it is a library of
    # rows pointing at bytes the device does not have.
    local bytes="${vault%.*}.bytes"
    local bytes_name="${name%.*}.bytes"
    rm -rf "$container/Documents/$bytes_name"
    if [ -d "$bytes" ]; then
      cp -R "$bytes" "$container/Documents/$bytes_name"
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
