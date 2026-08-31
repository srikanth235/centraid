#!/usr/bin/env bash
# Shared steps for regenerating apps/web Iroh WASM on Ubuntu CI (issue #468 K15).
#
# #892 Phase 0/1 — THIS IS NOW A NO-OP ON EVERY LANE THAT DOES NOT REBUILD.
# `apps/web/src/generated/centraid_web_iroh_bg.wasm` is a COMMITTED 1.9 MB
# artifact (the `iroh-wasm` lane refreshes it deliberately; see its "refresh
# committed artifacts" note). `apps/web/scripts/ensure-iroh-wasm.mjs` therefore
# exits 0 immediately on any normal checkout — the file is already there. But
# four jobs (`verify`, and all three of `lane-client-e2e`) ran this script
# unconditionally first, so each paid `rustup target add` plus
# `cargo install wasm-bindgen-cli --locked` plus an apt install — roughly 1.7
# minutes measured — provisioning a toolchain for a build that cannot happen.
# Its own header comment said the binary was gitignored; it has not been for
# some time, and nothing noticed because the cost is invisible when the outcome
# is correct.
#
# The guard below is the whole fix, and it deliberately does NOT change what
# happens when the artifact is genuinely absent: a clean checkout that somehow
# lacks it still provisions and still rebuilds, exactly as before. Set
# `FORCE_IROH_WASM=1` to provision unconditionally — the same variable
# `ensure-iroh-wasm.mjs` reads to force the rebuild this toolchain serves, so
# the two cannot disagree about whether a build is going to happen.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
wasm="$repo_root/apps/web/src/generated/centraid_web_iroh_bg.wasm"

if [ "${FORCE_IROH_WASM:-}" != "1" ] && [ -f "$wasm" ]; then
  echo "iroh-wasm: committed binding present ($wasm) — no rebuild, so no toolchain to install"
  exit 0
fi

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null 2>&1 || [[ "$(wasm-bindgen --version 2>/dev/null || true)" != *0.2.108* ]]; then
  cargo install wasm-bindgen-cli --version 0.2.108 --locked
fi
if ! command -v clang >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y clang lld
fi
