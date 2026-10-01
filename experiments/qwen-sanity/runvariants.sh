#!/bin/sh
# One grammar-derived prompt variant, on DEV-10, against the local model.
# Usage: ./runvariants.sh <tag> <block> <arm>
set -eu
TAG="$1"; BLOCK="$2"; ARM="$3"
HERE=$(cd "$(dirname "$0")" && pwd)
python3 "$HERE/run_qwen.py" --corpus suite --dev --slots 4 \
    --block "$BLOCK" --arm "$ARM" --shots 6 \
    --out "$HERE/out/dev-$TAG" --model-name "granite-4.0-h-350m ($TAG)"
sh "$HERE/score.sh" "$HERE/out/dev-$TAG"
