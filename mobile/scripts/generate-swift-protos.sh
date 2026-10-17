#!/usr/bin/env bash
# THE SWIFT PROTOBUF TYPES, GENERATED FROM `crates/api-proto/proto` (#1020).
#
# `mobile/iosApp/Sources/Generated` is gitignored: it is a function of the
# schema and nothing else. It used to be written by a `protoc` command in
# `mobile/README.md` that a person ran by hand, so a tree that had skipped it —
# or run it before the last `.proto` edit — compiled against yesterday's
# messages and nothing said so. Two entry points now say so:
#
#   generate  (the default)  protoc over the proto tree, into `Sources/Generated`.
#                            Xcode runs this as `project.yml`'s pre-build phase,
#                            with the file lists below as its declared inputs
#                            and outputs, so a changed `.proto` re-runs it and
#                            an unchanged tree does not.
#   prepare                  what `xcodegen generate` runs first (`options.
#                            preGenCommand`): clear the directory, generate, and
#                            write the two file lists. `xcodegen` globs
#                            `Sources`, so the files must EXIST when it runs or
#                            the project does not contain them; and the lists
#                            are derived here, from the tree, so no second copy
#                            of "which protos" lives in `project.yml`.
#
# `protoc` and `protoc-gen-swift` come from Homebrew (`brew install protobuf
# swift-protobuf`). Neither is on the PATH Xcode gives a build phase, so the
# usual prefixes are added; a missing tool stops the build with the command
# that installs it rather than a missing-type error forty files later.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Absolute and `..`-free: the two lists below are read by Xcode as paths.
proto_dir="$(cd "$here/../../crates/api-proto/proto" 2>/dev/null && pwd)" || proto_dir=""
ios_dir="$(cd "$here/../iosApp" && pwd)"
out_dir="$ios_dir/Sources/Generated"
lists_dir="$ios_dir/.generated"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

for tool in protoc protoc-gen-swift; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is not installed or not on PATH. The Swift protobuf types are generated at build time: brew install protobuf swift-protobuf" >&2
    exit 1
  fi
done

if [ -z "$proto_dir" ]; then
  echo "error: crates/api-proto/proto is not where mobile/scripts/generate-swift-protos.sh expects it; the script is out of step with the repository layout" >&2
  exit 1
fi

# Every proto, relative to the proto root and in a stable order.
protos() {
  (cd "$proto_dir" && find . -name '*.proto' | sed 's|^\./||' | LC_ALL=C sort)
}

generate() {
  mkdir -p "$out_dir"
  # `Visibility=Public`: the generated types are used from the app target and
  # from the test bundle. The default file naming (the full path) is what the
  # output list below spells, so the two move together.
  # shellcheck disable=SC2046
  (cd "$proto_dir" && protoc --proto_path=. \
    --swift_out="$out_dir" --swift_opt=Visibility=Public \
    $(protos))
}

write_lists() {
  mkdir -p "$lists_dir"
  protos | sed "s|^|$proto_dir/|" >"$lists_dir/protos.input.xcfilelist"
  protos | sed "s|\.proto\$|.pb.swift|; s|^|$out_dir/|" >"$lists_dir/protos.output.xcfilelist"
}

check_outputs() {
  # What protoc wrote must be what the output list promises: a mismatch is a
  # build phase that re-runs for ever (an output it never produces) or never
  # (one it does not declare).
  local missing=0 path
  while IFS= read -r path; do
    if [ ! -f "$path" ]; then
      echo "error: protoc did not write $path, which the output list declares" >&2
      missing=1
    fi
  done <"$lists_dir/protos.output.xcfilelist"
  [ "$missing" -eq 0 ]
}

case "${1:-generate}" in
  generate)
    generate
    ;;
  prepare)
    rm -rf "$out_dir"
    generate
    write_lists
    check_outputs
    ;;
  *)
    echo "usage: generate-swift-protos.sh [generate|prepare]" >&2
    exit 2
    ;;
esac
