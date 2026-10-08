#!/usr/bin/env bash
# Take the built and frozen artefacts out of the tree, after the upload has recorded a Hub revision (#1088, R-1088-14).
#
#   HF_TOKEN=... NATIVETOOLS=target/debug/nativetools experiments/toolchat/native/move_out.sh
#
# Run it from a clean checkout of the branch that holds the upload's artefacts.json (git status shows nothing). It stops at
# the first thing that is not as it must be, before it changes the index:
#
#   1. artefacts.json records a Hub revision for every frozen file, and every file in the manifest is in place and matches;
#   2. the gate workflow patch applies;
#   3. a round trip: every manifest file is moved aside, `artefacts.py fetch` brings it back (rebuilds from the builders and
#      the seeder, downloads from the Hub at the recorded revision), `artefacts.py check` passes. A failure puts the files back.
#
# Then it takes the files out of the index (`git rm --cached`: the working tree keeps them), writes the .gitignore block,
# applies the workflow patch (the `native-python` job materialises the artefacts before it seeds world A) and removes itself
# and the patch. It commits nothing: review `git status`, then commit with a message such as
#
#   build(native): move the built and frozen data to the private Hub (#1088)
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

[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "the working tree is not clean; commit the manifest the upload wrote first"
python3 artefacts.py verify-hub --dry-run >/dev/null || fail "artefacts.json records no Hub revision yet: run the upload first (see README.md, Artefacts)"
python3 artefacts.py check || fail "a manifest file is missing or differs; fix that before anything leaves the tree"
git -C "$root" apply --check "$here/move_out.gate.patch" || fail "move_out.gate.patch no longer applies to .github/workflows/gate.yml; add its step by hand (README.md, Artefacts)"
[ -x "${NATIVETOOLS:-$root/target/debug/nativetools}" ] || fail "no nativetools binary: build it (cargo build -p centraid-nativetools --bin nativetools) or set NATIVETOOLS; the keys files rebuild by seeding"
[ -n "${HF_TOKEN:-}" ] || fail "HF_TOKEN is not set; the round trip downloads the frozen files from the Hub"

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
done_ok=1

echo "== take the files out of the index"
python3 artefacts.py paths | xargs git rm --cached -q --

echo "== .gitignore"
touch .gitignore
sed -i '/^# artefacts.json: begin/,/^# artefacts.json: end/d' .gitignore
python3 artefacts.py gitignore >>.gitignore
git add .gitignore

echo "== the native-python job materialises the artefacts"
git -C "$root" apply --index "$here/move_out.gate.patch"

n="$(python3 artefacts.py paths | wc -l)"
echo "== this script and its patch have done their work"
git rm -q -- move_out.sh move_out.gate.patch

echo
echo "move_out: done. $n files left the index and are ignored; they are in the working tree."
echo "Review git status, run actionlint on .github/workflows/gate.yml, then commit."
