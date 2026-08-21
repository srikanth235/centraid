#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/cloud-agent-env.sh
source "${ROOT}/scripts/cloud-agent-env.sh"

exec node packages/gateway/dist/cli/cli.js serve \
  --data-dir "${HOME}/.centraid/gw-data" \
  --host 127.0.0.1 \
  --port 8765
