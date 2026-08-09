#!/usr/bin/env bash
# Select the Xcode floor shared by the iOS native-build producer and every
# parallel Maestro suite. Keeping this in one script prevents the two halves
# of the lane from drifting when the macOS image rolls.
set -euo pipefail

selected=""
for app in $(ls -d /Applications/Xcode_26.*.app 2>/dev/null | sort -V -r); do
  version="${app#/Applications/Xcode_}"
  version="${version%.app}"
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  if [ "$major" -gt 26 ] || {
    [ "$major" -eq 26 ] && [ "$minor" -ge 4 ];
  }; then
    selected="$app"
    break
  fi
done

test -n "$selected" || {
  echo "::error::no Xcode >=26.4 under /Applications (ExpoModulesJSI floor)"
  ls -d /Applications/Xcode*.app || true
  exit 1
}

echo "selecting $selected"
sudo xcode-select -s "$selected"
xcodebuild -version
swift --version
