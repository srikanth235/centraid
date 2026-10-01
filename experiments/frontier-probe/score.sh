#!/bin/sh
# `experiments/qwen-sanity/score.sh`, with ONE substitution: the render step
# runs through `render_guard.py`, which is `render_frames.py` plus a crash
# guard that can only turn a renderer CRASH into the EMPTY canonical the row
# already deserved (see render_guard.py).  The scorer itself -- the
# repository's own `run-model` -- is untouched.
#
#   ./score.sh out/raw            # reads out/raw-<corpus>.jsonl
set -eu
PREFIX=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

for corpus in suite blind holdout; do
    raw="$PREFIX-$corpus.jsonl"
    [ -f "$raw" ] || continue
    python3 "$HERE/render_guard.py" --in "$raw" \
        --out "$PREFIX-$corpus.rendered.jsonl"
done

# one scored file out of whichever corpora this arm actually ran, exactly as
# `experiments/qwen-sanity/score.sh` does it.  A `--dev` run is suite-only,
# and the old unconditional three-way `cat` aborted the whole script under
# `set -eu` before the executor was ever reached.
: > "$PREFIX-scored.jsonl"
WHICH=""
for corpus in suite blind holdout; do
    [ -f "$PREFIX-$corpus.rendered.jsonl" ] || continue
    cat "$PREFIX-$corpus.rendered.jsonl" >> "$PREFIX-scored.jsonl"
    WHICH="${WHICH:+$WHICH,}$corpus"
done
[ "$WHICH" = "suite,blind,holdout" ] && WHICH="all"

cd "$REPO"
rel=$(python3 -c "import os,sys;print(os.path.relpath(sys.argv[1], sys.argv[2]))" \
      "$PREFIX-scored.jsonl" "$REPO")
exec cargo run --release -q -p centraid-candidates --bin run-model -- \
    --corpus "$WHICH" --outputs "$rel"
