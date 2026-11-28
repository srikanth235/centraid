#!/usr/bin/env bash
# Seed a demo vault and put it where a shell finds it.
#
#   mobile/scripts/demo-vault.sh ios       # the booted simulator (or $CENTRAID_SIMULATOR)
#   mobile/scripts/demo-vault.sh android   # the attached device or emulator
#   mobile/scripts/demo-vault.sh both
#
# The vault is founded and filled through the vault's own commands by
# `nativetools seed` from `crates/nativetools/tests/fixtures/world.json`, so it
# is a real vault of the current schema. It is never committed: its rows move
# with the world's clock. Re-run it after pulling.
#
# The Locker and backup keys come from the public all-`abandon` recovery words.
# A shell has no BIP-39 of its own, so this prints their seed as hex on a line
# `CENTRAID_DEMO_SEED=<hex>`; the iOS launch environment `CENTRAID_DEV_SEED` and
# Android's `dev.centraid.DEV_SEED` extra hand it to a DEBUG build, which never
# reads either in a release build.
#
# CENTRAID_DEMO_DIR names the staging directory (default /tmp/centraid-demo).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target="${1:-both}"
staging="${CENTRAID_DEMO_DIR:-/tmp/centraid-demo}"
world="$root/crates/nativetools/tests/fixtures/world.json"
stem="demo-vault"

rm -rf "$staging"
mkdir -p "$staging/$stem"
echo "==> seeding $staging/$stem/vault.db"
(cd "$root" && cargo run -q -p centraid-nativetools --bin nativetools -- seed "$world" "$staging/$stem/vault.db")
# The app's byte store is `vault.bytes` beside the file; the seeder keeps its
# content store in `vault.db.blobs`, which the app's store adopts.
if [ -d "$staging/$stem/vault.db.blobs" ]; then
  mv "$staging/$stem/vault.db.blobs" "$staging/$stem/vault.bytes"
fi
rm -f "$staging/$stem/vault.db-wal" "$staging/$stem/vault.db-shm"

demo_seed="$(python3 - <<'PY'
import hashlib
words = " ".join(["abandon"] * 11 + ["about"])
print(hashlib.pbkdf2_hmac("sha512", words.encode(), b"mnemonic", 2048).hex())
PY
)"
echo "CENTRAID_DEMO_SEED=$demo_seed"

place_ios() {
  local udid="${CENTRAID_SIMULATOR:-booted}"
  local container
  if ! container="$(xcrun simctl get_app_container "$udid" dev.centraid.Centraid data 2>/dev/null)"; then
    echo "error: no booted simulator with the app installed" >&2
    return 1
  fi
  local home="$container/Documents/$stem"
  echo "==> ios: $home"
  rm -rf "$home"
  mkdir -p "$container/Documents"
  cp -R "$staging/$stem" "$home"
  [ -f "$home/vault.db" ] || { echo "error: vault was not placed in the iOS app container" >&2; return 1; }
  SIMCTL_CHILD_CENTRAID_DEV_SEED="$demo_seed" \
    xcrun simctl launch --terminate-running-process "$udid" dev.centraid.Centraid >/dev/null
}

place_android() {
  local adb="${ANDROID_HOME:-}/platform-tools/adb"
  [ -x "$adb" ] || adb="$(command -v adb || echo adb)"
  if ! "$adb" get-state >/dev/null 2>&1; then
    echo "error: no Android device is connected" >&2
    return 1
  fi
  echo "==> android: files/$stem"
  "$adb" push "$staging/$stem/vault.db" "/data/local/tmp/$stem.db" >/dev/null
  "$adb" shell "rm -rf /data/local/tmp/$stem.bytes" >/dev/null 2>&1 || true
  if [ -d "$staging/$stem/vault.bytes" ]; then
    "$adb" push "$staging/$stem/vault.bytes" "/data/local/tmp/$stem.bytes" >/dev/null
  fi
  "$adb" shell "run-as dev.centraid sh -c 'rm -rf files/$stem && mkdir -p files/$stem && cat /data/local/tmp/$stem.db > files/$stem/vault.db && { [ ! -d /data/local/tmp/$stem.bytes ] || cp -R /data/local/tmp/$stem.bytes files/$stem/vault.bytes; }'" \
    || { echo "error: vault was not placed; install the app and re-run" >&2; return 1; }
  "$adb" shell "run-as dev.centraid test -f files/$stem/vault.db" \
    || { echo "error: vault is missing from the Android app container" >&2; return 1; }
  "$adb" shell am start -S -n dev.centraid/dev.centraid.android.MainActivity \
    --es dev.centraid.DEV_SEED "$demo_seed" >/dev/null 2>&1 \
    || { echo "error: app launch failed after vault placement" >&2; return 1; }
}

case "$target" in
  ios) place_ios ;;
  android) place_android ;;
  both) place_ios; place_android ;;
  *) echo "usage: demo-vault.sh [ios|android|both]" >&2; exit 2 ;;
esac
echo "==> done"
