#!/usr/bin/env bash
# Install the pinned Maestro CLI, from a checksum-verified release artifact.
#
# WHY THIS EXISTS (#892 Phase 3). Every mobile device lane used to run
#
#     curl -fsSL "https://get.maestro.mobile.dev" | bash
#
# — an UNPINNED REMOTE SCRIPT, executed as the first act of a REQUIRED lane, on
# a runner that goes on to build and drive the product. It was the lone exception
# to this repo's SHA-pinning discipline: `lint-workflow-pins.mjs` refuses a
# floating `uses:` ref, gitleaks and osv-scanner both pin a version AND fetch a
# named release artifact, and this one step trusted whatever bytes a third-party
# URL served that minute. `MAESTRO_VERSION` pinned what the script would INSTALL;
# it pinned nothing about the script itself.
#
# The fix is the gitleaks/osv shape: a named release artifact, a recorded
# checksum, and a hard failure when they disagree.
#
# TO BUMP THE VERSION: add the new entry to MAESTRO_SHA256 below (compute it with
# `curl -fsSL <url> | sha256sum`), then change MAESTRO_VERSION in each lane.
# scripts/test-report/validate-nightly-wiring.mjs fails when the lanes disagree
# about the version, so a partial bump cannot ship — two device drivers on one
# roster is a difference nobody chose (#890 W0).
#
# Reads MAESTRO_VERSION from the environment, which is where every lane already
# declares it. Appends the bin directory to $GITHUB_PATH when running in Actions.
set -euo pipefail

version="${MAESTRO_VERSION:-}"
if [ -z "$version" ]; then
  echo "::error::install-maestro: MAESTRO_VERSION is required (the lane declares it)"
  exit 1
fi

# Recorded checksums, one line per pinned version. An unknown version fails here
# rather than installing something nobody has looked at — the whole point.
case "$version" in
  2.6.1)
    expected="3440825f514f537c6a96bcf5de995780c2a4a7f83a43208fdc95d4f1fecfad3b"
    ;;
  *)
    echo "::error::install-maestro: no recorded sha256 for Maestro ${version}. Add one to scripts/ci/install-maestro.sh (curl -fsSL <url> | sha256sum) rather than installing an unverified artifact."
    exit 1
    ;;
esac

url="https://github.com/mobile-dev-inc/maestro/releases/download/cli-${version}/maestro.zip"
workdir="$(mktemp -d)"
archive="${workdir}/maestro.zip"

echo "install-maestro: fetching ${url}"
curl -sSfL --retry 3 --retry-delay 5 -o "$archive" "$url"

actual="$(sha256sum "$archive" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "::error::install-maestro: checksum mismatch for Maestro ${version}."
  echo "::error::  expected ${expected}"
  echo "::error::  actual   ${actual}"
  echo "::error::Refusing to install. Either the pin is stale (bump it deliberately) or the artifact changed under a fixed tag, which is the case this check exists for."
  rm -rf "$workdir"
  exit 1
fi

rm -rf "$HOME/.maestro"
mkdir -p "$HOME"
unzip -q "$archive" -d "$workdir/unpacked"
# The archive contains a single top-level `maestro/` directory.
mv "$workdir/unpacked/maestro" "$HOME/.maestro"
rm -rf "$workdir"

chmod +x "$HOME/.maestro/bin/maestro"
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$HOME/.maestro/bin" >> "$GITHUB_PATH"
fi
export PATH="$HOME/.maestro/bin:$PATH"
echo "install-maestro: Maestro ${version} installed and checksum-verified"
maestro --version || true
