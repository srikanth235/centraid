"""Write a stratified hand-read sample of sessions (markdown) for review.

usage: python handread.py DATA.jsonl.gz OUT.md [--n 50]
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import random

from show import show


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=50)
    a = ap.parse_args()
    ex = [json.loads(l) for f in a.data for l in gzip.open(f, "rt")]
    rng = random.Random(2026)
    by = collections.defaultdict(list)
    for e in ex:
        for p in {t["pattern"] for t in e["turns"]} - {"first"}:
            by[p].append(e)
    pick, seen = [], set()
    for p, es in sorted(by.items()):          # every conversation pattern at least twice
        for e in rng.sample(es, min(2, len(es))):
            if e["id"] not in seen:
                pick.append(e)
                seen.add(e["id"])
    rest = [e for e in ex if e["id"] not in seen]
    pick += rng.sample(rest, a.n - len(pick))
    rng.shuffle(pick)
    with open(a.out, "w") as f:
        f.write(f"# Hand-read sample: {len(pick)} sessions (every conversation pattern at least twice)\n\n")
        for i, e in enumerate(pick):
            f.write(f"## {i + 1}\n\n" + show(e) + "\n\n---\n\n")
    print(collections.Counter(p for e in pick for p in {t["pattern"] for t in e["turns"]}))


if __name__ == "__main__":
    main()
