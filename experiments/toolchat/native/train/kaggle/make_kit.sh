#!/usr/bin/env bash
# Build the input dataset of the M6 Kaggle kernel: the repository at HEAD and params.json. Writes files only; it never calls `kaggle`.
#
#   experiments/toolchat/native/train/kaggle/make_kit.sh OUT_DIR KAGGLE_OWNER ARM DATA_FOLDER [KEY=VALUE ...]
#
#   ARM          A | B | C
#   DATA_FOLDER  the data version's folder in the private HF dataset srikanth235/centraid-native-data, e.g. datagen/v1
#   KEY=VALUE    any other params.json key (kernel.py lists them): epochs=3 mark=best s2_baseline=true hf_revision=abc123 ...
#
# Nothing secret goes in: the kernel reads the Kaggle secret HF_TOKEN. Commit first: the kernel builds HEAD.
set -euo pipefail
usage="usage: make_kit.sh OUT_DIR KAGGLE_OWNER A|B|C DATA_FOLDER [KEY=VALUE ...]"
out=${1:?$usage}
owner=${2:?$usage}
arm=${3:?$usage}
folder=${4:?$usage}
shift 4
case $arm in A | B | C) ;; *) echo "$usage" >&2; exit 1 ;; esac
root=$(git rev-parse --show-toplevel)
git -C "$root" diff --quiet HEAD || { echo "uncommitted changes: the kernel builds HEAD, so commit first" >&2; exit 1; }
mkdir -p "$out"
git -C "$root" archive --format=tar.gz -o "$out/src.tar.gz" HEAD
commit=$(git -C "$root" rev-parse HEAD)
python3 -c '
import json, sys
path, arm, folder, commit, *pairs = sys.argv[1:]
params = {"arm": arm, "data_folder": folder, "commit": commit}
for pair in pairs:
    key, _, value = pair.partition("=")
    try:
        value = json.loads(value)
    except ValueError:
        pass
    params[key] = value
json.dump(params, open(path, "w"), indent=1)
' "$out/params.json" "$arm" "$folder" "$commit" "$@"
printf '{"title": "centraid-m6-src", "id": "%s/centraid-m6-src", "licenses": [{"name": "other"}]}\n' "$owner" > "$out/dataset-metadata.json"
echo "kit for arm $arm in $out ($(du -sh "$out" | cut -f1)). Pushing it is the owner's step: see README.md"
