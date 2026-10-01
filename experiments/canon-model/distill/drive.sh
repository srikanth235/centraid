#!/bin/sh
# Six workers over the batch queue.  Each batch is one `claude -p` call; a
# batch whose .jsonl already exists is skipped, so this is resumable.
DIR=$(dirname "$0")
OUT="$DIR/out"
mkdir -p "$OUT"
W=${W:-6}
i=0
for f in "$DIR"/batches/*.json; do
  echo "$f"
done > "$OUT/queue.txt"
while [ "$i" -lt "$W" ]; do
  i=$((i + 1))
  (
    n=0
    while read -r batch; do
      n=$((n + 1))
      [ $((n % W)) -eq $((i % W)) ] || continue
      echo "[$(date +%H:%M:%S)] w$i $batch"
      "$DIR/run_batch.sh" "$batch" "$OUT" || echo "[$(date +%H:%M:%S)] w$i FAILED $batch"
    done < "$OUT/queue.txt"
    echo "[$(date +%H:%M:%S)] w$i done"
  ) >> "$OUT/worker$i.log" 2>&1 &
done
wait
