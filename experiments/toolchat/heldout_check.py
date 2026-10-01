"""Decode a held-out set and score it by parsed TREE per construct.

    python heldout_check.py --ckpt D --data v3/heldout_v3.jsonl [--n N] --out F

Not string matching: both lines go through check.py, and two spellings of one
tree (parens, spaces) are one tree. Not executor outcome either: the held-out
literals name an invented world the vault does not hold, so both lines would
resolve to nothing and agree trivially. The per-construct table attributes each
miss to the constructs the gold tree contains, so the number to watch is the
accuracy of each construct, and the literal / date rows say whether copying
or arithmetic is what failed.
"""
import argparse, collections, datetime, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "crates", "evalsuite", "grammar"))
import check

def constructs(t, out=None):
    """The multiset of construct labels a tree carries."""
    out = out if out is not None else collections.Counter()
    if isinstance(t, dict):
        n = t.get("node")
        if n:
            lab = n
            for k in ("agg", "how", "ref", "verb", "op", "kind", "window", "reason"):
                v = t.get(k)
                if isinstance(v, str): lab += ":" + v
            if n == "lit": lab = "lit:" + t["type"]
            if n == "window": lab = "window:" + t["how"] + (":" + t["value"] if t["how"] == "phrase" else "")
            out[lab] += 1
            if n == "cmd":
                for a in t.get("args", {}): out["arg:" + a] += 1
        for v in t.values(): constructs(v, out)
    elif isinstance(t, list):
        for v in t: constructs(v, out)
    return out

def strip_lits(t):
    if isinstance(t, dict):
        return {k: ("_" if k in ("value", "lit") and isinstance(v, str) else strip_lits(v))
                for k, v in t.items()}
    if isinstance(t, list): return [strip_lits(v) for v in t]
    return t

def lits(t, out=None):
    out = out if out is not None else []
    if isinstance(t, dict):
        if t.get("node") == "lit": out.append((t["type"], t["value"]))
        if t.get("node") == "called": out.append(("called", t["lit"]))
        for v in t.values(): lits(v, out)
    elif isinstance(t, list):
        for v in t: lits(v, out)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True); ap.add_argument("--data", required=True)
    ap.add_argument("--n", type=int, default=0); ap.add_argument("--out")
    a = ap.parse_args()
    import ft_granite as F
    dec = F.Decoder(a.ckpt)
    data = F.rows(a.data, a.n or None, 1)
    per = collections.defaultdict(lambda: [0, 0]); kinds = collections.Counter()
    rec = []
    for prev, req, tgt, fixed in data:
        today = datetime.date.fromisoformat(fixed)
        raw, canon, valid = dec(today, prev, req)
        gt = check.parse(tgt)
        try: mt = check.parse(canon) if canon else None
        except check.ParseError: mt = None
        if mt is None: verdict = "invalid"
        elif mt == gt: verdict = "exact"
        elif strip_lits(mt) == strip_lits(gt):
            gl, ml = lits(gt), lits(mt)
            verdict = "date wrong" if any(x[0] in ("date", "datetime") and x != y for x, y in zip(gl, ml)) else "literal wrong"
        else: verdict = "structure wrong"
        kinds[verdict] += 1
        for c in constructs(gt):
            per[c][1] += 1; per[c][0] += verdict == "exact"
        rec.append({"prev": prev, "request": req, "today": fixed, "gold": tgt, "raw": raw, "verdict": verdict})
    n = len(data)
    print("held-out rows %d" % n)
    for k, v in kinds.most_common(): print("  %-16s %4d  %5.1f%%" % (k, v, 100 * v / n))
    print("\nper construct (exact-tree accuracy, rows with the construct), worst first")
    for c, (ok, tot) in sorted(per.items(), key=lambda x: (x[1][0] / x[1][1], -x[1][1])):
        if tot >= 5: print("  %-34s %3d/%-3d %5.1f%%" % (c, ok, tot, 100 * ok / tot))
    if a.out:
        with open(a.out, "w") as fh:
            for r in rec: fh.write(json.dumps(r) + "\n")

if __name__ == "__main__":
    main()
