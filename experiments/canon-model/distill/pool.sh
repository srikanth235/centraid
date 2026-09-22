#!/bin/sh
# A CLAIM-BASED worker pool over the batch queue: `mkdir` is the atomic claim,
# so any number of pools may run at once and no batch is generated twice.
DIR=$(dirname "$0")
OUT="$DIR/out"
CLAIM="$OUT/claims"
mkdir -p "$CLAIM"
W=${W:-12}
i=0
while [ "$i" -lt "$W" ]; do
  i=$((i + 1))
  (
   while :; do
    left=0
    for batch in "$DIR"/batches/*.json; do
      NAME=$(basename "$batch" .json)
      [ -s "$OUT/$NAME.jsonl" ] && continue
      mkdir "$CLAIM/$NAME" 2>/dev/null || continue
      echo "[$(date +%H:%M:%S)] w$i $NAME"
      "$DIR/run_batch.sh" "$batch" "$OUT" || { echo "FAILED $NAME"; rmdir "$CLAIM/$NAME"; }
      left=$((left + 1))
    done
    [ "$left" -gt 0 ] || break
   done
   echo "[$(date +%H:%M:%S)] w$i done"
  ) >> "$OUT/pool$i.log" 2>&1 &
done
wait
