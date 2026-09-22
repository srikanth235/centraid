#!/usr/bin/env python3
"""Score parser output against map.json's canonicals, using the GRAMMAR's own
parser as the authority.

`grammar/check.py` is the parser that GENERATED every tree in map.json, so it
is the only thing entitled to say whether a canonical is legal and whether two
canonicals mean the same. This bridge imports it rather than re-implementing
it: a second implementation would agree with itself and not with the grammar.

stdin : {"rows": [{"id", "corpus", "category", "register", "gold", "mine"}]}
stdout: {"rows": [{"id", ..., "verdict"}]}   verdict in
        exact | skeleton | wrong | illegal | unparsed | skipped
"""

import json
import os
import sys

GRAMMAR = sys.argv[1]
sys.path.insert(0, GRAMMAR)
os.chdir(GRAMMAR)
import check  # noqa: E402


def tree_of(text):
    try:
        return check.parse(text)
    except Exception:
        return None


def main():
    payload = json.load(sys.stdin)
    out = []
    for row in payload["rows"]:
        gold, mine = row.get("gold") or "", row.get("mine")
        verdict = "skipped"
        if gold.strip():
            gold_tree = tree_of(gold)
            if mine is None:
                verdict = "unparsed"
            else:
                mine_tree = tree_of(mine)
                if mine_tree is None:
                    verdict = "illegal"
                elif gold_tree is not None and mine_tree == gold_tree:
                    verdict = "exact"
                elif gold_tree is not None and \
                        check.skeleton(mine_tree) == check.skeleton(gold_tree):
                    verdict = "skeleton"
                else:
                    verdict = "wrong"
        row = dict(row)
        row["verdict"] = verdict
        out.append(row)
    json.dump({"rows": out}, sys.stdout)


if __name__ == "__main__":
    main()
