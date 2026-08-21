#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/cloud-agent-env.sh
source "${ROOT}/scripts/cloud-agent-env.sh"

git config core.hooksPath .githooks
mkdir -p "${HOME}/.centraid/gw-data"
