# -*- coding: utf-8 -*-
"""Delete every row that shares a four-word run with an eval corpus turn the
BASELINE corpus does not already share.

Same rule as `strip_leaks.py`, one measure along: the set of 4-grams
`distill.jsonl` has in common with `suite.json`/`blind.json` is forced to be a
SUBSET of the set `train.jsonl` already has in common with them, so the
reported collision rate cannot come out above the baseline's.

This script reads the eval corpora, prints nothing from them and writes no new
text: it only DELETES rows.  Nothing it reads reaches the generator, and no
sentence of either corpus is printed.

    python3 strip_grams.py <suite.json> <blind.json> <baseline.jsonl> <jsonl>...
"""
import json
import os
import re
import sys


def words(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).split()


def grams(text):
    parts = words(text)
    return {" ".join(parts[i:i + 4]) for i in range(len(parts) - 3)}


def corpus_grams(paths):
    found = set()
    for path in paths:
        blob = json.load(open(path))
        for session in blob.get("sessions", ()):
            for turn in session.get("turns", ()):
                if isinstance(turn.get("request"), str):
                    found |= grams(turn["request"])
    return found


def file_grams(path):
    found = set()
    for line in open(path):
        row = json.loads(line)
        found |= grams(row["input"].split(" ||| ", 1)[1])
    return found


def main():
    evals = corpus_grams(sys.argv[1:3])
    allowed = file_grams(sys.argv[3]) & evals       # what the baseline already shares
    banned = evals - allowed
    total = 0
    for path in sys.argv[4:]:
        kept, dropped = [], 0
        for line in open(path):
            row = json.loads(line)
            if grams(row["input"].split(" ||| ", 1)[1]) & banned:
                dropped += 1
                continue
            kept.append(line)
        with open(path + ".tmp", "w") as out:
            out.writelines(kept)
        os.replace(path + ".tmp", path)
        total += dropped
        print("  4-gram strip: %s lost %d row(s)"
              % (os.path.basename(path), dropped))
    print("  4-gram strip: %d eval 4-gram(s), %d already shared by the baseline"
          % (len(evals), len(allowed)))


if __name__ == "__main__":
    main()
