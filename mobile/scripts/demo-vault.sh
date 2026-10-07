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
demo_out="$(cd "$root" && cargo run -q -p centraid --bin seed-demo-vault -- "$staging")"
echo "$demo_out"
# THE DEMO LOCKER IS SEALED UNDER THE PUBLIC all-`abandon` WORDS (D-6), and a
# phone opens it only KEYED — with that seed in its secure store (#1047 W2). A
# shell has no BIP-39 of its own, so the seeder prints the seed as hex and each
# place_* below relaunches a DEBUG build with it; a release build never reads it.
demo_seed="$(printf '%s\n' "$demo_out" | sed -n 's/^CENTRAID_DEMO_SEED=//p')"
(cd "$root" && cargo run -q -p centraid --bin seed-demo-vault -- "$staging" \
  --file work-vault.sqlite3 --name "Work" --only docs,tasks,agenda)
# ONE DIRECTORY PER VAULT, AND THE FILE IS `vault.db` (#1047, Q-1047-17).
# `Shelf` adopts `<vault dir>/<name>/vault.db` and nothing else, because the
# core keeps a vault's backup home beside its file and two files in one
# directory would share one. Each fixture is placed as `<stem>/vault.db` with
# its byte store as `<stem>/vault.bytes` (`with_extension("bytes")`).
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
    local stem="${name%.*}"
    echo "==> android: $name -> assets + running app's files/$stem/vault.db"
    # The asset keeps its flat name; `MainActivity` places it as
    # `files/<stem>/vault.db`.
    cp "$vault" "$root/mobile/androidApp/src/main/assets/$name"
    # Also push it into a live install, so a re-seed does not need a rebuild.
    # `run-as` is the only door into an app's private storage on a debug build.
    "$adb" push "$vault" "/data/local/tmp/$name" >/dev/null
    "$adb" shell "run-as dev.centraid sh -c 'mkdir -p files/$stem && rm -f files/$stem/vault.db-wal files/$stem/vault.db-shm && cat /data/local/tmp/$name > files/$stem/vault.db'" \
      2>/dev/null || echo "   (the app is not installed yet; the asset copy will seed it on first run)"
    # THE BYTES TRAVEL WITH THE ROWS. `<stem>.bytes/` is the vault's one content
    # store (#1025 S3); a vault copied without it is a library of rows pointing
    # at nothing. Android assets are flat files, so the store goes over adb only
    # — a fresh install gets its rows from the asset and its bytes on the next
    # re-seed. Copied RECURSIVELY: it is iroh's store, an index and a `data/`
    # directory, not the one-file-per-hash CAS it replaced.
    local bytes="${vault%.*}.bytes"
    local bytes_name="$stem.bytes"
    if [ -d "$bytes" ]; then
      "$adb" push "$bytes" "/data/local/tmp/$bytes_name" >/dev/null 2>&1 || true
      "$adb" shell "run-as dev.centraid sh -c 'rm -rf files/$stem/vault.bytes && cp -R /data/local/tmp/$bytes_name files/$stem/vault.bytes'" \
        2>/dev/null || true
    fi
  done
  # RELAUNCH WITH THE DEMO SEED (#1047 W2). `-S` stops the running process so
  # the shelf reopens every vault keyed; `MainActivity` reads the extra only
  # when the build is debuggable. The seed lands in Block Store, so a later
  # plain launch stays keyed.
  if [ -n "$demo_seed" ]; then
    echo "==> android: relaunching with the demo seed"
    "$adb" shell am start -S -n dev.centraid/dev.centraid.android.MainActivity \
      --es dev.centraid.DEV_SEED "$demo_seed" >/dev/null 2>&1 \
      || echo "   (the app is not installed yet; re-run after installing)"
  fi
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
    local home="$container/Documents/${name%.*}"
    echo "==> ios: $name -> $home/vault.db"
    mkdir -p "$home"
    cp "$vault" "$home/vault.db"
    # The WAL and the shared-memory file belong to the copy, not to this one.
    rm -f "$home/vault.db-wal" "$home/vault.db-shm"
    # THE BYTES TRAVEL WITH THE ROWS. `<stem>.bytes/` is the vault's one content
    # store (#1025 S3, D-1025-S3-1) — the same directory `SeatLink` opens and
    # the byte plane fetches into; a vault copied without it is a library of
    # rows pointing at bytes the device does not have.
    local bytes="${vault%.*}.bytes"
    rm -rf "$home/vault.bytes"
    if [ -d "$bytes" ]; then
      cp -R "$bytes" "$home/vault.bytes"
    fi
  done
  # RELAUNCH WITH THE DEMO SEED (#1047 W2). `simctl` hands `SIMCTL_CHILD_*` to
  # the app's environment; `ShellModel.devSeedHex` reads it under `#if DEBUG`
  # only. The seed lands in the Keychain, so a later plain launch stays keyed.
  if [ -n "$demo_seed" ]; then
    echo "==> ios: relaunching with the demo seed"
    SIMCTL_CHILD_CENTRAID_DEV_SEED="$demo_seed" \
      xcrun simctl launch --terminate-running-process "$udid" dev.centraid.Centraid >/dev/null
  fi
}

case "$target" in
  android) place_android ;;
  ios) place_ios ;;
  both) place_android; place_ios ;;
  *) echo "usage: demo-vault.sh [android|ios|both]" >&2; exit 2 ;;
esac
echo "==> done"
