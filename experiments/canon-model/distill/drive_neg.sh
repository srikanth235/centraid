#!/bin/sh
# Two workers over the NEGATIVE batch queue (the four refusals and `nothing`).
DIR=$(dirname "$0")
OUT="$DIR/neg_out"
mkdir -p "$OUT"
W=${W:-2}
i=0
ls "$DIR"/neg_batches/*.json > "$OUT/queue.txt"
while [ "$i" -lt "$W" ]; do
  i=$((i + 1))
  (
    n=0
    while read -r batch; do
      n=$((n + 1))
      [ $((n % W)) -eq $((i % W)) ] || continue
      NAME=$(basename "$batch" .json)
      [ -s "$OUT/$NAME.jsonl" ] && continue
      echo "[$(date +%H:%M:%S)] w$i $batch"
      {
        sed 's/REQUESTED_COUNT/12/g' "$DIR/NEG_PROMPT.md"
        echo
        cat "$batch"
      } > "$OUT/$NAME.prompt"
      /opt/node22/bin/claude -p "$(cat "$OUT/$NAME.prompt")" \
        --output-format json --max-turns 1 > "$OUT/$NAME.raw" 2>"$OUT/$NAME.err"
      python3 - "$OUT/$NAME.raw" "$OUT/$NAME.jsonl" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1]))
with open(sys.argv[2], "w") as out:
    for line in raw.get("result", "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict) and "id" in row and "u" in row:
            out.write(json.dumps(row) + "\n")
PY
      rm -f "$OUT/$NAME.prompt"
    done < "$OUT/queue.txt"
    echo "[$(date +%H:%M:%S)] w$i done"
  ) >> "$OUT/worker$i.log" 2>&1 &
done
wait
