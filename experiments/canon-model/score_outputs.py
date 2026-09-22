"""Parse rate + exact-match for a model-output JSONL, per corpus.

    ./.venv/bin/python score_outputs.py out/flan-t5-small.free.jsonl

Parsing is done by `crates/evalsuite/grammar/check.py` itself — the parser
that decides whether a string is legal canonical.  A malformed or empty
generation is a FAILURE and is counted as one; nothing is patched.

Exact-match is against the gold canonical in `grammar/map.json` and is a
LEAKAGE DETECTOR, not a quality score.
"""

from __future__ import annotations

import collections
import json
import sys

import canon_grammar as G  # puts grammar/ on sys.path  # noqa: F401
import check

from infer import MAP


def main():
    path = sys.argv[1]
    gold = {(r["corpus"], r["session"], r["turn"]): r["canonical"]
            for r in json.load(open(MAP, encoding="utf-8"))["turns"]}
    stat = collections.defaultdict(lambda: [0, 0, 0, 0])  # n, parse, exact, empty
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        cell = stat[row["corpus"]]
        cell[0] += 1
        out = row["canonical"].strip()
        if not out:
            cell[3] += 1
        try:
            check.parse(out)
            cell[1] += 1
        except Exception:
            pass
        if out == gold[(row["corpus"], row["session"], row["turn"])].strip():
            cell[2] += 1
    print("%-10s %6s %10s %12s %7s" % ("corpus", "turns", "parse", "exact", "empty"))
    tot = [0, 0, 0, 0]
    for corpus in ("suite", "blind", "holdout"):
        n, p, e, z = stat[corpus]
        for i, v in enumerate((n, p, e, z)):
            tot[i] += v
        print("%-10s %6d %5d %4.1f%% %6d %4.1f%% %7d"
              % (corpus, n, p, 100.0 * p / max(1, n), e, 100.0 * e / max(1, n), z))
    n, p, e, z = tot
    print("%-10s %6d %5d %4.1f%% %6d %4.1f%% %7d"
          % ("ALL", n, p, 100.0 * p / max(1, n), e, 100.0 * e / max(1, n), z))


if __name__ == "__main__":
    main()
