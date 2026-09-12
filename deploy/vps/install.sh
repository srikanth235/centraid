#!/usr/bin/env bash
# THE VPS INSTALLER (#1020, D-1020-G1). One binary, one data directory, no
# service unless you ask for one.
#
# Three rules, each carried from the v0 installer it replaces
# (`scripts/install-gateway.sh`, `scripts/install-gateway.mjs`):
#
#   1. `set -euo pipefail`. A pipeline that half-worked must not look installed.
#   2. It NEVER installs an OS service silently. `--with-service` PRINTS the
#      commands; only `--yes` runs them. A gateway that started because a
#      tarball was unpacked is a gateway nobody chose to run.
#   3. Nothing is trusted that was not verified: the tarball is checked against
#      SHA256SUMS, and the installed binary's own identity stamp is checked
#      against the release it claims to be from (#1020 Artifacts). A digest
#      mismatch is an abort, not a warning.
#
# Usage:
#   install.sh --version v1.2.3 [--prefix /usr/local] [--data-dir /var/lib/centraid/default]
#              [--with-service [--system] [--instance NAME]] [--yes]
#   install.sh --local ./centraid-x86_64-unknown-linux-gnu.tar.gz [--sums ./SHA256SUMS] …
#
# `--local` is how the release smoke installs the artifact it just built, so the
# smoke exercises THIS script and not a second copy of its logic
# (`cargo xtask gate --profile release`, step `vps-smoke`).

set -euo pipefail

REPO="${CENTRAID_REPO:-srikanth235/centraid}"
BASE_URL="${CENTRAID_RELEASE_BASE_URL:-https://github.com/${REPO}/releases/download}"

version=""
local_tarball=""
local_sums=""
prefix="/usr/local"
data_dir=""
with_service=0
system_unit=0
instance="default"
assume_yes=0

die() {
  echo "install.sh: $*" >&2
  exit 1
}

say() { echo "install.sh: $*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --local) local_tarball="${2:-}"; shift 2 ;;
    --sums) local_sums="${2:-}"; shift 2 ;;
    --prefix) prefix="${2:-}"; shift 2 ;;
    --data-dir) data_dir="${2:-}"; shift 2 ;;
    --instance) instance="${2:-}"; shift 2 ;;
    --with-service) with_service=1; shift ;;
    --system) system_unit=1; shift ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) sed -n '1,26p' "$0"; exit 0 ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
done

# THE TRIPLE IS THE ARTIFACT NAME. The same rule v0's native matrix follows —
# `centraid-tunnel-native.${platform}-${arch}.node`, where the name IS the key
# (census §G5). An unrecognised host fails here rather than downloading
# something that will not exec.
case "$(uname -s)" in
  Linux) os="unknown-linux-gnu" ;;
  Darwin) os="apple-darwin" ;;
  *) die "$(uname -s) is not a supported host. The published triples are in docs/release.md." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch="x86_64" ;;
  aarch64|arm64) arch="aarch64" ;;
  *) die "$(uname -m) is not a supported architecture. The published triples are in docs/release.md." ;;
esac
triple="${arch}-${os}"
say "host triple ${triple}"

work="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '${work}'" EXIT

tarball="centraid-${triple}.tar.gz"

if [ -n "$local_tarball" ]; then
  [ -f "$local_tarball" ] || die "no tarball at ${local_tarball}"
  cp "$local_tarball" "${work}/${tarball}"
  if [ -n "$local_sums" ]; then
    [ -f "$local_sums" ] || die "no SHA256SUMS at ${local_sums}"
    cp "$local_sums" "${work}/SHA256SUMS"
  else
    die "--local needs --sums: an unverified tarball is the thing this script exists to refuse"
  fi
else
  [ -n "$version" ] || die "pass --version vX.Y.Z or --local <tarball>"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  say "downloading ${tarball} from ${BASE_URL}/${version}"
  curl --proto '=https' --tlsv1.2 -sSfL "${BASE_URL}/${version}/${tarball}" -o "${work}/${tarball}"
  curl --proto '=https' --tlsv1.2 -sSfL "${BASE_URL}/${version}/SHA256SUMS" -o "${work}/SHA256SUMS"
fi

# VERIFY, THEN UNPACK. In that order: unpacking first and checking afterwards
# has already written whatever the archive contained.
say "verifying ${tarball} against SHA256SUMS"
(
  cd "$work"
  # `--ignore-missing` so a SHA256SUMS covering every triple verifies the one
  # we actually have; `grep` first so an absent line is an abort and not a
  # vacuous pass over zero files, which is how `sha256sum -c --ignore-missing`
  # reports success on an empty selection.
  grep -q "  ${tarball}\$" SHA256SUMS \
    || { echo "install.sh: SHA256SUMS has no line for ${tarball}" >&2; exit 1; }
  sha256sum -c --ignore-missing SHA256SUMS >/dev/null
)
say "checksum ok"

