#!/usr/bin/env bash
# Build the input dataset of the Kaggle eval kernel from a checkout that has the held-out data fetched
# (`python3 experiments/toolchat/native/artefacts.py fetch`). Nothing here reads or writes a token.
#
#   crates/assist-eval/kaggle/make_bundle.sh OUT_DIR KAGGLE_OWNER WSP|S2 [GGUF]
#
# The model is a required choice, not a default. WSP is RikiyaT/Qwen3.5-0.8B-weight-space-programming, the baseline the owner
# named in chat; it has no GGUF, so GGUF is the file `train/to_gguf.py` made (default ~/.cache/centraid/models/wsp-base-Q4_0.gguf)
# and it travels in this same dataset. S2 is the public GGUF, fetched by the kernel.
#
# OUT_DIR gets: src.tar.gz (the repository at HEAD, so commit first), val.jsonl, worlds/*.json, kit.json (which model, which
# tools block) and dataset-metadata.json (a PRIVATE dataset `KAGGLE_OWNER/centraid-assist-eval-input`).
set -euo pipefail
usage="usage: make_bundle.sh OUT_DIR KAGGLE_OWNER WSP|S2 [GGUF]"
out=${1:?$usage}
owner=${2:?$usage}
which=${3:?$usage}
root=$(git rev-parse --show-toplevel)
native=$root/experiments/toolchat/native
[[ -f $native/eval/sets/val.jsonl ]] || { echo "no val.jsonl: run artefacts.py fetch first" >&2; exit 1; }
git -C "$root" diff --quiet HEAD || { echo "uncommitted changes: the kernel builds HEAD, so commit first" >&2; exit 1; }
mkdir -p "$out/worlds"
git -C "$root" archive --format=tar.gz -o "$out/src.tar.gz" HEAD
cp "$native/eval/sets/val.jsonl" "$out/val.jsonl"
cp "$native"/eval/worlds/*.json "$out/worlds/"
for w in T03 T12 T23; do cp "$native/authored/worlds/$w.json" "$out/worlds/"; done
case $which in
  # S2: public GGUF, the prompt it was trained on
  S2) model='{"url": "https://huggingface.co/srikanth235/centraid-native-gguf/resolve/s2-q4_0/centraid-native-s2-Q4_0.gguf", "sha256": "b1be1e45024c8e98f670d456edfdf261c786878dd8260117806e285af8e9f668", "tools": "s2"}' ;;
  WSP)
    gguf=${4:-$HOME/.cache/centraid/models/wsp-base-Q4_0.gguf}
    [[ -f $gguf ]] || { echo "no GGUF at $gguf: convert the model with train/to_gguf.py first" >&2; exit 1; }
    cp "$gguf" "$out/model.gguf"
    sum=$(shasum -a 256 "$out/model.gguf" | cut -d' ' -f1)
    model="{\"input\": \"model.gguf\", \"sha256\": \"$sum\", \"tools\": \"sig\"}" ;;
  *) echo "$usage" >&2; exit 1 ;;
esac

printf '{"commit": "%s", "model": %s, "shards": 2}\n' "$(git -C "$root" rev-parse HEAD)" "$model" > "$out/kit.json"
printf '{"title": "centraid-assist-eval-input", "id": "%s/centraid-assist-eval-input", "licenses": [{"name": "other"}]}\n' "$owner" > "$out/dataset-metadata.json"
echo "model: $which; bundle in $out ($(du -sh "$out" | cut -f1)); push with: kaggle datasets create -p $out"
