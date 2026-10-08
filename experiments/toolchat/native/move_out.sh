#!/usr/bin/env bash
# Take the built and held-out data out of the tree, after a data version is published and its commit is pinned (#1088, R-1088-16).
#
#   HF_TOKEN=... NATIVETOOLS=target/debug/nativetools experiments/toolchat/native/move_out.sh
#   ARTEFACTS_SOURCE=/path/to/data-v7 NATIVETOOLS=target/debug/nativetools experiments/toolchat/native/move_out.sh
#
# Run it from a clean checkout of the branch that holds the artefacts.json `artefacts.py pin` wrote (git status shows nothing).
# The round trip reads the version from ARTEFACTS_SOURCE (a local directory laid out as a version: no token) when that is set,
# and from the private Hub repository at the pinned commit otherwise (HF_TOKEN). It stops at the first thing that is not as it
# must be, before it changes the index:
#
#   1. artefacts.json pins a commit of the data version, and every file in the manifest is in place and matches;
#   2. the gate workflow patch applies;
#   3. a round trip: every manifest file is moved aside, `artefacts.py fetch` brings it back (the public worlds rebuild from
#      their builders, the rest is read from the version, the keys files are seeded), `artefacts.py check` passes and so does
#      `artefacts.py verify-heldout`. A failure puts the files back.
#
# Then it takes the files out of the index (`git rm --cached`: the working tree keeps them), writes the .gitignore block,
# applies the workflow patch (the `native-python` job materialises the public worlds with `fetch --public-only`: no secret, and
# the suite reads no held-out file) and removes itself and the patch. It commits nothing: review `git status`, then commit with
# a message such as
#
#   build(native): move the built and held-out data to the private data version (#1088)
#
# The history is not rewritten; the bytes stay in the commits already pushed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
cd "$here"

fail() {
  echo "move_out: $*" >&2
  exit 1
}

[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "the working tree is not clean; commit the manifest that records the pinned commit first"
python3 - <<'PY' || fail "artefacts.json pins no commit of the data version yet: publish it and pin it first (README.md, Data versions)"
import json, re, sys
pin = json.load(open("artefacts.json"))["data"]
sys.exit(0 if pin.get("revision") and re.fullmatch(r"[0-9a-f]{40}", pin["revision"]) else 1)
PY
python3 artefacts.py check || fail "a manifest file is missing or differs; fix that before anything leaves the tree"
git -C "$root" apply --check "$here/move_out.gate.patch" || fail "move_out.gate.patch no longer applies to .github/workflows/gate.yml; add its step by hand (README.md, Data versions)"
[ -x "${NATIVETOOLS:-$root/target/debug/nativetools}" ] || fail "no nativetools binary: build it (cargo build -p centraid-nativetools --bin nativetools) or set NATIVETOOLS; the keys files rebuild by seeding"
if [ -n "${ARTEFACTS_SOURCE:-}" ]; then
  [ -f "$ARTEFACTS_SOURCE/version.json" ] || fail "ARTEFACTS_SOURCE=$ARTEFACTS_SOURCE is not a data version (no version.json)"
  echo "== the round trip reads the version from $ARTEFACTS_SOURCE"
else
  [ -n "${HF_TOKEN:-}" ] || fail "neither ARTEFACTS_SOURCE nor HF_TOKEN is set; the round trip reads the version from the private Hub repository"
  echo "== the round trip reads the version from the private Hub repository at the pinned commit"
fi

backup="$(mktemp -d)"
done_ok=0
restore() {
  if [ "$done_ok" -ne 1 ]; then
    echo "move_out: round trip failed; putting the files back" >&2
    (cd "$backup" && find . -type f -print0 | while IFS= read -r -d '' f; do mkdir -p "$here/$(dirname "$f")" && mv -f "$f" "$here/$f"; done)
  fi
  rm -rf "$backup"
}
trap restore EXIT

echo "== round trip: move the files aside, fetch, check"
python3 artefacts.py paths | while IFS= read -r path; do
  mkdir -p "$backup/$(dirname "$path")"
  mv "$path" "$backup/$path"
done
python3 artefacts.py fetch
python3 artefacts.py check
python3 artefacts.py verify-heldout
done_ok=1

echo "== take the files out of the index"
python3 artefacts.py paths | xargs git rm --cached -q --

echo "== .gitignore"
touch .gitignore
sed -i '/^# artefacts.json: begin/,/^# artefacts.json: end/d' .gitignore
python3 artefacts.py gitignore >>.gitignore
git add .gitignore

echo "== the native-python job materialises the public worlds"
git -C "$root" apply --index "$here/move_out.gate.patch"

n="$(python3 artefacts.py paths | wc -l)"
echo "== this script and its patch have done their work"
git rm -q -- move_out.sh move_out.gate.patch

echo
echo "move_out: done. $n files left the index and are ignored; they are in the working tree."
echo "Review git status, run actionlint on .github/workflows/gate.yml, then commit."
