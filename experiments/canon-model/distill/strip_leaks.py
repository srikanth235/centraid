# -*- coding: utf-8 -*-
"""Strip rows that leak a proper noun the BASELINE corpus does not already
leak, so `distill.jsonl` is never worse than `train.jsonl` on that measure.

The leaked names come from `overlap-check`'s own report and are never printed:
the eval world's cast must not reach a person who writes training data, let
alone a generator.  This script only DELETES rows.

    python3 strip_leaks.py <report.txt> <baseline-report.txt> <jsonl> [<jsonl>...]
"""
import json
import os
import re
import sys


def leaks(path):
    found, grab = set(), False
    for line in open(path):
        if "proper-noun leaks:" in line:
            grab = True
            continue
        if grab:
            if line.startswith("    ") and "==" not in line:
                found.update(word.strip().lower()
                             for word in line.strip().split(",") if word.strip())
            else:
                grab = False
    return found


def main():
    report, baseline = sys.argv[1], sys.argv[2]
    extra = leaks(report) - leaks(baseline)
    if not extra:
        print("  proper-noun strip: nothing above the baseline")
        return
    pattern = re.compile(r"\b(%s)\b" % "|".join(re.escape(w) for w in extra),
                         re.IGNORECASE)
    for path in sys.argv[3:]:
        kept, dropped = [], 0
        for line in open(path):
            row = json.loads(line)
            if pattern.search(row["input"].split(" ||| ", 1)[1]):
                dropped += 1
                continue
            kept.append(line)
        with open(path + ".tmp", "w") as out:
            out.writelines(kept)
        os.replace(path + ".tmp", path)
        print("  proper-noun strip: %s lost %d row(s) over %d name(s)"
              % (os.path.basename(path), dropped, len(extra)))


if __name__ == "__main__":
    main()
