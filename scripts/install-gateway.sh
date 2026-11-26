#!/usr/bin/env bash
# Centraid gateway installer entrypoint (#1020, #1214).
# Delegates to deploy/vps/install.sh (binary release tarball + SHA256SUMS + identity check).
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  VPS_INSTALL="${SCRIPT_DIR}/../deploy/vps/install.sh"
  if [[ -f "$VPS_INSTALL" ]]; then
    exec bash "$VPS_INSTALL" "$@"
  fi
fi

REPO="${CENTRAID_REPO:-srikanth235/centraid}"
REF="${CENTRAID_REF:-main}"
command -v curl >/dev/null 2>&1 || { echo "error: curl required" >&2; exit 1; }
exec bash <(curl --proto '=https' --tlsv1.2 -fsSL "https://raw.githubusercontent.com/${REPO}/${REF}/deploy/vps/install.sh") "$@"
