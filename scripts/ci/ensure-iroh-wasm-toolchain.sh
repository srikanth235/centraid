#!/usr/bin/env bash
# Shared steps for regenerating apps/web Iroh WASM on Ubuntu CI (issue #468 K15).
set -euo pipefail
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
