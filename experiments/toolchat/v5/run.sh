#!/bin/sh
# one batch -> Sonnet -> {"id","v":[[...],[...]]} lines; raw reply kept (v3/run.sh mechanism)
cd "$(dirname "$0")"
B=$1; N=$(basename $B .json)
mkdir -p raw
[ -s raw/$N.jsonl ] && exit 0
echo "$(date -u +%FT%TZ) $N" >> raw/calls.log
claude -p "$(cat PROMPT_V5.md; echo; cat $B)" --model sonnet --output-format json --max-turns 1 < /dev/null > raw/$N.raw 2> raw/$N.err
python3 - raw/$N.raw raw/$N.jsonl <<'PY'
import json,sys
t=json.load(open(sys.argv[1])).get("result","")
with open(sys.argv[2],"w") as o:
    for l in t.splitlines():
        l=l.strip()
        if l.startswith("{"):
            try: r=json.loads(l)
            except Exception: continue
            if "id" in r and "v" in r: o.write(json.dumps(r)+"\n")
PY
