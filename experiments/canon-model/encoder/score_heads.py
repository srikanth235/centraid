"""Per-head accuracy and TREE-equality exact match for an encoder output file.

    ../.venv/bin/python score_heads.py ../out/encoder-minilm.free.jsonl

`score_outputs.py` gives parse rate and STRING exact-match against gold.  This
adds (a) tree-equality exact match, which does not punish a paren style, and
(b) the per-head accuracies that say WHICH decision was wrong.  Gold labels
come from `map.json`'s canonical, which is never used for training.
"""
from __future__ import annotations

import collections
import json
import os
import sys

from canon_decomp import GRAMMAR
import check
from task import label_of


def main():
    path = sys.argv[1]
    gold = {(r["corpus"], r["session"], r["turn"]): r["canonical"]
            for r in json.load(open(os.path.join(GRAMMAR, "map.json"),
                                    encoding="utf-8"))["turns"]}
    per = collections.defaultdict(lambda: [0, 0])   # head -> [ok, total]
    tree = collections.Counter()
    n = collections.Counter()
    lit_ok = lit_tot = 0
    ab_ok = ab_tot = ab_false = 0
    wrong = []

    def is_abstain(t):
        # Both spellings: the fixed one (`refuse: <REASON#0>`) and the one the
        # round-2 checkpoint was trained with (`<ARG#0>: <REASON#0>`).
        return (t == "nothing" or t.startswith(("refuse:", "clarify:"))
                or t == "<ARG#0>: <REASON#0>")
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        key = (row["corpus"], row["session"], row["turn"])
        g = gold[key]
        n[row["corpus"]] += 1
        out = row["canonical"].strip()
        try:
            if check.parse(out) == check.parse(g):
                tree[row["corpus"]] += 1
            else:
                wrong.append((key, row["request"], out, g))
        except Exception:
            wrong.append((key, row["request"], out, g))
        try:
            gl = label_of(g)
        except Exception:
            continue
        heads = row.get("heads")
        if not heads:
            continue
        got_t = heads["template"]
        if got_t == "<ARG#0>: <REASON#0>":
            got_t = "%s: <REASON#0>" % heads["closed"].get("ARG0", "?")
        if is_abstain(gl.template):
            ab_tot += 1
            ab_ok += int(got_t == gl.template)
        elif is_abstain(got_t):
            ab_false += 1
        per["template"][1] += 1
        per["template"][0] += int(got_t == gl.template)
        for slot, value in gl.closed.items():
            per[slot[:-1]][1] += 1
            per[slot[:-1]][0] += int(heads["closed"].get(slot) == value)
        for slot, value in gl.lits.items():
            lit_tot += 1
            lit_ok += int(heads["lits"].get(slot, "").strip().lower()
                          == value.strip().lower())
    print("%-10s %6s %14s" % ("corpus", "turns", "tree-exact"))
    tt = tn = 0
    for corpus in ("suite", "blind", "holdout"):
        tt += tree[corpus]
        tn += n[corpus]
        print("%-10s %6d %6d %5.1f%%"
              % (corpus, n[corpus], tree[corpus],
                 100.0 * tree[corpus] / max(1, n[corpus])))
    print("%-10s %6d %6d %5.1f%%" % ("ALL", tn, tt, 100.0 * tt / max(1, tn)))
    print("\nper-head accuracy on the 434 corpus turns")
    for head, (ok, tot) in sorted(per.items()):
        print("  %-10s %5d/%-5d %5.1f%%" % (head, ok, tot, 100.0 * ok / max(1, tot)))
    print("  %-10s %5d/%-5d %5.1f%%  (LIT span exact, case-insensitive)"
          % ("LIT-span", lit_ok, lit_tot, 100.0 * lit_ok / max(1, lit_tot)))
    print("  %-10s %5d/%-5d %5.1f%%  (abstention: refuse/clarify/nothing; "
          "%d false abstentions)"
          % ("abstain", ab_ok, ab_tot, 100.0 * ab_ok / max(1, ab_tot), ab_false))
    print("\nsample wrong outputs")
    for key, req, out, g in wrong[:8]:
        print("  %s %r\n    got  %s\n    gold %s" % (key, req, out, g))


if __name__ == "__main__":
    main()
