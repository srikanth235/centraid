#!/bin/sh
# One batch through `claude -p`.  $1 is the batch file, $2 the output dir.
set -e
DIR=$(dirname "$0")
BATCH="$1"
OUT="$2"
NAME=$(basename "$BATCH" .json)
[ -s "$OUT/$NAME.jsonl" ] && exit 0
{
  sed 's/REQUESTED_COUNT/9/g' "$DIR/PROMPT.md"
  echo
  cat "$BATCH"
} > "$OUT/$NAME.prompt"
/opt/node22/bin/claude -p "$(cat "$OUT/$NAME.prompt")" \
  --output-format json --max-turns 1 > "$OUT/$NAME.raw" 2>"$OUT/$NAME.err" || true
python3 - "$OUT/$NAME.raw" "$OUT/$NAME.jsonl" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1]))
text = raw.get("result", "")
with open(sys.argv[2], "w") as out:
    for line in text.splitlines():
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
[ -s "$OUT/$NAME.jsonl" ] || { rm -f "$OUT/$NAME.jsonl"; exit 1; }
