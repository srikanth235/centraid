#!/usr/bin/env bash
# Centraid gateway installer entrypoint (issue #509).
#
# From a clone (full options, including --from-pack-dir):
#   bash scripts/install-gateway.sh --no-global
#
# After @centraid/gateway is on npm (OpenClaw-style one-liner):
#   curl -fsSL --proto '=https' --tlsv1.2 \
#     https://raw.githubusercontent.com/srikanth235/centraid/main/scripts/install-gateway.sh \
#     | bash -s -- --version latest
#
# Piped mode installs via npm only (no silent OS service). Checkout mode
# delegates to install-gateway.mjs for prefix/pack-dir/dry-run helpers.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
MJS=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  if [[ -f "${SCRIPT_DIR}/install-gateway.mjs" ]]; then
    MJS="${SCRIPT_DIR}/install-gateway.mjs"
  fi
fi
if [[ -z "$MJS" && -n "${CENTRAID_INSTALL_ROOT:-}" && -f "${CENTRAID_INSTALL_ROOT}/scripts/install-gateway.mjs" ]]; then
  MJS="${CENTRAID_INSTALL_ROOT}/scripts/install-gateway.mjs"
fi

if [[ -n "$MJS" ]]; then
  command -v node >/dev/null 2>&1 || { echo "error: Node.js required" >&2; exit 1; }
  exec node "$MJS" "$@"
fi

# ── Piped curl|bash (no checkout): npm global/prefix only ─────────────────
VERSION="latest"
PREFIX=""
GLOBAL=1
DRY=0
WITH_SERVICE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      cat <<'EOF'
Centraid gateway installer (piped / npm-only mode)

  curl -fsSL …/install-gateway.sh | bash -s -- [--version <spec>] [--prefix <dir>] [--dry-run]

For --from-pack-dir and full dry-run messaging, clone the repo and run:
  bash scripts/install-gateway.sh …
EOF
      exit 0
      ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --prefix) PREFIX="${2:-}"; GLOBAL=0; shift 2 ;;
    --no-global) GLOBAL=0; PREFIX="${PREFIX:-${HOME}/.centraid}"; shift ;;
    --global) GLOBAL=1; PREFIX=""; shift ;;
    --dry-run) DRY=1; shift ;;
    --with-service) WITH_SERVICE=1; shift ;;
    --from-pack-dir)
      echo "error: --from-pack-dir requires a git checkout of scripts/install-gateway.mjs" >&2
      exit 2
      ;;
    *) echo "error: unknown option $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "error: Node.js >= 22 required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "error: npm required" >&2; exit 1; }

MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$MAJOR" -lt 22 ]]; then
  echo "error: Node.js >= 22 required (found $(node -v))" >&2
  exit 1
fi

NPM_ARGS=(install)
if [[ "$GLOBAL" -eq 1 ]]; then
  NPM_ARGS+=(-g)
else
  mkdir -p "$PREFIX"
  NPM_ARGS+=(--prefix "$PREFIX")
fi
NPM_ARGS+=("@centraid/gateway@${VERSION}")

echo "==> Centraid gateway install (piped npm mode, node $(node -v))"
echo "==> npm ${NPM_ARGS[*]}"
if [[ "$DRY" -eq 1 ]]; then
  echo "OK dry-run complete (no changes)"
  exit 0
fi
npm "${NPM_ARGS[@]}"
echo "Installed centraid-gateway."
echo ""
echo "Start: centraid-gateway serve --data-dir ~/.local/share/centraid/gateway --host 127.0.0.1 --port 8787"
echo "Token: centraid-gateway print-token --data-dir ~/.local/share/centraid/gateway"
echo "Optional service (opt-in): centraid-gateway service install --data-dir ~/.local/share/centraid/gateway"
if [[ "$WITH_SERVICE" -eq 1 ]]; then
  echo "==> with-service: run service install yourself when ready (H5 — not auto)"
fi
echo "OK gateway install complete"
