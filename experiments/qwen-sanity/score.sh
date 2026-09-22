#!/bin/sh
# Render one arm's raw model output to canonical and score it with the
# repository's own executor, exactly as `experiments/afm-spike/Makefile` does.
#
#   ./score.sh out/qwen2b-zero            # reads out/qwen2b-zero-<corpus>.jsonl
#
# Nothing here repairs a model output: `render_frames.py` writes an empty
# canonical and a reason for anything it cannot build, and `run-model` scores
# the empty canonical as the failure it is.
set -eu
# absolute, because the `run-model` step runs from the repository root
PREFIX=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

for corpus in suite blind holdout; do
    raw="$PREFIX-$corpus.jsonl"
    [ -f "$raw" ] || continue
    python3 "$HERE/../afm-spike/render_frames.py" --in "$raw" \
        --out "$PREFIX-$corpus.rendered.jsonl"
done

# one scored file for `run-model --corpus all`
cat "$PREFIX"-suite.rendered.jsonl "$PREFIX"-blind.rendered.jsonl \
    "$PREFIX"-holdout.rendered.jsonl > "$PREFIX-scored.jsonl"

cd "$REPO"
rel=$(python3 -c "import os,sys;print(os.path.relpath(sys.argv[1], sys.argv[2]))" \
      "$PREFIX-scored.jsonl" "$REPO")
exec cargo run --release -q -p centraid-candidates --bin run-model -- \
    --corpus all --outputs "$rel"
