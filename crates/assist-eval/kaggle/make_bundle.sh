#!/usr/bin/env bash
# Build the input dataset of the Kaggle SCORING kernel. It holds the source at HEAD, kit.json and (optionally) an adapter;
# no held-out data and no token (the kernel reads the data version itself, with a Kaggle secret HF_TOKEN).
#
#   crates/assist-eval/kaggle/make_bundle.sh OUT_DIR KAGGLE_OWNER --tag vX.Y --val-blake3 HASH \
#       [--adapter FILE | --adapter-url URL --adapter-sha256 HASH] [--grammar off|handles|full] [--tools sig|s2|...]
#
# - The base model is the stock GGUF pinned in crates/assist/model.json (url and sha256): never a choice here.
# - `--tag` is the data version's tag in the private dataset `srikanth235/centraid-assist-data`, and `--val-blake3` the hash of
#   `data/val.jsonl.zst` that tag's manifest.json records (`jq '.files["data/val.jsonl.zst"].blake3' manifest.json`). The
#   kernel refuses a manifest or a file that does not carry it.
# - No `--adapter*` flag is the baseline: the stock model alone.
# - `--tools` defaults to the model record's tools_mode; `--grammar` is left out unless given, which is the phone's.
set -euo pipefail
usage="usage: make_bundle.sh OUT_DIR KAGGLE_OWNER --tag TAG --val-blake3 HASH [--adapter FILE | --adapter-url URL --adapter-sha256 HASH] [--grammar G] [--tools T]"
out=${1:?$usage}
owner=${2:?$usage}
shift 2
tag="" val="" adapter="" adapter_url="" adapter_sha="" grammar="" tools=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --tag) tag=${2:?$usage}; shift 2 ;;
    --val-blake3) val=${2:?$usage}; shift 2 ;;
    --adapter) adapter=${2:?$usage}; shift 2 ;;
    --adapter-url) adapter_url=${2:?$usage}; shift 2 ;;
    --adapter-sha256) adapter_sha=${2:?$usage}; shift 2 ;;
    --grammar) grammar=${2:?$usage}; shift 2 ;;
    --tools) tools=${2:?$usage}; shift 2 ;;
    *) echo "$usage" >&2; exit 1 ;;
  esac
done
[[ -n $tag && -n $val ]] || { echo "$usage" >&2; exit 1; }
[[ -z $adapter || -z $adapter_url ]] || { echo "--adapter and --adapter-url are two ways to say one thing" >&2; exit 1; }
[[ -z $adapter_url || -n $adapter_sha ]] || { echo "--adapter-url needs --adapter-sha256" >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
git -C "$root" diff --quiet HEAD || { echo "uncommitted changes: the kernel builds HEAD, so commit first" >&2; exit 1; }
mkdir -p "$out"
git -C "$root" archive --format=tar.gz -o "$out/src.tar.gz" HEAD
sha_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
adapter_json=null
if [[ -n $adapter ]]; then
  cp "$adapter" "$out/adapter.gguf"
  adapter_json="{\"input\": \"adapter.gguf\", \"sha256\": \"$(sha_of "$out/adapter.gguf")\"}"
elif [[ -n $adapter_url ]]; then
  adapter_json="{\"url\": \"$adapter_url\", \"sha256\": \"$adapter_sha\"}"
fi
COMMIT=$(git -C "$root" rev-parse HEAD) TAG=$tag VAL=$val ADAPTER=$adapter_json GRAMMAR=$grammar TOOLS=$tools \
  MODEL_JSON="$root/crates/assist/model.json" python3 - "$out/kit.json" <<'PY'
import json, os, sys
current = json.load(open(os.environ["MODEL_JSON"]))["current"]
kit = {
    "commit": os.environ["COMMIT"],
    "model": {"url": current["url"], "sha256": current["sha256"]},
    "adapter": json.loads(os.environ["ADAPTER"]),
    "data": {"repo": "srikanth235/centraid-assist-data", "tag": os.environ["TAG"], "split": "val", "blake3": os.environ["VAL"]},
    "tools": os.environ["TOOLS"] or current["tools_mode"],
    "shards": 2,
}
if os.environ["GRAMMAR"]:
    kit["grammar"] = os.environ["GRAMMAR"]
json.dump(kit, open(sys.argv[1], "w"), indent=2)
PY
printf '{"title": "centraid-assist-eval-input", "id": "%s/centraid-assist-eval-input", "licenses": [{"name": "other"}]}\n' "$owner" > "$out/dataset-metadata.json"
echo "kit in $out ($(du -sh "$out" | cut -f1)); the owner pushes it: kaggle datasets create -p $out"
