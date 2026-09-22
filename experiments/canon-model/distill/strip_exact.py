# -*- coding: utf-8 -*-
"""Delete every row whose request collides EXACTLY with an eval corpus turn.

The colliding sentences come from `overlap-check`'s report and are never
printed.  This script only DELETES rows.

    python3 strip_exact.py <report.txt> <jsonl> [<jsonl>...]
"""
import json
import os
import re
import sys


def fold(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def main():
    bad, grab = set(), False
    for line in open(sys.argv[1]):
        if "exact request collisions" in line:
            grab = True
            continue
        if grab:
            found = re.match(r"\s+\S+ \"(.*)\"\s*$", line.rstrip("\n"))
            if found:
                bad.add(fold(found.group(1)))
            else:
                grab = False
    if not bad:
        print("  exact strip: no collisions")
        return
    for path in sys.argv[2:]:
        kept, dropped = [], 0
        for line in open(path):
            row = json.loads(line)
            if fold(row["input"].split(" ||| ", 1)[1]) in bad:
                dropped += 1
                continue
            kept.append(line)
        with open(path + ".tmp", "w") as out:
            out.writelines(kept)
        os.replace(path + ".tmp", path)
        print("  exact strip: %s lost %d row(s) over %d sentence form(s)"
              % (os.path.basename(path), dropped, len(bad)))


if __name__ == "__main__":
    main()
