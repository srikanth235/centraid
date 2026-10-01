#!/bin/sh
# one batch -> Sonnet -> {"id","v":[[...],[...]]} lines; raw reply kept (v5/run6.sh mechanism)
cd "$(dirname "$0")"
B=$1; N=$(basename $B .json)
mkdir -p raw7
[ -s raw7/$N.jsonl ] && exit 0
echo "$(date -u +%FT%TZ) $N" >> raw7/calls.log
claude -p "$(cat PROMPT_V7.md; echo; cat $B)" --model opus --output-format json --max-turns 1 < /dev/null > raw7/$N.raw 2> raw7/$N.err
python3 - raw7/$N.raw raw7/$N.jsonl <<'PY'
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
