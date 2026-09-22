#!/usr/bin/env bash
# Decode + score one checkpoint across the 2x2 of {greedy, masked} x {teacher, free}.
#   ./sweep.sh <tag> <checkpoint-dir>
# Writes out/<tag>.<decode>.<mode>.jsonl, logs/score-<tag>.<decode>.<mode>.txt
# and logs/harness-<tag>.<decode>.<mode>.txt.  Nothing repairs a generation.
set -x
cd "$(dirname "$0")" || exit 1
export HF_HOME=$PWD/hf OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OMP_WAIT_POLICY=PASSIVE KMP_BLOCKTIME=0
TAG=$1
CKPT=$2
PY=./.venv/bin/python

for MODE in teacher free; do
  $PY -u infer.py --model "$CKPT" --mode "$MODE" \
      --out "out/$TAG.greedy.$MODE.jsonl" --threads 2 \
      > "logs/infer-$TAG.greedy.$MODE.log" 2>&1
  $PY -u infer_masked.py --model "$CKPT" --mode "$MODE" \
      --out "out/$TAG.masked.$MODE.jsonl" --threads 2 \
      > "logs/infer-$TAG.masked.$MODE.log" 2>&1
done

for DEC in greedy masked; do
  for MODE in teacher free; do
    $PY score_outputs.py "out/$TAG.$DEC.$MODE.jsonl" \
        > "logs/score-$TAG.$DEC.$MODE.txt" 2>&1
  done
done
echo "SWEEP-DECODE-DONE $TAG"
