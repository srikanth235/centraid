#!/usr/bin/env bash
# CI must use the pinned compiler; an unavailable pin is an infrastructure failure.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version="$(cat "$root/.xcode-version")"
developer="/Applications/Xcode_${version}.app/Contents/Developer"
if [ ! -d "$developer" ]; then
  echo "error: pinned Xcode $version is unavailable at $developer" >&2
  exit 1
fi
sudo xcode-select --switch "$developer"
xcodebuild -version
xcrun swift --version
[ "$(xcodebuild -version | head -1)" = "Xcode $version" ]