tar -xzf "${work}/${tarball}" -C "$work"
[ -f "${work}/centraid" ] || die "${tarball} does not contain a \`centraid\` binary at its root"

# THE IDENTITY STAMP (#1020 Artifacts, D-1020-G2). The binary reports the git
# sha and the artifact digest it was built from; the release publishes the same
# digest in `centraid-<triple>.identity.json`. Checking them here is what makes
# "the shell refuses a stale artifact" true on the install path as well as at
# `open`. When the release carries no identity file the script SAYS the check
# did not run — a silent skip is the failure mode the whole scheme exists to
# avoid.
identity_expected=""
if [ -n "$local_tarball" ]; then
  candidate="${local_tarball%.tar.gz}.identity.json"
  [ -f "$candidate" ] && identity_expected="$candidate"
else
  if curl --proto '=https' --tlsv1.2 -sSfL \
    "${BASE_URL}/${version}/centraid-${triple}.identity.json" \
    -o "${work}/identity.json" 2>/dev/null; then
    identity_expected="${work}/identity.json"
  fi
fi

if [ -n "$identity_expected" ]; then
  reported="$("${work}/centraid" --version --json)"
  # One field at a time, by hand, because this script runs on a freshly
  # unpacked host where `jq` may not exist — and pulling in a JSON parser to
  # read three scalars would make the verification depend on something the
  # verification has not verified. `schemaVersion` is a NUMBER and the other two
  # are strings, so the extractor accepts both shapes; a quoted-only pattern
  # read `schemaVersion` as empty and this check died on its own artifact.
  field_of() {
    printf '%s' "$2" \
      | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
      | head -1
  }
  number_of() {
    printf '%s' "$2" \
      | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" \
      | head -1
  }
  for field in gitSha digest schemaVersion; do
    want="$(field_of "$field" "$(cat "$identity_expected")")"
    got="$(field_of "$field" "$reported")"
    if [ -z "$want" ] && [ -z "$got" ]; then
      want="$(number_of "$field" "$(cat "$identity_expected")")"
      got="$(number_of "$field" "$reported")"
    fi
    [ -n "$want" ] || die "the release identity file states no ${field}"
    if [ "$want" != "$got" ]; then
      die "IDENTITY MISMATCH on ${field}: the release says '${want}', the binary says '${got}'. This artifact is not the one this release published — refusing to install it."
    fi
  done
  say "identity ok (gitSha, digest, schemaVersion all match the release)"
else
  say "NO IDENTITY FILE was published beside this artifact, so the stamp was NOT checked."
  say "  This is the check that catches a stale or swapped core. See docs/release.md."
fi

install -d "${prefix}/bin"
install -m 0755 "${work}/centraid" "${prefix}/bin/centraid"
say "installed ${prefix}/bin/centraid — $("${prefix}/bin/centraid" --version)"

# Symbols, when the release published them. Kept beside the binary so a crash
# report from a member is readable at all; never required, because a stripped
# binary still runs.
if [ -f "${work}/centraid.debug" ]; then
  install -d "${prefix}/lib/debug"
  install -m 0644 "${work}/centraid.debug" "${prefix}/lib/debug/centraid.debug"
  say "installed ${prefix}/lib/debug/centraid.debug"
fi

if [ -z "$data_dir" ]; then
  if [ "$system_unit" -eq 1 ]; then
    data_dir="/var/lib/centraid/${instance}"
  else
    data_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/centraid"
  fi
fi
say "data directory ${data_dir} (bind-mount or back this up; it is the vault)"

if [ "$with_service" -eq 0 ]; then
  say ""
  say "NO SERVICE was installed. That is the default."
  say "To run the gateway now:   ${prefix}/bin/centraid gateway --data-dir ${data_dir}"
  say "To install a unit:        install.sh … --with-service --system --instance ${instance}"
  exit 0
fi

service_cmd=("${prefix}/bin/centraid" gateway install --data-dir "${data_dir}")
if [ "$system_unit" -eq 1 ]; then
  service_cmd+=(--system --instance "${instance}")
  enable_cmd="sudo systemctl enable --now centraid-gateway@${instance}"
else
  enable_cmd="systemctl --user enable --now centraid-gateway"
fi

if [ "$assume_yes" -eq 0 ]; then
  say ""
  say "--with-service without --yes: the unit was NOT written and nothing was enabled."
  say "Read the unit first:"
  say "  ${service_cmd[*]} --dry-run"
  say "Then, if you agree with it:"
  say "  ${service_cmd[*]}"
  say "  ${enable_cmd}"
  exit 0
fi

say "writing the unit (--yes)"
"${service_cmd[@]}"
say ""
say "The unit is written and the service is NOT enabled. Enabling is yours:"
say "  ${enable_cmd}"
