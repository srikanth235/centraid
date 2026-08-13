#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.bun/bin:${PATH}"

exec node packages/gateway/dist/cli/cli.js serve \
  --data-dir "${ROOT}/.gw-data" \
  --host 127.0.0.1 \
  --port 8765
