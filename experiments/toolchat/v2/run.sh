#!/bin/sh
# one batch -> Sonnet -> {"id","u":[...]} lines; raw reply kept
B=$1; N=$(basename $B .json)
[ -s out/$N.jsonl ] && exit 0
claude -p "$(cat PROMPT_V2.md; echo; cat $B)" --model sonnet --output-format json --max-turns 1 > out/$N.raw 2> out/$N.err
python3 - out/$N.raw out/$N.jsonl <<'PY'
import json,sys
t=json.load(open(sys.argv[1])).get("result","")
with open(sys.argv[2],"w") as o:
    for l in t.splitlines():
        l=l.strip()
        if l.startswith("{"):
            try: r=json.loads(l)
            except Exception: continue
            if "id" in r and "u" in r: o.write(json.dumps(r)+"\n")
PY
