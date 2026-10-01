#!/usr/bin/env bash
# eval_chat.sh CKPT_DIR NAME [SET ...]   (sets default: dev90)
# HF checkpoint -> bf16 GGUF -> constrained decode -> run-model score, per set.
# blind/holdout write under out/sealed/ and print only the headline lines.
set -euo pipefail
SP=${SP:-/tmp/claude-0/-home-user-centraid/f31227f9-ca10-5f19-9c12-db2b239388c1/scratchpad}
export SP HF_HOME=$SP/hf HF_HUB_OFFLINE=1
HERE=$(cd "$(dirname "$0")" && pwd)
CKPT=$1; NAME=$2; shift 2
SETS=${*:-dev90}
PY=$SP/ft/bin/python
GGUF=$SP/gguf/$NAME-bf16.gguf  # bf16: an f16 GGUF of the v6 delta gave NaN logits in llama.cpp
mkdir -p "$SP/gguf"
[ -f "$GGUF" ] || "$PY" "$HERE/eval_chat.py" to-gguf --ckpt "$CKPT" --out "$GGUF" --outtype bf16
for S in $SETS; do
  "$PY" "$HERE/eval_chat.py" decode --gguf "$GGUF" --set "$S" --out "$HERE/out/$NAME-$S"
  "$PY" "$HERE/eval_chat.py" score --set "$S" --out "$HERE/out/$NAME-$S"
done
