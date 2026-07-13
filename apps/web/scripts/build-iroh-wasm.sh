#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/iroh-wasm"
OUT="$ROOT/src/generated"
LLVM_CLANG="$(brew --prefix llvm 2>/dev/null)/bin/clang"

if [[ ! -x "$LLVM_CLANG" ]]; then
  echo "Iroh WASM requires LLVM clang with the WebAssembly backend (brew install llvm)." >&2
  exit 1
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "Install wasm-bindgen-cli 0.2.108 before rebuilding the browser transport." >&2
  exit 1
fi

rustup target add wasm32-unknown-unknown
CC_wasm32_unknown_unknown="$LLVM_CLANG" \
  cargo build --manifest-path "$CRATE/Cargo.toml" --target wasm32-unknown-unknown --release
mkdir -p "$OUT"
wasm-bindgen \
  "$CRATE/target/wasm32-unknown-unknown/release/centraid_web_iroh.wasm" \
  --out-dir "$OUT" \
  --target web \
  --weak-refs
