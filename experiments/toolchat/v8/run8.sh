#!/bin/sh
# one batch -> Opus -> raw8/<batch>.jsonl, one {"id","v":[[...],[...]]} line per session.
#   cd experiments/toolchat/v8 && ls batches8/*.json | xargs -P 4 -n 1 sh run8.sh
# (from experiments/toolchat: ls v8/batches8/*.json | xargs -P 4 -n 1 sh v8/run8.sh)
# The raw reply is kept (raw8/<batch>.raw); a batch with a non-empty .jsonl is skipped,
# so a rerun only retries the failures. Sessions missing from a reply are listed in
# raw8/missing.log. RAW8=<dir> writes elsewhere (a development slice).
B=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")" || exit 1
N=$(basename "$B" .json)
R=${RAW8:-raw8}
mkdir -p "$R"
[ -s "$R/$N.jsonl" ] && exit 0
echo "$(date -u +%FT%TZ) $N" >> "$R/calls.log"
claude -p "$(cat PROMPT_V8.md; echo; cat "$B")" --model opus --output-format json --max-turns 1 \
    < /dev/null > "$R/$N.raw" 2> "$R/$N.err"
python3 - "$B" "$R/$N.raw" "$R/$N.jsonl" <<'PY'
import json, sys
batch, raw, out = sys.argv[1:]
want = {t["id"]: len(t["turns"]) for t in json.load(open(batch))}
try:
    text = json.load(open(raw)).get("result", "")
except ValueError:
    text = ""
got = {}
for line in text.replace("```json", "").replace("```", "").splitlines():
    line = line.strip().rstrip(",")
    if not line.startswith("{"):
        continue
    try:
        r = json.loads(line)
    except ValueError:
        continue
    if r.get("id") in want and isinstance(r.get("v"), list):
        got[r["id"]] = r
with open(out, "w") as o:
    for r in got.values():
        o.write(json.dumps(r, ensure_ascii=False) + "\n")
miss = [i for i in want if i not in got]
if miss:
    with open(out.rsplit("/", 1)[0] + "/missing.log", "a") as m:
        m.write("%s %s\n" % (batch.rsplit("/", 1)[-1], " ".join(miss)))
print("%s: %d/%d sessions" % (out, len(got), len(want)))
PY
