#!/usr/bin/env bash
# Checks over a finished build: traces, loss masks, dedup, length (one pass) + runtime replay in 3 shards.
# usage: data/run_checks.sh DATA_DIR PYTHON
set -euo pipefail
D=$1; PY=$2
cd "$(dirname "$0")"
"$PY" checks.py "$D" --files 'train.jsonl.gz,val.jsonl.gz' --loss-sample 500 --replay-worlds 0 --report checks.json 2>"$D/checks-main.log" &
for i in 0 1 2; do
  "$PY" checks.py "$D" --replay-only --shard "$i/3" --report "replay-$i.json" 2>"$D/replay-$i.log" &
done
wait
"$PY" coverage.py "$D" --glob 'train.jsonl.gz' > "$D/coverage-train.md"
"$PY" coverage.py "$D" --glob 'val.jsonl.gz' > "$D/coverage-val.md"
