#!/usr/bin/env bash
# Same CLI and bytes on both hosted runners; no moving installer script.
set -euo pipefail
version=2.6.1
sha256=3440825f514f537c6a96bcf5de995780c2a4a7f83a43208fdc95d4f1fecfad3b
install_dir="${RUNNER_TEMP:?This installer requires RUNNER_TEMP}/centraid-maestro"
mkdir -p "$install_dir"
curl --fail --location --retry 3 \
  "https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${version}/maestro.zip" \
  --output "$install_dir/maestro.zip"
printf '%s  %s\n' "$sha256" "$install_dir/maestro.zip" | shasum -a 256 --check
unzip -q -o "$install_dir/maestro.zip" -d "$install_dir"
test -x "$install_dir/maestro/bin/maestro"
printf '%s\n' "$install_dir/maestro/bin" >> "${GITHUB_PATH:?}"
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
"$install_dir/maestro/bin/maestro" --version
