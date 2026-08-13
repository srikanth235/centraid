#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config core.hooksPath .githooks

export PATH="${HOME}/.bun/bin:${PATH}"

bun install --frozen-lockfile
bun run build
