"""Template/fill coverage of train.jsonl against val and the 434 gold turns."""
from __future__ import annotations
import collections, json, os, sys
from canon_decomp import decompose as _d, GRAMMAR, HERE
from render import normalise
def decompose(c): return _d(normalise(c))

DATA = os.path.normpath(os.path.join(HERE, "..", "data"))


def jl(p, ki, kt):
    out = []
    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if r[kt] == "Unparsed":
            continue
        out.append((r[ki], r[kt]))
    return out


def gold_pairs():
    rows = json.load(open(os.path.join(GRAMMAR, "map.json"), encoding="utf-8"))["turns"]
    rows.sort(key=lambda r: (r["corpus"], r["session"], r["turn"]))
    prev = {}
    out = []
    for r in rows:
        k = (r["corpus"], r["session"])
        p = "NONE" if r["turn"] == 0 else (prev.get(k) or "NONE")
        out.append(("%s ||| %s" % (p, r["request"]), r["canonical"]))
        prev[k] = r["canonical"]
    return out


tr = jl(os.path.join(DATA, "train.jsonl"), "input", "target")
va = jl(os.path.join(DATA, "val.jsonl"), "input", "target")
go = gold_pairs()

tmpl = collections.Counter()
fills = collections.defaultdict(collections.Counter)
for _, c in tr:
    d = decompose(c)
    tmpl[d.template] += 1
    for h in d.holes:
        fills["%s%d" % (h.type, h.index)][h.value] += 1

tot = sum(tmpl.values())
cum = 0
for i, (_, n) in enumerate(tmpl.most_common(), 1):
    cum += n
    if cum >= 0.95 * tot:
        print("train: %d templates; %d cover 95%% of %d rows" % (len(tmpl), i, tot))
        break

for name, rows in (("val", va), ("gold", go)):
    seen = miss = 0
    lit_in = lit_tot = 0
    missing = collections.Counter()
    for inp, c in rows:
        d = decompose(c)
        if d.template in tmpl:
            seen += 1
        else:
            miss += 1
            missing[d.template] += 1
        low = inp.lower()
        for h in d.holes:
            if h.type in ("LIT", "DATE", "NUM", "DUR"):
                lit_tot += 1
                v = h.value[1:-1] if h.type == "LIT" else h.value
                if v.lower() in low:
                    lit_in += 1
    print("%-5s n=%d  template seen-in-train %d (%.1f%%)  unseen %d  |  copied spans present in input %d/%d (%.1f%%)"
          % (name, len(rows), seen, 100.0 * seen / len(rows), miss,
             lit_in, lit_tot, 100.0 * lit_in / max(1, lit_tot)))
    if name == "gold":
        print("  top unseen gold templates:")
        for t, n in missing.most_common(10):
            print("    %2d  %s" % (n, t))
